import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";
import { Redis } from "ioredis";
import {
    collapseSweepAllowed,
    escapeGlob,
} from "../adapters/use-cache-handler.js";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

/**
 * Two apps on ONE Redis: app A's outage collapse must never touch app B's keys.
 *
 * Both replay paths bound their backlog at 1000 tags and, past it, COLLAPSE:
 * the ISR handler sweeps `SCAN MATCH <prefix>:cache:*` + `DEL`, the `'use
 * cache'` handler sweeps `<prefix>:uc:*`. The prefix is the only thing scoping
 * that sweep. An app that never set one used to fall back to the literal
 * `kn-next`, so every such app on a shared Redis had the SAME prefix, and one
 * app's collapse deleted every other app's cache, per-user `'use cache'`
 * entries included.
 *
 * Two fixes meet here. The operator now renders a per-app default prefix
 * (`kn-<12 hex>` from namespace/name; its own Go tests), so apps no longer share
 * one by default. And the runtime REFUSES a collapse sweep while its prefix is
 * the bare shared default `kn-next`: it cannot know which keys under it are
 * its own, and deleting another app's cache is worse than leaving its own
 * stale until the entry TTL. The refusal is loud (an error naming the fix).
 *
 * Each "app" is its own evaluation of cache-handler.js with its own env, the
 * way two Knative services are two processes. Run against the fake RESP server
 * always, and against a REAL Redis when KNEXT_REDIS_LIVE_URL is set (the
 * `use-cache-lua-live-redis` CI job; it never reads REDIS_URL and refuses a
 * non-loopback host). On the real Redis the breaker is opened by a genuine
 * server error: a GET on a key holding a hash answers WRONGTYPE.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";
const COOLDOWN_MS = 300;
const BOUND = 1000;
/** Long enough for the breaker to close, the probe to fire and a sweep to finish. */
const SETTLE_MS = COOLDOWN_MS * 4 + 400;
const LEGACY = "kn-next";
// The operator's derived defaults for default/shop and team-b/shop.
const SHOP = "kn-5be479caf0c0";
const SHOP_B = "kn-d8bd7dc33539";

// biome-ignore lint/suspicious/noExplicitAny: the handler module is untyped plain JS
type Any = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const nextNow = () => Math.round(performance.timeOrigin + performance.now());

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
function ucEntry(tags: string[]) {
    return {
        value: new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(enc.encode("cached"));
                c.close();
            },
        }),
        tags,
        stale: 300,
        timestamp: nextNow(),
        expire: 3600,
        revalidate: 900,
    };
}

const counters = () =>
    ((globalThis as Record<symbol, unknown>)[
        Symbol.for("knext.cache.useCache.counters")
    ] ?? {}) as Record<string, number>;

const errorCalls = () =>
    (
        console.error as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((c) => c.map(String).join(" "));

interface Backend {
    url: string;
    /** Make the next GET of `key` fail with a Redis error reply. */
    poison(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    close(): Promise<void>;
}

async function fakeBackend(): Promise<Backend> {
    const poisoned = new Set<string>();
    const fake: FakeRedis = await startFakeRedis({
        errorFor: (cmd, args) =>
            cmd === "get" && poisoned.has(String(args[0]))
                ? "WRONGTYPE Operation against a key holding the wrong kind of value"
                : undefined,
    });
    return {
        url: fake.url,
        poison: async (key) => {
            poisoned.add(key);
        },
        exists: async (key) => fake.strings.has(key),
        close: () => fake.close(),
    };
}

const LIVE_URL = process.env.KNEXT_REDIS_LIVE_URL ?? "";

async function liveBackend(): Promise<Backend> {
    const host = new URL(LIVE_URL).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
        throw new Error(
            `KNEXT_REDIS_LIVE_URL must be a loopback Redis, got ${host}`,
        );
    }
    const admin = new Redis(LIVE_URL, { lazyConnect: true });
    await admin.connect();
    // Start from an empty keyspace for every prefix this file uses.
    for (const prefix of [LEGACY, SHOP, SHOP_B]) {
        let cursor = "0";
        do {
            const [next, keys] = await admin.scan(
                cursor,
                "MATCH",
                `${prefix}:*`,
                "COUNT",
                1000,
            );
            cursor = next;
            if (keys.length > 0) await admin.del(...keys);
        } while (cursor !== "0");
    }
    return {
        url: LIVE_URL,
        // A real server error: GET on a hash is WRONGTYPE.
        poison: async (key) => {
            await admin.hset(key, "f", "v");
        },
        exists: async (key) => (await admin.exists(key)) === 1,
        close: async () => {
            admin.disconnect();
        },
    };
}

const BACKENDS: { name: string; start: () => Promise<Backend> }[] = [
    { name: "fake RESP server", start: fakeBackend },
];
if (LIVE_URL !== "") BACKENDS.push({ name: "real Redis", start: liveBackend });

for (const backend of BACKENDS) {
    describe(`two apps on one Redis: one app's collapse never touches the other's keys (${backend.name})`, () => {
        const original = { ...process.env };
        let redis: Backend | undefined;
        let gen = 0;

        beforeEach(async () => {
            redis = await backend.start();
            process.env.REDIS_URL = redis.url;
            process.env.REDIS_RETRY_COOLDOWN_MS = String(COOLDOWN_MS);
            process.env.KNEXT_CACHE_REDIS_CLIENT = "ioredis";
            delete process.env.KNEXT_CDN_PROVIDER;
            spyOn(console, "error").mockImplementation(() => {});
            spyOn(console, "warn").mockImplementation(() => {});
            spyOn(console, "log").mockImplementation(() => {});
        });

        afterEach(async () => {
            await sleep(COOLDOWN_MS + 50);
            await redis?.close();
            redis = undefined;
            process.env = { ...original };
            jest.restoreAllMocks();
        });

        /** One app process: a fresh module evaluation under `prefix` (undefined = unset). */
        async function app(prefix: string | undefined): Promise<Any> {
            gen += 1;
            if (prefix === undefined) delete process.env.REDIS_KEY_PREFIX;
            else process.env.REDIS_KEY_PREFIX = prefix;
            // Unique per backend too: the same specifier would return the cached
            // module, evaluated under the previous backend's URL and prefix.
            return import(
                `${CACHE_HANDLER}?prefix-isolation=${encodeURIComponent(backend.name)}-${gen}`
            );
        }

        /** Open this app's breaker with one failing GET of `key`. */
        async function openIsrBreaker(h: Any, prefix: string) {
            await redis?.poison(`${prefix}:cache:/boom`);
            expect(await h.get("/boom", { kind: "APP_PAGE" })).toBeNull();
        }
        async function openUcBreaker(h: Any, prefix: string) {
            await redis?.poison(`${prefix}:uc:default:boom`);
            expect(await h.get("boom", [])).toBeUndefined();
        }

        async function isrCollapse(h: Any, prefix: string) {
            await openIsrBreaker(h, prefix);
            await h.revalidateTag(
                Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`),
            );
            await sleep(SETTLE_MS);
        }
        async function ucCollapse(h: Any, prefix: string) {
            await openUcBreaker(h, prefix);
            await h.updateTags(
                Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`),
            );
            await sleep(SETTLE_MS);
        }

        it("ISR: two apps on the unset (shared) default prefix — A's collapse leaves B's entries, and refuses loudly", async () => {
            const b = new (await app(undefined)).default({});
            await b.set("/b", page("b"), pageCtx);
            const a = new (await app(undefined)).default({});
            await a.set("/a", page("a"), pageCtx);
            expect(await redis?.exists(`${LEGACY}:cache:/b`)).toBe(true);

            await isrCollapse(a, LEGACY);

            expect(
                await redis?.exists(`${LEGACY}:cache:/b`),
                "app A's collapse deleted app B's ISR entry",
            ).toBe(true);
            // B still serves it from Redis (a fresh process: no memory tier).
            const bFresh = new (await app(undefined)).default({});
            expect(await bFresh.get("/b", { kind: "APP_PAGE" })).not.toBeNull();
            const refused = errorCalls().filter(
                (m) => m.includes("refus") && m.includes(LEGACY),
            );
            expect(refused.length).toBeGreaterThanOrEqual(1);
        });

        it("ISR: an EXPLICIT REDIS_KEY_PREFIX=kn-next is the shared default too — refused", async () => {
            const b = new (await app(undefined)).default({});
            await b.set("/b", page("b"), pageCtx);
            const a = new (await app(LEGACY)).default({});
            await isrCollapse(a, LEGACY);
            expect(await redis?.exists(`${LEGACY}:cache:/b`)).toBe(true);
        });

        it("ISR: a REDIS_KEY_PREFIX nested under the shared default (kn-next:cache) is refused too", async () => {
            const nested = `${LEGACY}:cache`;
            // A legacy app whose ISR key lands inside the nested prefix's sweep.
            const b = new (await app(undefined)).default({});
            await b.set("cache:/b", page("b"), pageCtx);
            expect(await redis?.exists(`${nested}:cache:/b`)).toBe(true);
            const a = new (await app(nested)).default({});
            await isrCollapse(a, nested);
            expect(
                await redis?.exists(`${nested}:cache:/b`),
                "a collapse under kn-next:cache deleted a legacy app's ISR entry",
            ).toBe(true);
            const refused = errorCalls().filter(
                (m) => m.includes("refus") && m.includes(`'${nested}'`),
            );
            expect(refused.length).toBeGreaterThanOrEqual(1);
        });

        it("ISR control: on distinct per-app prefixes the collapse still runs — A's entries go, B's stay", async () => {
            const b = new (await app(SHOP_B)).default({});
            await b.set("/b", page("b"), pageCtx);
            const a = new (await app(SHOP)).default({});
            await a.set("/a", page("a"), pageCtx);
            await isrCollapse(a, SHOP);
            expect(await redis?.exists(`${SHOP}:cache:/a`)).toBe(false);
            expect(await redis?.exists(`${SHOP_B}:cache:/b`)).toBe(true);
        });

        it("'use cache': two apps on the unset (shared) default prefix — A's collapse leaves B's entries, refused and counted", async () => {
            const b = (await app(undefined)).CacheHandler.forUseCache(
                "default",
            );
            await b.set("bk", Promise.resolve(ucEntry(["b"])));
            const a = (await app(undefined)).CacheHandler.forUseCache(
                "default",
            );
            await a.set("ak", Promise.resolve(ucEntry(["a"])));
            expect(await redis?.exists(`${LEGACY}:uc:default:bk`)).toBe(true);
            const refusedBefore = counters().tagsCollapseRefused ?? 0;

            await ucCollapse(a, LEGACY);

            expect(
                await redis?.exists(`${LEGACY}:uc:default:bk`),
                "app A's collapse deleted app B's 'use cache' entry",
            ).toBe(true);
            const bFresh = (await app(undefined)).CacheHandler.forUseCache(
                "default",
            );
            expect(await bFresh.get("bk", [])).toBeDefined();
            expect(
                (counters().tagsCollapseRefused ?? 0) - refusedBefore,
            ).toBeGreaterThanOrEqual(1);
            const refused = errorCalls().filter(
                (m) => m.includes("refus") && m.includes(LEGACY),
            );
            expect(refused.length).toBeGreaterThanOrEqual(1);
        });

        it("'use cache' control: on distinct per-app prefixes the collapse still runs — A's entries go, B's stay", async () => {
            const b = (await app(SHOP_B)).CacheHandler.forUseCache("default");
            await b.set("bk", Promise.resolve(ucEntry(["b"])));
            const a = (await app(SHOP)).CacheHandler.forUseCache("default");
            await a.set("ak", Promise.resolve(ucEntry(["a"])));
            await ucCollapse(a, SHOP);
            expect(await redis?.exists(`${SHOP}:uc:default:ak`)).toBe(false);
            expect(await redis?.exists(`${SHOP_B}:uc:default:bk`)).toBe(true);
        });
    });
}

describe("the sweep's prefix rules, in lockstep with the operator's finalizer", () => {
    // The operator's cleanup pattern pins the same vector
    // (TestRedisKeyPrefix_GlobEscapeVector, redis_key_prefix_test.go).
    it("escapeGlob escapes * ? [ ] and the backslash, nothing else", () => {
        expect(escapeGlob("a*b?c[d]e\\f:g-h")).toBe(
            "a\\*b\\?c\\[d\\]e\\\\f:g-h",
        );
    });

    it("refuses the shared default and any prefix nested under it; allows the rest", () => {
        for (const p of ["", LEGACY, `${LEGACY}:cache`, `${LEGACY}:uc`]) {
            expect(collapseSweepAllowed(p), `prefix '${p}'`).toBe(false);
        }
        // Escaped, a glob-looking prefix sweeps only its own literal keys.
        for (const p of [SHOP, "kn-nextapp", "kn-nex?", "kn-*", "shop"]) {
            expect(collapseSweepAllowed(p), `prefix '${p}'`).toBe(true);
        }
    });
});
