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

/**
 * Invalidations skipped while the Redis breaker is open are replayed when it
 * closes (ISR handler).
 *
 * With the breaker open, `revalidateTag` can only clear this pod's memory: the
 * shared Redis entries survive, and the edge is deliberately not purged (a
 * purge would refill from stale Redis). Before the replay, both stayed stale
 * until their TTL. Now the handler remembers the tags it could not take to
 * Redis -- deduplicated, at most 1000 -- and once the breaker closes it replays
 * the Redis invalidation and then purges those tags at the edge. Past the bound
 * the backlog collapses into one invalidation of every ISR entry under the
 * app's key prefix plus one app-wide edge purge: wider than needed, never
 * stale.
 *
 * Both Redis clients: ioredis (forced with KNEXT_CACHE_REDIS_CLIENT) and Bun's
 * native client, which production uses on Bun.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";
const REGISTRY: string = "../adapters/cache-write-registry.js";
const PURGER = Symbol.for("knext.core.cdn.purger");
const PREFIX = "replay";
const COOLDOWN_MS = 300;
const BOUND = 1000;

// biome-ignore lint/suspicious/noExplicitAny: the handler module is untyped plain JS
type Any = any;
interface WriteRegistry {
    drainCacheWrites(timeoutMs?: number): Promise<void>;
    inFlightCacheWriteCount(): number;
}

const g = globalThis as Record<symbol, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error("waitFor: timed out");
        await sleep(10);
    }
}

/** A stand-in for the process-wide purger, recording what it was asked to purge. */
function installPurger(onEnqueue?: (tags: unknown) => void) {
    const enqueued: unknown[] = [];
    const appPurges: number[] = [];
    g[PURGER] = {
        enqueue(tags: unknown) {
            onEnqueue?.(tags);
            enqueued.push(tags);
            return { queued: 1 };
        },
        enqueueApp() {
            appPurges.push(Date.now());
            return { queued: 1 };
        },
        firstReady: async () => ({ purged: false, reason: "stub" }),
        flush: async () => {},
        status: () => ({ state: "stub" }),
    };
    return { enqueued, appPurges };
}

const page = (tags: string) => ({
    kind: "APP_PAGE",
    html: "<html>p</html>",
    headers: { "x-next-cache-tags": tags },
});
const pageCtx = {
    cacheControl: { revalidate: 3600 },
    isRoutePPREnabled: false,
    isFallback: false,
};
const entry = (key: string) => `${PREFIX}:cache:${key}`;

const CLIENTS = [
    { name: "ioredis", selector: "ioredis" as string | undefined },
    { name: "Bun native", selector: undefined },
];

for (const client of CLIENTS) {
    describe(`breaker-open invalidation replay (${client.name})`, () => {
        const original = { ...process.env };
        let fake: FakeRedis | undefined;
        let gen = 0;
        let failGets = false;
        let errorFor: (cmd: string, args: string[]) => string | undefined =
            () => undefined;
        let onCommand: (cmd: string, args: string[]) => void | Promise<void> =
            () => {};

        beforeEach(() => {
            gen += 1;
            failGets = false;
            errorFor = () => undefined;
            onCommand = () => {};
            delete g[PURGER];
            delete process.env.KNEXT_CDN_PROVIDER;
            delete process.env.KNEXT_BUILD_ID;
            delete process.env.NEXT_DEPLOYMENT_ID;
            process.env.REDIS_KEY_PREFIX = PREFIX;
            process.env.REDIS_RETRY_COOLDOWN_MS = String(COOLDOWN_MS);
            if (client.selector)
                process.env.KNEXT_CACHE_REDIS_CLIENT = client.selector;
            else delete process.env.KNEXT_CACHE_REDIS_CLIENT;
            spyOn(console, "error").mockImplementation(() => {});
            spyOn(console, "warn").mockImplementation(() => {});
            spyOn(console, "log").mockImplementation(() => {});
        });

        afterEach(async () => {
            // Let any probe/replay of this case settle before its server goes.
            await sleep(COOLDOWN_MS + 50);
            delete g[PURGER];
            await fake?.close();
            fake = undefined;
            process.env = { ...original };
            jest.restoreAllMocks();
        });

        /** A handler on a fresh module instance, against a fresh fake Redis. */
        async function handler(): Promise<Any> {
            fake = await startFakeRedis({
                errorFor: (cmd, args) =>
                    failGets && cmd === "get" ? "boom" : errorFor(cmd, args),
                onCommand: (cmd, args) => onCommand(cmd, args),
            });
            process.env.REDIS_URL = fake.url;
            const mod = await import(
                `${CACHE_HANDLER}?replay=${client.name}-${gen}`
            );
            return new mod.default({});
        }

        /** Open the breaker with one faulting command; Redis itself is healthy again. */
        async function openBreaker(h: Any) {
            failGets = true;
            expect(await h.get("/never", { kind: "APP_PAGE" })).toBeNull();
            failGets = false;
        }

        const smembersOf = (tag: string) =>
            (fake?.commands ?? []).filter(
                (c) =>
                    c.cmd === "smembers" &&
                    c.args[0] === `${PREFIX}:tag:${tag}`,
            ).length;

        it("breaker open during revalidateTag, then closed: origin and edge are fresh with no TTL wait and no further request", async () => {
            const h = await handler();
            const seen: { tags: unknown; entryStillThere: boolean }[] = [];
            installPurger((tags) =>
                seen.push({
                    tags,
                    entryStillThere: fake?.strings.has(entry("/p")) ?? true,
                }),
            );
            await h.set("/p", page("x,_N_T_/p"), pageCtx);
            expect(fake?.strings.has(entry("/p"))).toBe(true);

            await openBreaker(h);
            await h.revalidateTag("x");
            // The breaker was open: Redis untouched, no edge purge yet.
            expect(fake?.strings.has(entry("/p"))).toBe(true);
            expect(seen).toEqual([]);

            // No request after the outage: the replay is driven by the handler.
            await waitFor(() => seen.length > 0);
            // The Redis invalidation came first, then the edge purge.
            expect(seen).toEqual([{ tags: ["x"], entryStillThere: false }]);
            expect(fake?.sets.has(`${PREFIX}:tag:x`)).toBe(false);
            // Origin: Next's read misses, so the page re-renders.
            expect(await h.get("/p", { kind: "APP_PAGE" })).toBeNull();
            // Replayed once, then forgotten.
            await sleep(COOLDOWN_MS + 100);
            expect(seen).toHaveLength(1);
            expect(smembersOf("x")).toBe(1);
        });

        it("never replays while the breaker is still open", async () => {
            const h = await handler();
            installPurger();
            await h.set("/p", page("x"), pageCtx);
            await openBreaker(h);
            await h.revalidateTag("x");
            // Redis answers again, but the breaker has not closed yet.
            await sleep(COOLDOWN_MS / 3);
            expect(smembersOf("x")).toBe(0);
            expect(fake?.strings.has(entry("/p"))).toBe(true);
            await waitFor(() => !fake?.strings.has(entry("/p")));
        });

        it("deduplicates: one tag revalidated many times during the outage is replayed once", async () => {
            const h = await handler();
            const { enqueued } = installPurger();
            await openBreaker(h);
            for (let i = 0; i < 5; i++) await h.revalidateTag(["x", "y"]);
            await waitFor(() => enqueued.length > 0);
            await sleep(50);
            expect(smembersOf("x")).toBe(1);
            expect(smembersOf("y")).toBe(1);
            expect(enqueued).toEqual([["x", "y"]]);
        });

        it(`the bound: ${BOUND} pending tags are each replayed and nothing else is touched`, async () => {
            const h = await handler();
            const { enqueued, appPurges } = installPurger();
            await h.set("/q", page("unrelated"), pageCtx);
            await openBreaker(h);
            const tags = Array.from({ length: BOUND }, (_, i) => `t${i}`);
            await h.revalidateTag(tags);
            await waitFor(() => enqueued.length > 0, 8000);
            expect(smembersOf("t0")).toBe(1);
            expect(smembersOf(`t${BOUND - 1}`)).toBe(1);
            expect((enqueued[0] as string[]).length).toBe(BOUND);
            expect(appPurges).toEqual([]);
            expect(fake?.strings.has(entry("/q"))).toBe(true);
        });

        it(`past the bound (${BOUND + 1} tags) the backlog collapses: every ISR entry of this app is invalidated and the whole app is purged at the edge, once`, async () => {
            const h = await handler();
            const { enqueued, appPurges } = installPurger();
            await h.set("/p", page("t0"), pageCtx);
            await h.set("/q", page("unrelated"), pageCtx);
            // Another app sharing this Redis under its own prefix.
            fake?.strings.set("other-app:cache:/z", "{}");
            await openBreaker(h);
            const tags = Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`);
            await h.revalidateTag(tags);
            const overflowWarned = (
                console.warn as unknown as { mock: { calls: unknown[][] } }
            ).mock.calls.filter((c) => String(c[0]).includes("replay"));
            expect(overflowWarned).toHaveLength(1);

            await waitFor(() => appPurges.length > 0);
            await sleep(50);
            expect(fake?.strings.has(entry("/p"))).toBe(false);
            expect(fake?.strings.has(entry("/q"))).toBe(false);
            expect(fake?.strings.has("other-app:cache:/z")).toBe(true);
            // Not replayed tag by tag: the collapse replaces the list.
            expect(smembersOf("t0")).toBe(0);
            expect(smembersOf(`t${BOUND}`)).toBe(0);
            expect(enqueued).toEqual([]);
            expect(appPurges).toHaveLength(1);
            await sleep(COOLDOWN_MS + 100);
            expect(appPurges).toHaveLength(1);
        });

        it("a fault during the replay stops it at once (no storm) and the rest is replayed after the next cooldown", async () => {
            const h = await handler();
            const { enqueued } = installPurger();
            await openBreaker(h);
            await h.revalidateTag(["a", "b", "c"]);
            let faults = 0;
            errorFor = (cmd, args) => {
                if (
                    cmd === "smembers" &&
                    args[0] === `${PREFIX}:tag:b` &&
                    faults === 0
                ) {
                    faults += 1;
                    return "boom";
                }
                return undefined;
            };
            await waitFor(() => enqueued.length >= 2, 6000);
            const order = (fake?.commands ?? [])
                .filter((c) => c.cmd === "smembers")
                .map((c) => c.args[0].slice(`${PREFIX}:tag:`.length));
            // a done, b faulted -> stop; c never tried in that run; then b, c.
            expect(order).toEqual(["a", "b", "b", "c"]);
            expect(enqueued).toEqual([["a"], ["b", "c"]]);
        });

        it("tags a revalidateTag could not finish because Redis faulted mid-loop are replayed too", async () => {
            const h = await handler();
            const { enqueued } = installPurger();
            await h.set("/c", page("c"), pageCtx);
            let faults = 0;
            errorFor = (cmd, args) => {
                if (
                    cmd === "smembers" &&
                    args[0] === `${PREFIX}:tag:b` &&
                    faults === 0
                ) {
                    faults += 1;
                    return "boom";
                }
                return undefined;
            };
            await h.revalidateTag(["a", "b", "c"]);
            expect(enqueued).toEqual([["a"]]);
            expect(fake?.strings.has(entry("/c"))).toBe(true);
            await waitFor(() => enqueued.length >= 2);
            expect(enqueued).toEqual([["a"], ["b", "c"]]);
            expect(fake?.strings.has(entry("/c"))).toBe(false);
        });

        it("the replay is off the request path but in the SIGTERM drain registry", async () => {
            const h = await handler();
            const { enqueued } = installPurger();
            await h.set("/p", page("x"), pageCtx);
            await openBreaker(h);
            let release: () => void = () => {};
            let held = false;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            onCommand = (cmd, args) => {
                if (cmd === "smembers" && args[0] === `${PREFIX}:tag:x`) {
                    held = true;
                    return gate;
                }
            };
            // revalidateTag does not wait for Redis to come back.
            const t0 = Date.now();
            await h.revalidateTag("x");
            expect(Date.now() - t0).toBeLessThan(COOLDOWN_MS);
            await waitFor(() => held);
            const registry = (await import(
                REGISTRY
            )) as unknown as WriteRegistry;
            expect(registry.inFlightCacheWriteCount()).toBeGreaterThan(0);
            release();
            await registry.drainCacheWrites(2000);
            expect(enqueued).toEqual([["x"]]);
            expect(fake?.strings.has(entry("/p"))).toBe(false);
        });

        it("the probe timer is unref'd: a pod waiting out an outage is not held open by it", async () => {
            // A cooldown no other timer here uses, so the probe is the one
            // timer armed with a delay just under it.
            const cooldown = 45_678;
            process.env.REDIS_RETRY_COOLDOWN_MS = String(cooldown);
            const h = await handler();
            installPurger();
            await openBreaker(h);
            const realSetTimeout = globalThis.setTimeout;
            const armed: { delay: number; timer: Any }[] = [];
            const recording = ((
                fn: () => void,
                delay?: number,
                ...rest: unknown[]
            ) => {
                const timer = realSetTimeout(fn, delay, ...rest);
                armed.push({ delay: Number(delay), timer });
                return timer;
            }) as unknown as typeof setTimeout;
            globalThis.setTimeout = recording;
            try {
                await h.revalidateTag("x");
                // The probe is armed when the (breaker-blocked) replay attempt
                // settles, a few microtasks after revalidateTag resolves.
                await sleep(20);
            } finally {
                globalThis.setTimeout = realSetTimeout;
            }
            const probes = armed.filter(
                (a) => a.delay > cooldown - 5000 && a.delay <= cooldown,
            );
            expect(probes).toHaveLength(1);
            expect(probes[0].timer.hasRef()).toBe(false);
            // Disarm it: this case does not wait out a 45 s cooldown.
            clearTimeout(probes[0].timer);
        });
    });
}

/**
 * The races a replay must survive: a fresh skip recorded while the replay is
 * part-way through. Each is reachable through one client only, so each runs on
 * that client.
 *
 * - ioredis pipelines a concurrent command on the same connection, so a newer
 *   `revalidateTag` that faults can land in the same read as the replay's EXEC
 *   reply. On the native client the connection gate holds that command until
 *   the replay's transaction has resolved, so it can only land after.
 * - A fault queued behind one of a collapse sweep's pages trips the breaker,
 *   which closes the client the sweep is using (on both clients since the
 *   native one is closed with `close()`), so the sweep aborts and the collapse
 *   is kept for the next probe. Before that fix the native client stayed
 *   connected and the sweep ran on past the fault; this case then rested on
 *   the generation check instead.
 */
for (const client of CLIENTS) {
    const ioredis = client.selector === "ioredis";
    describe(`breaker-open invalidation replay races (${client.name})`, () => {
        const original = { ...process.env };
        let fake: FakeRedis | undefined;
        let gen = 0;
        let failGets = false;
        let errorFor: (cmd: string, args: string[]) => string | undefined =
            () => undefined;
        let onCommand: (cmd: string, args: string[]) => void | Promise<void> =
            () => {};

        beforeEach(() => {
            gen += 1;
            failGets = false;
            errorFor = () => undefined;
            onCommand = () => {};
            delete g[PURGER];
            delete process.env.KNEXT_CDN_PROVIDER;
            delete process.env.KNEXT_BUILD_ID;
            delete process.env.NEXT_DEPLOYMENT_ID;
            process.env.REDIS_KEY_PREFIX = PREFIX;
            process.env.REDIS_RETRY_COOLDOWN_MS = String(COOLDOWN_MS);
            if (client.selector)
                process.env.KNEXT_CACHE_REDIS_CLIENT = client.selector;
            else delete process.env.KNEXT_CACHE_REDIS_CLIENT;
            spyOn(console, "error").mockImplementation(() => {});
            spyOn(console, "warn").mockImplementation(() => {});
            spyOn(console, "log").mockImplementation(() => {});
        });

        afterEach(async () => {
            await sleep(COOLDOWN_MS + 50);
            delete g[PURGER];
            await fake?.close();
            fake = undefined;
            process.env = { ...original };
            jest.restoreAllMocks();
        });

        async function handler(): Promise<Any> {
            fake = await startFakeRedis({
                errorFor: (cmd, args) =>
                    failGets && cmd === "get" ? "boom" : errorFor(cmd, args),
                onCommand: (cmd, args) => onCommand(cmd, args),
            });
            process.env.REDIS_URL = fake.url;
            const mod = await import(
                `${CACHE_HANDLER}?replay-race=${client.name}-${gen}`
            );
            return new mod.default({});
        }

        async function openBreaker(h: Any) {
            failGets = true;
            expect(await h.get("/never", { kind: "APP_PAGE" })).toBeNull();
            failGets = false;
        }

        const count = (cmd: string, arg0?: string) =>
            (fake?.commands ?? []).filter(
                (c) =>
                    c.cmd === cmd && (arg0 === undefined || c.args[0] === arg0),
            ).length;

        /** Hold the next `cmd` at the server until released. */
        function holdNext(cmd: string) {
            let release: () => void = () => {};
            let held = false;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            const prev = onCommand;
            onCommand = (c, args) => {
                if (c === cmd && !held) {
                    held = true;
                    return gate;
                }
                return prev(c, args);
            };
            return { release: () => release(), isHeld: () => held };
        }

        /** Collapse sweeps started: SCANs from cursor 0. */
        const sweepsStarted = () =>
            (fake?.commands ?? []).filter(
                (c) => c.cmd === "scan" && c.args[0] === "0",
            ).length;

        /** Fail the `nth` SMEMBERS of `tag` (1-based), once. */
        const failNthSmembers = (tag: string, nth: number) => {
            const key = `${PREFIX}:tag:${tag}`;
            errorFor = (cmd, args) =>
                cmd === "smembers" &&
                args[0] === key &&
                count("smembers", key) === nth
                    ? "boom"
                    : undefined;
        };

        // Registered on the one client that can reach the window (see above).
        if (ioredis)
            it("a skip of the same tag recorded while that tag is being replayed is not forgotten", async () => {
                const h = await handler();
                const { enqueued } = installPurger();
                await h.set("/p", page("x"), pageCtx);
                await openBreaker(h);
                await h.revalidateTag("x");
                // The replay's EXEC for x is held at the server. A newer
                // revalidateTag("x") is pipelined behind it and faults, so it
                // is recorded in the same read as the replay's EXEC reply.
                const exec = holdNext("exec");
                const tagX = `${PREFIX}:tag:x`;
                failNthSmembers("x", 2);
                await waitFor(exec.isHeld);
                const newer = h.revalidateTag("x");
                await waitFor(() => count("smembers", tagX) === 2);
                exec.release();
                await newer;
                // The first replay completed (one purge). The newer
                // invalidation of x never reached Redis, so x is replayed again.
                await waitFor(() => count("smembers", tagX) >= 3);
                await waitFor(() => enqueued.length >= 2);
                expect(enqueued).toEqual([["x"], ["x"]]);
            });

        it("a skip recorded during the collapse sweep keeps the collapse for another sweep", async () => {
            const h = await handler();
            const { appPurges } = installPurger();
            // Another app's keys: enough for a second SCAN page.
            for (let i = 0; i < 150; i++)
                fake?.strings.set(`other-app:cache:/k${i}`, "{}");
            await openBreaker(h);
            await h.revalidateTag(
                Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`),
            );
            // The sweep's first SCAN page is held at the server. A
            // revalidateTag("z") queues behind it and faults: a skip
            // recorded while the sweep still has a page to go.
            const scan = holdNext("scan");
            failNthSmembers("z", 1);
            await waitFor(scan.isHeld);
            const late = h.revalidateTag("z");
            await sleep(20);
            scan.release();
            await late;
            expect(count("smembers", `${PREFIX}:tag:z`)).toBe(1);
            // z's entries may predate the pages already swept: the collapse
            // must run again, from the first page, rather than be cleared.
            await waitFor(() => sweepsStarted() >= 2 && appPurges.length >= 1);
            expect(fake?.strings.has("other-app:cache:/k0")).toBe(true);
        });

        // Since the breaker closes the client on a trip, a Redis fault aborts
        // the sweep, so the case above no longer reaches the generation check
        // in `replayCollapsedBacklog`. A skip recorded WITHOUT a trip still
        // does: a non-Redis exception in revalidateTag (here a tag that cannot
        // be made into a key) lands in its catch, and the tags after it are
        // recorded as skipped while the sweep has a page to go. No breaker
        // trip, so the sweep runs to its end -- and only the generation check
        // keeps the collapse for another sweep.
        it("a skip recorded mid-sweep without a breaker trip keeps the collapse for another sweep", async () => {
            const h = await handler();
            const { appPurges } = installPurger();
            for (let i = 0; i < 150; i++)
                fake?.strings.set(`other-app:cache:/k${i}`, "{}");
            await openBreaker(h);
            await h.revalidateTag(
                Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`),
            );
            const scan = holdNext("scan");
            await waitFor(scan.isHeld);
            // A Symbol throws a TypeError when interpolated into the tag key,
            // before any Redis command: z is never reached and is recorded.
            await h.revalidateTag([Symbol("not-a-key"), "z"]);
            scan.release();
            // The breaker never tripped: z sent nothing, and the sweep ran on
            // to its second page and to its end (one app purge).
            await waitFor(() => appPurges.length >= 1);
            expect(count("smembers", `${PREFIX}:tag:z`)).toBe(0);
            expect(
                (fake?.commands ?? []).some(
                    (c) => c.cmd === "scan" && c.args[0] !== "0",
                ),
            ).toBe(true);
            // The skip recorded during that sweep kept the collapse: a second
            // sweep starts from the first page rather than z being forgotten.
            await waitFor(() => sweepsStarted() >= 2 && appPurges.length >= 2);
        });
    });
}

describe("no Redis configured: nothing to replay", () => {
    const original = { ...process.env };
    afterEach(() => {
        delete g[PURGER];
        process.env = { ...original };
    });

    it("memory is the shared store, so the purge runs at once and is never repeated", async () => {
        delete process.env.REDIS_URL;
        process.env.REDIS_RETRY_COOLDOWN_MS = String(COOLDOWN_MS);
        const { enqueued } = installPurger();
        const mod = await import(`${CACHE_HANDLER}?replay=noredis`);
        const h = new mod.default({});
        await h.revalidateTag("x");
        expect(enqueued).toEqual([["x"]]);
        await sleep(COOLDOWN_MS + 100);
        expect(enqueued).toEqual([["x"]]);
    });
});
