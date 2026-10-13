/**
 * The shared Redis `cacheHandlers` backend for `'use cache'` (Next >= 16.4).
 *
 * Contract under test (next@16.4.0 `lib/cache-handlers/types.d.ts`):
 * `get(cacheKey, softTags)`, `set(cacheKey, pendingEntry)`, `refreshTags()`,
 * `getExpiration(tags)`, `updateTags(tags, durations?)`; the entry value is a
 * ReadableStream consumed ONCE and never retained; the handler owns eviction.
 *
 * Every case runs against a REAL RESP server over a real socket, through BOTH
 * Redis clients the product ships (ioredis, and Bun's native client), and a
 * "pod" is a fresh evaluation of `cache-handler.js` -- its own breaker, client
 * and pending-set map -- so "shared across pods" is not a same-module illusion.
 */
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";
import * as useCacheModule from "../adapters/use-cache-handler.js";
import {
    type FakeRedis,
    type FakeRedisOptions,
    reservedClosedPort,
    startFakeRedis,
} from "./helpers/fake-redis";

const CACHE_HANDLER = "../adapters/cache-handler.js";
const PREFIX = "uc-app";

interface UseCacheEntry {
    value: ReadableStream<Uint8Array>;
    tags: string[];
    stale: number;
    timestamp: number;
    expire: number;
    revalidate: number;
}

interface UseCacheHandler {
    get(
        cacheKey: string,
        softTags?: string[],
    ): Promise<UseCacheEntry | undefined>;
    set(cacheKey: string, pending: Promise<UseCacheEntry>): Promise<void>;
    refreshTags(): Promise<void>;
    getExpiration(tags: string[]): Promise<number>;
    updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    let out = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return out;
        out += dec.decode(value, { stream: true });
    }
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(c) {
            for (const chunk of chunks) c.enqueue(enc.encode(chunk));
            c.close();
        },
    });
}

/** A stream that records how it was consumed. */
function spiedStream(chunks: string[]) {
    const seen = { getReaderCalls: 0, drained: false, cancelled: false };
    let i = 0;
    const inner = new ReadableStream<Uint8Array>(
        {
            pull(c) {
                if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
                else {
                    seen.drained = true;
                    c.close();
                }
            },
            cancel() {
                seen.cancelled = true;
            },
        },
        { highWaterMark: 0 },
    );
    const original = inner.getReader.bind(inner) as (
        options?: unknown,
    ) => ReadableStreamDefaultReader<Uint8Array>;
    (inner as { getReader: unknown }).getReader = (options?: unknown) => {
        seen.getReaderCalls += 1;
        return original(options);
    };
    return { stream: inner, seen };
}

function entryOf(
    over: Partial<UseCacheEntry> & { body?: string } = {},
): UseCacheEntry {
    const { body, ...rest } = over;
    return {
        value: streamOf([body ?? "hello"]),
        tags: [],
        stale: 300,
        timestamp: Date.now(),
        expire: 3600,
        revalidate: 900,
        ...rest,
    };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The fake has no Lua VM. This is a model of the stamp-prune script, keyed by
 * its exact source: HDEL a field only while its CURRENT value is still older than
 * the cutoff (ARGV[1]); ARGV[2..] are the fields one HSCAN page proposed.
 */
const PRUNE_SCRIPT = (useCacheModule as Record<string, unknown>)
    .PRUNE_STAMPS_SCRIPT as string;
const scripts: NonNullable<FakeRedisOptions["scripts"]> = {
    [String(PRUNE_SCRIPT)]: (keys, argv, { hashes }) => {
        const h = hashes.get(keys[0]);
        const cutoff = Number(argv[0]);
        let n = 0;
        for (const field of argv.slice(1)) {
            const v = h?.get(field);
            if (v !== undefined && Number(v) < cutoff && h?.delete(field)) n++;
        }
        if (h && h.size === 0) hashes.delete(keys[0]);
        return `:${n}\r\n`;
    },
};

/** Run `fn` with this process's `performance` clock off by `ms` (a skewed pod). */
const realPerfNow = performance.now.bind(performance);
async function withSkew<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const spy = spyOn(performance, "now").mockImplementation(
        () => realPerfNow() + ms,
    );
    try {
        return await fn();
    } finally {
        spy.mockRestore();
    }
}

/** Next's clock for an entry's `timestamp`, read through the (maybe skewed) pod clock. */
const nextNow = () => Math.round(performance.timeOrigin + performance.now());

const counters = () =>
    ((globalThis as Record<symbol, unknown>)[
        Symbol.for("knext.cache.useCache.counters")
    ] ?? {}) as Record<string, number>;

describe.each([
    ["ioredis", "ioredis"],
    ["Bun native", "native"],
] as const)("'use cache' Redis handler -- %s client", (_label, clientKind) => {
    const original = { ...process.env };
    let fake: FakeRedis | undefined;
    let gen = 0;

    beforeEach(() => {
        process.env.REDIS_KEY_PREFIX = PREFIX;
        if (clientKind === "ioredis")
            process.env.KNEXT_CACHE_REDIS_CLIENT = "ioredis";
        else delete process.env.KNEXT_CACHE_REDIS_CLIENT;
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

    /** A pod: a fresh evaluation of the handler module bound to the current env. */
    async function pod(kind: "default" | "remote" = "default") {
        gen += 1;
        const mod = await import(`${CACHE_HANDLER}?ucpod=${clientKind}${gen}`);
        const useCache = (
            mod.CacheHandler as {
                forUseCache(kind: string): UseCacheHandler;
            }
        ).forUseCache(kind);
        return { mod, useCache };
    }

    async function withRedis(options: FakeRedisOptions = {}) {
        fake = await startFakeRedis({ scripts, ...options });
        process.env.REDIS_URL = fake.url;
        return fake;
    }

    // ── the contract ────────────────────────────────────────────────────────

    it("implements the 16.4 CacheHandler surface", async () => {
        await withRedis();
        const { useCache } = await pod();
        for (const m of [
            "get",
            "set",
            "refreshTags",
            "getExpiration",
            "updateTags",
        ] as const) {
            expect(typeof useCache[m], m).toBe("function");
        }
    });

    it("set then get round-trips the bytes and every metadata field, and each get streams afresh", async () => {
        await withRedis();
        const { useCache } = await pod();
        const e = entryOf({
            body: "payload-é中",
            tags: ["a", "b"],
            stale: 11,
            timestamp: 1_700_000_000_000,
            expire: 600,
            revalidate: 120,
        });
        await useCache.set("k1", Promise.resolve(e));

        const first = await useCache.get("k1", []);
        expect(first).toBeDefined();
        expect(first?.tags).toEqual(["a", "b"]);
        expect(first?.stale).toBe(11);
        expect(first?.timestamp).toBe(1_700_000_000_000);
        expect(first?.expire).toBe(600);
        expect(first?.revalidate).toBe(120);
        expect(await readAll(first?.value as ReadableStream<Uint8Array>)).toBe(
            "payload-é中",
        );

        // "A handler must return a new stream from every get."
        const second = await useCache.get("k1", []);
        expect(second?.value).not.toBe(first?.value);
        expect(await readAll(second?.value as ReadableStream<Uint8Array>)).toBe(
            "payload-é中",
        );
    });

    it("a miss is undefined", async () => {
        await withRedis();
        const { useCache } = await pod();
        expect(await useCache.get("nope", [])).toBeUndefined();
    });

    // ── shared across pods (the point of the issue) ─────────────────────────

    it("an entry written by one pod is a hit on another", async () => {
        await withRedis();
        const a = await pod();
        const b = await pod();
        await a.useCache.set(
            "shared",
            Promise.resolve(entryOf({ body: "from-A" })),
        );
        const hit = await b.useCache.get("shared", []);
        expect(hit, "pod B must see pod A's 'use cache' entry").toBeDefined();
        expect(await readAll(hit?.value as ReadableStream<Uint8Array>)).toBe(
            "from-A",
        );
    });

    it("keys are <prefix>:uc:<kind>:<cacheKey>, so default and remote never collide and apps are isolated", async () => {
        const f = await withRedis();
        const def = await pod("default");
        const rem = await pod("remote");
        await def.useCache.set(
            "same-key",
            Promise.resolve(entryOf({ body: "D" })),
        );
        await rem.useCache.set(
            "same-key",
            Promise.resolve(entryOf({ body: "R" })),
        );
        expect(
            [...f.strings.keys()].filter((k) => k.includes(":uc:")).sort(),
        ).toEqual([
            `${PREFIX}:uc:default:same-key`,
            `${PREFIX}:uc:remote:same-key`,
        ]);
        const d = await def.useCache.get("same-key", []);
        const r = await rem.useCache.get("same-key", []);
        expect(await readAll(d?.value as ReadableStream<Uint8Array>)).toBe("D");
        expect(await readAll(r?.value as ReadableStream<Uint8Array>)).toBe("R");
    });

    it("never touches the ISR namespace (<prefix>:cache:, <prefix>:tag:)", async () => {
        const f = await withRedis();
        const { useCache } = await pod();
        await useCache.set("k", Promise.resolve(entryOf({ tags: ["x"] })));
        await useCache.updateTags(["x"]);
        const keys = [
            ...f.strings.keys(),
            ...f.sets.keys(),
            ...f.hashes.keys(),
        ];
        expect(
            keys.filter(
                (k) =>
                    k.startsWith(`${PREFIX}:cache:`) ||
                    k.startsWith(`${PREFIX}:tag:`),
            ),
        ).toEqual([]);
    });

    // ── build scoping ───────────────────────────────────────────────────────

    it("stores the build id for diagnostics only and never turns a foreign build into a miss (Next's own key is the scope)", async () => {
        await withRedis();
        process.env.KNEXT_BUILD_ID = "build-A";
        const a = await pod();
        // Construct the singular handler once, as Next does per request, so the
        // module has resolved its build id.
        new (a.mod.default as new (o: object) => unknown)({});
        await a.useCache.set(
            "scoped",
            Promise.resolve(entryOf({ body: "A-body" })),
        );
        const stored = JSON.parse(
            [...(fake as FakeRedis).strings.entries()].find(
                ([k]) => k === `${PREFIX}:uc:default:scoped`,
            )?.[1] as string,
        );
        expect(stored.buildId).toBe("build-A");

        // A different build reads the SAME key (a durable-entries style key) and
        // is served: the handler adds no foreign-build miss of its own.
        process.env.KNEXT_BUILD_ID = "build-B";
        const b = await pod();
        new (b.mod.default as new (o: object) => unknown)({});
        const hit = await b.useCache.get("scoped", []);
        expect(hit).toBeDefined();
    });

    // ── TTL ownership ───────────────────────────────────────────────────────

    it("asks Redis for EX = min(entry.expire, cap) with a 24 h default cap", async () => {
        const f = await withRedis();
        const { useCache } = await pod();
        await useCache.set("short", Promise.resolve(entryOf({ expire: 90 })));
        await useCache.set(
            "long",
            Promise.resolve(entryOf({ expire: 7 * 86_400 })),
        );
        // Next's default cacheLife: expire = INFINITE_CACHE = 0xfffffffe seconds.
        await useCache.set(
            "inf",
            Promise.resolve(entryOf({ expire: 0xfffffffe })),
        );
        expect(f.ttls.get(`${PREFIX}:uc:default:short`)).toBe(90);
        expect(f.ttls.get(`${PREFIX}:uc:default:long`)).toBe(86_400);
        expect(f.ttls.get(`${PREFIX}:uc:default:inf`)).toBe(86_400);
    });

    it("honours a configured cap and never goes below 1 s", async () => {
        const f = await withRedis();
        process.env.KNEXT_USE_CACHE_MAX_TTL_SECONDS = "3600";
        const { useCache } = await pod();
        await useCache.set(
            "a",
            Promise.resolve(entryOf({ expire: 0xfffffffe })),
        );
        await useCache.set("b", Promise.resolve(entryOf({ expire: 0.2 })));
        expect(f.ttls.get(`${PREFIX}:uc:default:a`)).toBe(3600);
        expect(f.ttls.get(`${PREFIX}:uc:default:b`)).toBe(1);
    });

    it("expire <= 0 stores nothing, FULLY drains the stream, and does not trip the breaker", async () => {
        const f = await withRedis();
        const a = await pod();
        const { stream, seen } = spiedStream(["dyn-1", "dyn-2", "dyn-3"]);
        await a.useCache.set(
            "dynamic",
            Promise.resolve(entryOf({ value: stream, expire: 0 })),
        );

        expect(f.strings.has(`${PREFIX}:uc:default:dynamic`)).toBe(false);
        expect(f.commands.filter((c) => c.cmd === "set")).toEqual([]);
        expect(
            seen.drained,
            "the value stream must be read to its end so Next is not left waiting",
        ).toBe(true);

        // The breaker is still closed: the ISR handler (same process, same
        // breaker) still writes to Redis rather than falling back to memory.
        const isr = new (
            a.mod.default as new (
                o: object,
            ) => {
                set(k: string, d: unknown, c: unknown): Promise<void>;
            }
        )({});
        await isr.set(
            "/page",
            { kind: "APP_PAGE", html: "<p>x</p>", headers: {} },
            { revalidate: 60 },
        );
        expect(f.strings.has(`${PREFIX}:cache:/page`)).toBe(true);
    });

    // ── stream contract ─────────────────────────────────────────────────────

    it("consumes the entry's stream exactly once", async () => {
        await withRedis();
        const { useCache } = await pod();
        const { stream, seen } = spiedStream(["one", "two"]);
        await useCache.set("once", Promise.resolve(entryOf({ value: stream })));
        expect(seen.getReaderCalls).toBe(1);
        expect(seen.drained).toBe(true);
    });

    it("a stream that errors mid-way stores nothing, resolves, and leaves the breaker closed", async () => {
        const f = await withRedis();
        const { useCache, mod } = await pod();
        let n = 0;
        const bad = new ReadableStream<Uint8Array>({
            pull(c) {
                if (n++ === 0) c.enqueue(enc.encode("partial"));
                else c.error(new Error("render aborted"));
            },
        });
        await useCache.set("partial", Promise.resolve(entryOf({ value: bad })));
        expect(f.strings.has(`${PREFIX}:uc:default:partial`)).toBe(false);
        // Still usable afterwards.
        await useCache.set("fine", Promise.resolve(entryOf({ body: "ok" })));
        expect(f.strings.has(`${PREFIX}:uc:default:fine`)).toBe(true);
        expect(mod).toBeDefined();
    });

    it("a get that arrives while a set for the same key is pending waits for it instead of missing", async () => {
        await withRedis();
        const { useCache } = await pod();
        let release: (e: UseCacheEntry) => void = () => {};
        const pending = new Promise<UseCacheEntry>((r) => {
            release = r;
        });
        const setting = useCache.set("racy", pending);
        const getting = useCache.get("racy", []);
        await sleep(30);
        release(entryOf({ body: "late-but-present" }));
        await setting;
        const hit = await getting;
        expect(
            hit,
            "get must wait for the pending set, not return a miss",
        ).toBeDefined();
        expect(await readAll(hit?.value as ReadableStream<Uint8Array>)).toBe(
            "late-but-present",
        );
    });

    // ── tags: Next's timestamp contract ─────────────────────────────────────

    it("updateTags(tags) expires entries written before it, and spares entries written after", async () => {
        await withRedis();
        const { useCache } = await pod();
        const before = Date.now();
        await useCache.set(
            "old",
            Promise.resolve(entryOf({ tags: ["t"], timestamp: before })),
        );
        expect(await useCache.get("old", [])).toBeDefined();

        await sleep(5);
        await useCache.updateTags(["t"]);
        expect(
            await useCache.get("old", []),
            "entry older than the invalidation is a miss",
        ).toBeUndefined();

        await useCache.set(
            "new",
            Promise.resolve(
                entryOf({ tags: ["t"], timestamp: Date.now() + 1 }),
            ),
        );
        expect(
            await useCache.get("new", []),
            "entry newer than the invalidation survives",
        ).toBeDefined();
    });

    it("updateTags(tags, { expire }) marks stale: the entry is served once more with revalidate = -1", async () => {
        await withRedis();
        const { useCache } = await pod();
        await useCache.set(
            "swr",
            Promise.resolve(
                entryOf({
                    tags: ["t"],
                    timestamp: Date.now(),
                    revalidate: 900,
                }),
            ),
        );
        await sleep(5);
        await useCache.updateTags(["t"], { expire: 300 });
        const stale = await useCache.get("swr", []);
        expect(stale, "stale, not expired: still served").toBeDefined();
        expect(stale?.revalidate).toBe(-1);
    });

    it("a tag invalidated on one pod expires the entry on another", async () => {
        await withRedis();
        const a = await pod();
        const b = await pod();
        await a.useCache.set(
            "x",
            Promise.resolve(
                entryOf({ tags: ["shared-tag"], timestamp: Date.now() }),
            ),
        );
        expect(await b.useCache.get("x", [])).toBeDefined();
        await sleep(5);
        await a.useCache.updateTags(["shared-tag"]);
        expect(
            await b.useCache.get("x", []),
            "revalidateTag on pod A must invalidate pod B",
        ).toBeUndefined();
    });

    it("getExpiration returns the newest expiry for the asked tags, 0 for tags never revalidated", async () => {
        await withRedis();
        const { useCache } = await pod();
        expect(await useCache.getExpiration(["never"])).toBe(0);
        const t0 = Date.now();
        await useCache.updateTags(["one"]);
        await sleep(5);
        await useCache.updateTags(["two"]);
        const exp = await useCache.getExpiration(["one", "two", "never"]);
        expect(exp).toBeGreaterThanOrEqual(t0);
        expect(await useCache.getExpiration(["one"])).toBeLessThanOrEqual(exp);
        expect(await useCache.getExpiration(["one"])).toBeGreaterThan(0);
        // Only the asked tags are read: an unrelated stamp does not leak in.
        expect(await useCache.getExpiration(["never"])).toBe(0);
    });

    it("getExpiration reads only the tags asked for (HMGET, never the whole stamp hash)", async () => {
        const f = await withRedis();
        const { useCache } = await pod();
        await useCache.updateTags(["a", "b", "c"]);
        f.commands.length = 0;
        await useCache.getExpiration(["a"]);
        expect(f.commands.map((c) => c.cmd)).toContain("hmget");
        expect(f.commands.map((c) => c.cmd)).not.toContain("hgetall");
        expect(f.commands.map((c) => c.cmd)).not.toContain("hscan");
    });

    it("refreshTags is a no-op: no per-process manifest, no Redis traffic", async () => {
        const f = await withRedis();
        const { useCache } = await pod();
        await useCache.get("warm", []); // connect
        f.commands.length = 0;
        await useCache.refreshTags();
        expect(f.commands).toEqual([]);
    });

    it("concurrent updateTags from two pods cannot lose each other's stamps (no read-modify-write)", async () => {
        const f = await withRedis();
        const a = await pod();
        const b = await pod();
        await Promise.all([
            a.useCache.updateTags(["t"], { expire: 60 }),
            b.useCache.updateTags(["t"]),
        ]);
        const fields = [...(f.hashes.get(`${PREFIX}:uc:tags`)?.keys() ?? [])];
        // Both a stale stamp and an expired stamp exist, written by single HSETs.
        expect(fields.some((x) => x.startsWith("s:"))).toBe(true);
        expect(fields.some((x) => x.startsWith("e:"))).toBe(true);
        expect(f.commands.some((c) => c.cmd === "hget")).toBe(false);
    });

    it("prunes stamps older than the TTL cap with a bounded HSCAN step per updateTags", async () => {
        const f = await withRedis();
        const old = String(Date.now() - 3 * 86_400_000);
        const fresh = String(Date.now());
        f.hashes.set(
            `${PREFIX}:uc:tags`,
            new Map([
                ["e:ancient", old],
                ["s:ancient", old],
                ["e:recent", fresh],
            ]),
        );
        const { useCache } = await pod();
        await useCache.updateTags(["x"]);
        const fields = [...(f.hashes.get(`${PREFIX}:uc:tags`)?.keys() ?? [])];
        expect(fields).not.toContain("e:ancient");
        expect(fields).not.toContain("s:ancient");
        expect(fields).toContain("e:recent");
        expect(fields).toContain("e:x");
        // Bounded: one HSCAN page, never HGETALL.
        expect(f.commands.some((c) => c.cmd === "hgetall")).toBe(false);
        expect(f.commands.filter((c) => c.cmd === "hscan").length).toBe(1);
    });

    // ── failure: Redis unavailable ──────────────────────────────────────────

    it("with Redis down, set then get in one process is a MISS: no per-process store of any kind", async () => {
        process.env.REDIS_URL = `redis://127.0.0.1:${await reservedClosedPort()}`;
        process.env.REDIS_CONNECT_TIMEOUT_MS = "300";
        const { useCache } = await pod();
        const { stream, seen } = spiedStream(["a", "b"]);
        await useCache.set("k", Promise.resolve(entryOf({ value: stream })));
        expect(seen.drained, "a dropped write still drains the stream").toBe(
            true,
        );
        expect(await useCache.get("k", [])).toBeUndefined();
        expect(await useCache.getExpiration(["t"])).toBe(0);
        await useCache.updateTags(["t"]); // dropped, must not throw
        await useCache.refreshTags();
    });

    it("with no REDIS_URL at all it behaves the same way and says so, once", async () => {
        delete process.env.REDIS_URL;
        const warn = console.warn as unknown as ReturnType<typeof jest.fn>;
        const { useCache } = await pod();
        await useCache.set("k", Promise.resolve(entryOf()));
        expect(await useCache.get("k", [])).toBeUndefined();
        await useCache.set("k2", Promise.resolve(entryOf()));
        const mine = warn.mock.calls.filter((c) =>
            String(c[0]).includes("'use cache'"),
        );
        expect(mine.length, "one warning, not one per call").toBe(1);
        expect(String(mine[0]?.[0])).toContain("REDIS_URL");
    });

    it("a connection fault opens the breaker (fail open, never crash)", async () => {
        const f = await startFakeRedis({
            onCommand: (cmd, _args, socket) => {
                if (cmd === "set") socket.destroy();
            },
        });
        fake = f;
        process.env.REDIS_URL = f.url;
        const { useCache } = await pod();
        await useCache.set("boom", Promise.resolve(entryOf()));
        const after = f.received.length;
        // Breaker open: the next calls do not touch the socket.
        expect(await useCache.get("boom", [])).toBeUndefined();
        await useCache.updateTags(["t"]);
        expect(f.received.length).toBe(after);
    });

    it("a client-side validation error never trips the breaker", async () => {
        const f = await withRedis();
        const { useCache } = await pod();
        const counters = () =>
            ((globalThis as Record<symbol, unknown>)[
                Symbol.for("knext.cache.useCache.counters")
            ] ?? {}) as Record<string, number>;
        const invalidBefore = counters().invalid ?? 0;
        // Invalid TTL source, invalid key, invalid timestamp.
        await useCache.set(
            "bad-expire",
            Promise.resolve(entryOf({ expire: Number.NaN })),
        );
        await useCache.set("", Promise.resolve(entryOf()));
        await useCache.set(
            "bad-ts",
            Promise.resolve(entryOf({ timestamp: Number.NaN })),
        );
        expect([...f.strings.keys()].filter((k) => k.includes(":uc:"))).toEqual(
            [],
        );
        // Each was rejected as INVALID (a client-side fault), not silently
        // treated as a dynamic `expire <= 0` entry.
        expect((counters().invalid ?? 0) - invalidBefore).toBe(3);
        // The breaker is closed, so a valid write lands at once.
        await useCache.set("good", Promise.resolve(entryOf()));
        expect(f.strings.has(`${PREFIX}:uc:default:good`)).toBe(true);
    });

    it("a corrupt stored payload is a miss, not a fault: the breaker stays closed", async () => {
        const f = await withRedis();
        f.strings.set(`${PREFIX}:uc:default:corrupt`, "<<<not json>>>");
        const { useCache } = await pod();
        expect(await useCache.get("corrupt", [])).toBeUndefined();
        await useCache.set("ok", Promise.resolve(entryOf()));
        expect(f.strings.has(`${PREFIX}:uc:default:ok`)).toBe(true);
    });

    it("an envelope of another version, or one missing its body, is a miss too", async () => {
        const f = await withRedis();
        const good = {
            v: 1,
            timestamp: Date.now(),
            stale: 1,
            expire: 60,
            revalidate: 30,
            tags: [],
            body: Buffer.from("x").toString("base64"),
        };
        f.strings.set(
            `${PREFIX}:uc:default:future`,
            JSON.stringify({ ...good, v: 99 }),
        );
        f.strings.set(
            `${PREFIX}:uc:default:nobody`,
            JSON.stringify({ ...good, body: undefined }),
        );
        f.strings.set(`${PREFIX}:uc:default:fine`, JSON.stringify(good));
        const { useCache } = await pod();
        expect(await useCache.get("future", [])).toBeUndefined();
        expect(await useCache.get("nobody", [])).toBeUndefined();
        expect(await useCache.get("fine", [])).toBeDefined();
    });

    // ── what it must never do ───────────────────────────────────────────────

    it("never logs the cache key (it can carry per-user arguments)", async () => {
        await withRedis();
        const { useCache } = await pod();
        const secretKey = '["build","fn",{"userId":"u-4242-secret"}]';
        await useCache.set(secretKey, Promise.resolve(entryOf()));
        await useCache.get(secretKey, []);
        const logged = [console.log, console.warn, console.error]
            .flatMap(
                (fn) =>
                    (fn as unknown as ReturnType<typeof jest.fn>).mock.calls,
            )
            .map((c) => c.map(String).join(" "))
            .join("\n");
        expect(logged).not.toContain("u-4242-secret");
    });

    it("counts hits, misses, writes and drops on the process counter surface", async () => {
        await withRedis();
        const { useCache } = await pod();
        const counters = () =>
            ((globalThis as Record<symbol, unknown>)[
                Symbol.for("knext.cache.useCache.counters")
            ] ?? {}) as Record<string, number>;
        const before = { ...counters() };
        await useCache.get("m", []);
        await useCache.set("h", Promise.resolve(entryOf()));
        await useCache.get("h", []);
        const after = counters();
        expect((after.miss ?? 0) - (before.miss ?? 0)).toBe(1);
        expect((after.set ?? 0) - (before.set ?? 0)).toBe(1);
        expect((after.hit ?? 0) - (before.hit ?? 0)).toBe(1);
    });
    // ── hardening: prune race, clock skew, payload ceiling, logging ─────────

    it("a stamp re-written between the prune's HSCAN and its delete survives (conditional delete)", async () => {
        const old = String(Date.now() - 3 * 86_400_000);
        let fresh = "";
        const f = await withRedis({
            // Another pod's invalidation of the SAME tag lands in the window
            // between this pod's HSCAN page and its delete.
            onCommand: (cmd) => {
                if (cmd === "hdel" || cmd === "eval") {
                    fresh = String(Date.now());
                    f.hashes.get(`${PREFIX}:uc:tags`)?.set("e:ancient", fresh);
                }
            },
        });
        f.hashes.set(
            `${PREFIX}:uc:tags`,
            new Map([
                ["e:ancient", old],
                ["s:ancient", old],
            ]),
        );
        const { useCache } = await pod();
        await useCache.updateTags(["x"]);
        const h = f.hashes.get(`${PREFIX}:uc:tags`);
        expect(fresh, "the delete step ran").not.toBe("");
        expect(
            h?.get("e:ancient"),
            "the concurrent invalidation must not be deleted",
        ).toBe(fresh);
        // The field nobody touched is still pruned.
        expect(h?.has("s:ancient")).toBe(false);
    });

    it("a writer whose clock runs AHEAD cannot outlive a later invalidation", async () => {
        await withRedis();
        const writer = await pod();
        await withSkew(5_000, () =>
            writer.useCache.set(
                "ahead",
                Promise.resolve(entryOf({ tags: ["t"], timestamp: nextNow() })),
            ),
        );
        await sleep(20);
        const invalidator = await pod();
        await invalidator.useCache.updateTags(["t"]);
        // A reader whose clock runs behind still sees the stamp as in the past.
        const reader = await pod();
        expect(
            await withSkew(-5_000, () => reader.useCache.get("ahead", [])),
            "written before the invalidation, so it is expired on every pod",
        ).toBeUndefined();
    });

    it("an invalidator whose clock runs BEHIND still expires an earlier entry", async () => {
        await withRedis();
        const writer = await pod();
        await writer.useCache.set(
            "behind",
            Promise.resolve(entryOf({ tags: ["t"], timestamp: nextNow() })),
        );
        await sleep(20);
        const invalidator = await pod();
        await withSkew(-5_000, () => invalidator.useCache.updateTags(["t"]));
        const reader = await pod();
        expect(await reader.useCache.get("behind", [])).toBeUndefined();
    });

    it("an entry written AFTER an invalidation by a pod whose clock runs behind is a hit, in the reader's clock", async () => {
        await withRedis();
        const invalidator = await pod();
        await invalidator.useCache.updateTags(["t"]);
        await sleep(20);
        const writer = await pod();
        await withSkew(-5_000, () =>
            writer.useCache.set(
                "after",
                Promise.resolve(entryOf({ tags: ["t"], timestamp: nextNow() })),
            ),
        );
        // The reader's clock runs AHEAD: what it hands Next must be in ITS clock.
        const reader = await pod();
        const { hit, expiration, readerNow } = await withSkew(
            5_000,
            async () => ({
                hit: await reader.useCache.get("after", []),
                expiration: await reader.useCache.getExpiration(["t"]),
                readerNow: nextNow(),
            }),
        );
        expect(
            hit,
            "newer than the invalidation, so it survives",
        ).toBeDefined();
        // Next discards an entry whose timestamp <= getExpiration(its tags), and
        // ages it against its own clock: both must be in the reader's domain.
        expect(hit?.timestamp ?? 0).toBeGreaterThan(expiration);
        expect(
            Math.abs(readerNow - (hit?.timestamp ?? 0)),
            "the entry's timestamp, in the reader's clock",
        ).toBeLessThan(1_000);
        expect(
            Math.abs(readerNow - expiration),
            "the tag's expiry, in the reader's clock",
        ).toBeLessThan(1_000);
    });

    it("reads the Redis clock once per process, not once per operation", async () => {
        const f = await withRedis();
        const { useCache } = await pod();
        await useCache.set("c", Promise.resolve(entryOf({ tags: ["t"] })));
        for (let i = 0; i < 5; i++) {
            await useCache.get("c", []);
            await useCache.updateTags([`t${i}`]);
            await useCache.getExpiration(["t"]);
        }
        expect(f.commands.filter((c) => c.cmd === "time").length).toBe(1);
    });

    it("skips an entry above the 2 MiB default ceiling, counts it, drains it, and stores one at the ceiling", async () => {
        const f = await withRedis();
        const { useCache } = await pod();
        const before = counters().oversize ?? 0;
        // Chunks keep coming after the one that crosses the ceiling: those must
        // be read too, not just the end-of-stream.
        const { stream, seen } = spiedStream([
            "x".repeat(1024 * 1024),
            "x".repeat(1024 * 1024),
            "x",
            "after-1",
            "after-2",
        ]);
        await useCache.set("big", Promise.resolve(entryOf({ value: stream })));
        expect(f.strings.has(`${PREFIX}:uc:default:big`)).toBe(false);
        expect(f.commands.filter((c) => c.cmd === "set")).toEqual([]);
        expect((counters().oversize ?? 0) - before).toBe(1);
        expect(
            seen.drained,
            "an oversize stream is still read to its end",
        ).toBe(true);
        await useCache.set(
            "at-cap",
            Promise.resolve(entryOf({ body: "x".repeat(2 * 1024 * 1024) })),
        );
        expect(f.strings.has(`${PREFIX}:uc:default:at-cap`)).toBe(true);
    });

    it("KNEXT_USE_CACHE_MAX_ENTRY_BYTES sets the ceiling, and 0 lifts it", async () => {
        const f = await withRedis();
        process.env.KNEXT_USE_CACHE_MAX_ENTRY_BYTES = "1024";
        const { useCache } = await pod();
        await useCache.set(
            "over",
            Promise.resolve(entryOf({ body: "y".repeat(1025) })),
        );
        await useCache.set(
            "at",
            Promise.resolve(entryOf({ body: "y".repeat(1024) })),
        );
        expect(f.strings.has(`${PREFIX}:uc:default:over`)).toBe(false);
        expect(f.strings.has(`${PREFIX}:uc:default:at`)).toBe(true);
        process.env.KNEXT_USE_CACHE_MAX_ENTRY_BYTES = "0";
        await useCache.set(
            "huge",
            Promise.resolve(entryOf({ body: "z".repeat(3 * 1024 * 1024) })),
        );
        expect(f.strings.has(`${PREFIX}:uc:default:huge`)).toBe(true);
    });

    it("an oversize entry never reaches Redis, so a slow large write cannot open the breaker ISR shares", async () => {
        process.env.REDIS_COMMAND_TIMEOUT_MS = "200";
        const f = await withRedis({
            // A large SET that takes longer than the command budget: a slow link
            // or a Redis busy copying megabytes.
            onCommand: async (cmd, args) => {
                if (cmd === "set" && (args[1]?.length ?? 0) > 1_000_000)
                    await sleep(800);
            },
        });
        const { useCache, mod } = await pod();
        await useCache.set(
            "large",
            Promise.resolve(entryOf({ body: "w".repeat(3 * 1024 * 1024) })),
        );
        const isr = new (
            mod.default as new (
                o: object,
            ) => {
                set(k: string, d: unknown, c: unknown): Promise<void>;
            }
        )({});
        await isr.set(
            "/after-large",
            { kind: "APP_PAGE", html: "<p>x</p>", headers: {} },
            { revalidate: 60 },
        );
        expect(
            f.strings.has(`${PREFIX}:cache:/after-large`),
            "the ISR write still lands in Redis: the breaker stayed closed",
        ).toBe(true);
    });

    it("warns about a missing Redis once per process, not once per cache kind", async () => {
        delete process.env.REDIS_URL;
        const warn = console.warn as unknown as ReturnType<typeof jest.fn>;
        const { mod, useCache } = await pod("default");
        const remote = (
            mod.CacheHandler as {
                forUseCache(kind: string): UseCacheHandler;
            }
        ).forUseCache("remote");
        await useCache.set("k", Promise.resolve(entryOf()));
        await remote.set("k", Promise.resolve(entryOf()));
        expect(await remote.get("k", [])).toBeUndefined();
        const outage = warn.mock.calls.filter((c) =>
            String(c[0]).includes("'use cache' entries are not cached"),
        );
        expect(outage.length, "one warning for the process").toBe(1);
    });

    it("a prune failure after a successful tag write is not reported as a tag-update error and keeps the breaker closed", async () => {
        const f = await withRedis({
            errorFor: (cmd) =>
                cmd === "hscan" || cmd === "eval" ? "prune boom" : undefined,
        });
        const error = console.error as unknown as ReturnType<typeof jest.fn>;
        const warn = console.warn as unknown as ReturnType<typeof jest.fn>;
        const { useCache } = await pod();
        await useCache.updateTags(["x"]);
        expect(f.hashes.get(`${PREFIX}:uc:tags`)?.has("e:x")).toBe(true);
        const logged = [...error.mock.calls, ...warn.mock.calls].map((c) =>
            c.map(String).join(" "),
        );
        expect(
            logged.filter((l) => l.includes("updating 'use cache' tags")),
        ).toEqual([]);
        expect(logged.some((l) => /prun/i.test(l))).toBe(true);
        // The breaker the ISR handler shares is still closed.
        await useCache.set("after-prune", Promise.resolve(entryOf()));
        expect(f.strings.has(`${PREFIX}:uc:default:after-prune`)).toBe(true);
    });
});
