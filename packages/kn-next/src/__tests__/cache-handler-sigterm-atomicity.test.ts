import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

// This file asserts IOREDIS-shaped behaviour. Under `bun test` the handler
// would otherwise pick Bun's native client, whose shape differs (`onclose`, no
// `.on`) — the failure then names the client rather than the fact that a
// different one was chosen. Set ONCE at module scope: a per-test pin is one
// `process.env` line away from a case that silently uses the other client.
process.env.KNEXT_CACHE_REDIS_CLIENT = "ioredis";

/**
 * Stands in for `vi.resetModules()`, which bun has no equivalent of: a distinct
 * specifier is a distinct module key, so a bumped query suffix yields a FRESH
 * cache-handler record with its own module-level state.
 *
 * Applied to the cache-handler ONLY. Suffixing a collaborator the handler also
 * imports would give the test a different instance from the one the handler
 * uses, and the failure would describe the behaviour rather than the split.
 */
let __handlerGen = 0;

/**
 * T13 — SIGTERM during ISR revalidation must never leave a TORN write.
 *
 * Under scale-to-zero, SIGTERM-mid-write is not a tail case: it is the common
 * path, and it is *correlated* with the last request before idleness — exactly
 * when revalidation runs. So the ISR write must be all-or-nothing.
 *
 * A cache `set` is not one write. It is the entry PLUS one membership per tag in
 * the tag index that `revalidateTag` reads. Torn state is therefore observable
 * and harmful in both directions:
 *
 *   - entry written, tag index missing → `revalidateTag` cannot find the key, so
 *     the stale entry survives its invalidation until the TTL expires;
 *   - tag index written, entry missing → `revalidateTag` deletes a key that does
 *     not exist and the tag set accumulates dangling members.
 *
 * The seam is deterministic and at the SOCKET, not at the client API: a real
 * RESP server (`helpers/fake-redis.ts`) destroys the connection at a chosen
 * command boundary, standing in for the process dying mid-write. That is the
 * difference between a pipeline (commands applied AS THEY ARRIVE — tearable)
 * and MULTI/EXEC (applied only at EXEC — a partial transmission applies
 * nothing). Removing the atomicity guard from `cache-handler.js` reds these.
 */
describe("T13 — cache-handler set() is atomic across a mid-write death", () => {
    const original = { ...process.env };
    const CACHE_HANDLER: string = "../adapters/cache-handler.js";
    const PREFIX = "atomic-app";
    const KEY = "/isr/page";
    const TAG = "products";

    let fake: FakeRedis | undefined;

    beforeEach(() => {
        __handlerGen += 1;
        process.env.REDIS_KEY_PREFIX = PREFIX;
        spyOn(console, "error").mockImplementation(() => {});
        spyOn(console, "warn").mockImplementation(() => {});
        spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        process.env = { ...original };
        jest.restoreAllMocks();
    });

    /** What the server actually holds for this key + its tag membership. */
    const observed = (
        server: FakeRedis,
    ): { entry: boolean; tagged: boolean } => ({
        entry: server.strings.has(`${PREFIX}:cache:${KEY}`),
        tagged: server.sets.get(`${PREFIX}:tag:${TAG}`)?.has(KEY) === true,
    });

    const newHandler = async (): Promise<{
        set: (k: string, d: unknown, c: unknown) => Promise<void>;
        get: (k: string) => Promise<unknown>;
    }> => {
        const mod = await import(`${CACHE_HANDLER}?gen=${__handlerGen}`);
        return new mod.default({});
    };

    const payload = { kind: "PAGE", rscData: Buffer.from("rsc-bytes") };

    it("commits BOTH the entry and its tag index when nothing interrupts it", async () => {
        // The all-or-nothing assertion below is only meaningful if "all" is
        // reachable. This is the positive half: a guard satisfied by never
        // writing anything would be decoration.
        fake = await startFakeRedis();
        process.env.REDIS_URL = fake.url;

        const handler = await newHandler();
        await handler.set(KEY, payload, { revalidate: 60, tags: [TAG] });

        expect(observed(fake)).toEqual({ entry: true, tagged: true });
    });

    it("death AFTER the entry write and BEFORE the tag write leaves NOTHING partial", async () => {
        // The canonical tear: SIGTERM lands between the two writes of one `set`.
        fake = await startFakeRedis({
            onCommand: (cmd, _args, socket) => {
                if (cmd === "sadd") {
                    // The entry write has already been transmitted; the tag write
                    // has not been applied. Kill the connection here.
                    socket.destroy();
                }
            },
        });
        process.env.REDIS_URL = fake.url;

        const handler = await newHandler();
        await handler.set(KEY, payload, { revalidate: 60, tags: [TAG] });

        const state = observed(fake);
        // Fully written OR absent — never one without the other.
        expect(state.entry).toBe(state.tagged);
        // And in this scenario specifically: absent, because the transaction
        // never reached EXEC.
        expect(state).toEqual({ entry: false, tagged: false });
    });

    it("death at the commit boundary itself leaves NOTHING partial", async () => {
        // The narrowest window: every command transmitted, the commit not.
        fake = await startFakeRedis({
            onCommand: (cmd, _args, socket) => {
                if (cmd === "exec") socket.destroy();
            },
        });
        process.env.REDIS_URL = fake.url;

        const handler = await newHandler();
        await handler.set(KEY, payload, { revalidate: 60, tags: [TAG] });

        const state = observed(fake);
        expect(state.entry).toBe(state.tagged);
        expect(state).toEqual({ entry: false, tagged: false });
    });

    it("is atomic across MULTIPLE tags — no tag is indexed unless all are", async () => {
        // With N tags a pipeline can tear N ways; a transaction cannot tear at all.
        fake = await startFakeRedis({
            onCommand: (cmd, args, socket) => {
                // Kill during the SECOND tag membership.
                if (cmd === "sadd" && args[0] === `${PREFIX}:tag:b`) {
                    socket.destroy();
                }
            },
        });
        process.env.REDIS_URL = fake.url;

        const handler = await newHandler();
        await handler.set(KEY, payload, {
            revalidate: 60,
            tags: ["a", "b", "c"],
        });

        const tagged = ["a", "b", "c"].map(
            (t) => fake?.sets.get(`${PREFIX}:tag:${t}`)?.has(KEY) === true,
        );
        const entry = fake.strings.has(`${PREFIX}:cache:${KEY}`);
        expect(tagged).toEqual([entry, entry, entry]);
        expect(entry).toBe(false);
    });

    it("uses a TRANSACTION, not a pipeline, for the write (multi … exec on the wire)", async () => {
        // Scanning the wire rather than the source: whatever the client library
        // is asked for, what must reach Redis is MULTI … EXEC.
        fake = await startFakeRedis();
        process.env.REDIS_URL = fake.url;

        const handler = await newHandler();
        await handler.set(KEY, payload, { revalidate: 60, tags: [TAG] });

        const multiAt = fake.received.indexOf("multi");
        const setAt = fake.received.indexOf("set");
        const execAt = fake.received.indexOf("exec");
        expect(multiAt).toBeGreaterThanOrEqual(0);
        expect(execAt).toBeGreaterThan(setAt);
        expect(setAt).toBeGreaterThan(multiAt);
    });

    it("revalidateTag is atomic too — entries and their tag index drop together", async () => {
        // The inverse tear: a death mid-invalidation that deletes the entries
        // but leaves the tag index, or deletes the index while entries survive
        // an invalidation that already reported success.
        fake = await startFakeRedis({
            onCommand: (cmd, args, socket) => {
                // Kill as the tag index itself is about to be dropped — i.e.
                // after the entry deletions have been transmitted.
                if (cmd === "del" && args[0] === `${PREFIX}:tag:${TAG}`) {
                    socket.destroy();
                }
            },
        });
        process.env.REDIS_URL = fake.url;

        const seed = await import(`${CACHE_HANDLER}?gen=${__handlerGen}`);
        const handler = new seed.default({}) as {
            set: (k: string, d: unknown, c: unknown) => Promise<void>;
            revalidateTag: (t: string[]) => Promise<void>;
        };
        await handler.set(KEY, payload, { revalidate: 60, tags: [TAG] });
        expect(observed(fake)).toEqual({ entry: true, tagged: true });

        await handler.revalidateTag([TAG]);

        const state = observed(fake);
        // All-or-nothing again: the entry and its index agree either way.
        expect(state.entry).toBe(state.tagged);
    });

    it("a mid-write death does not throw — the render/after() path continues", async () => {
        // Atomicity must not be bought with a rejection that escapes into the
        // request or an `after()` callback.
        fake = await startFakeRedis({
            onCommand: (cmd, _args, socket) => {
                if (cmd === "sadd") socket.destroy();
            },
        });
        process.env.REDIS_URL = fake.url;

        const handler = await newHandler();
        await expect(
            handler.set(KEY, payload, { revalidate: 60, tags: [TAG] }),
        ).resolves.toBeUndefined();
    });
});

/**
 * The other half of T13: the in-flight write must be AWAITABLE at shutdown.
 * Atomicity guarantees the entry is never partial; it does not by itself give
 * the drain a way to know a write is outstanding. `drainCacheWrites()` is that
 * handle — it is what a SIGTERM path awaits so a revalidation write that was
 * already in flight is allowed to commit rather than being abandoned.
 */
describe("T13 — in-flight cache writes are drainable", () => {
    const original = { ...process.env };
    const CACHE_HANDLER: string = "../adapters/cache-handler.js";
    let fake: FakeRedis | undefined;
    const REGISTRY: string = "../adapters/cache-write-registry.js";

    beforeEach(() => {
        __handlerGen += 1;
        process.env.REDIS_KEY_PREFIX = "drain-app";
        spyOn(console, "error").mockImplementation(() => {});
        spyOn(console, "warn").mockImplementation(() => {});
        spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        process.env = { ...original };
        jest.restoreAllMocks();
    });

    it("drainCacheWrites() resolves only after an in-flight set() has committed", async () => {
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        fake = await startFakeRedis({
            onCommand: async (cmd) => {
                // Hold the commit open so the write is genuinely in flight.
                if (cmd === "exec") await held;
            },
        });
        process.env.REDIS_URL = fake.url;

        const mod = await import(`${CACHE_HANDLER}?gen=${__handlerGen}`);
        const registry = await import(REGISTRY);
        const handler = new mod.default({});

        const writing = handler.set("/k", { kind: "PAGE" }, { revalidate: 30 });

        let drained = false;
        const draining = registry.drainCacheWrites(5000).then(() => {
            drained = true;
        });

        // Still in flight → the drain must NOT have resolved.
        await new Promise((r) => setTimeout(r, 50));
        expect(drained).toBe(false);

        release?.();
        await writing;
        await draining;
        expect(drained).toBe(true);
        expect(fake.strings.has("drain-app:cache:/k")).toBe(true);
    });

    it("drainCacheWrites() is bounded — a hung write cannot outlast the grace cap", async () => {
        // The pod's terminationGracePeriod is the real budget; a drain that can
        // hang forever converts a cache stall into a SIGKILL.
        fake = await startFakeRedis({
            onCommand: async (cmd) => {
                if (cmd === "exec") await new Promise(() => {});
            },
        });
        process.env.REDIS_URL = fake.url;

        const mod = await import(`${CACHE_HANDLER}?gen=${__handlerGen}`);
        const registry = await import(REGISTRY);
        const handler = new mod.default({});
        void handler.set("/hung", { kind: "PAGE" }, { revalidate: 30 });

        const startedAt = Date.now();
        await registry.drainCacheWrites(200);
        expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    it("drainCacheWrites() resolves immediately when nothing is in flight", async () => {
        const registry = await import(REGISTRY);
        await expect(registry.drainCacheWrites(1000)).resolves.toBeUndefined();
    });
});
