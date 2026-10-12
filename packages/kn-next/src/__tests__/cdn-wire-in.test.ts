import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

/**
 * The CDN wire-in of the cache handler (ADR-0068 D5.1, D6, D7).
 *
 * The handler is the ONE place that sees an entry's resolved tags (the header
 * preload cannot read them off the response: Next strips `x-next-cache-tags`
 * in non-minimal mode), and the one place a tag invalidation happens. So it:
 *
 *   1. records each entry's tags into the request-scoped seam the CDN header
 *      preload opens (`globalThis[Symbol.for('knext.core.cdn.requestTags')]`),
 *      on `get` (hit) and `set` (render) — a no-op when the seam is absent;
 *   2. queues a CDN purge from the SINGULAR `revalidateTag`, after the
 *      invalidation, never awaited;
 *   3. starts the first-ready purge once per process per build, never blocking.
 *
 * And with `KNEXT_CDN_PROVIDER` unset none of it may do anything observable.
 *
 * These are the in-process unit tests; `cdn-wire-in-integration.test.ts` runs
 * the real handler in separate "pod" processes against a fake CDN.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";
const SEAM = Symbol.for("knext.core.cdn.requestTags");
const PURGER = Symbol.for("knext.core.cdn.purger");
const here = dirname(fileURLToPath(import.meta.url));
const ADAPTERS = resolve(here, "../adapters");

// biome-ignore lint/suspicious/noExplicitAny: the handler module is untyped plain JS
type Any = any;
type Rec = { kind: string; tags: string[] };

const g = globalThis as Record<symbol, unknown>;

/** A stand-in for the preload's seam: records every call, as the real one would. */
function installSeam(impl?: (r: Rec) => unknown) {
    const calls: Rec[] = [];
    g[SEAM] = {
        record(r: Rec) {
            calls.push({ kind: r.kind, tags: [...r.tags] });
            return impl ? impl(r) : true;
        },
    };
    return calls;
}

/** A stand-in for the process-wide purger `cdn-purge/index.js` hands out. */
function installPurger(
    over: Partial<{
        enqueue: (tags: unknown) => unknown;
        firstReady: (id: string, redis: unknown) => unknown;
    }> = {},
) {
    const enqueued: unknown[] = [];
    const firstReady: { buildId: string; redis: unknown }[] = [];
    g[PURGER] = {
        enqueue:
            over.enqueue ??
            ((tags: unknown) => {
                enqueued.push(tags);
                return { queued: 1 };
            }),
        firstReady:
            over.firstReady ??
            (async (buildId: string, redis: unknown) => {
                firstReady.push({ buildId, redis });
                return { purged: false, reason: "stub" };
            }),
        flush: async () => {},
        status: () => ({ state: "stub" }),
    };
    return { enqueued, firstReady };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("CDN wire-in of the cache handler (ADR-0068)", () => {
    const original = { ...process.env };
    let fake: FakeRedis | undefined;
    let gen = 0;

    beforeEach(() => {
        gen += 1;
        delete g[SEAM];
        delete g[PURGER];
        delete process.env.REDIS_URL;
        delete process.env.KNEXT_CDN_PROVIDER;
        delete process.env.KNEXT_BUILD_ID;
        delete process.env.NEXT_DEPLOYMENT_ID;
        process.env.REDIS_KEY_PREFIX = "cdn-wire";
        // ioredis-shaped behaviour against the fake, whatever runtime runs this.
        process.env.KNEXT_CACHE_REDIS_CLIENT = "ioredis";
        spyOn(console, "error").mockImplementation(() => {});
        spyOn(console, "warn").mockImplementation(() => {});
        spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
        delete g[SEAM];
        delete g[PURGER];
        await fake?.close();
        fake = undefined;
        process.env = { ...original };
        jest.restoreAllMocks();
    });

    async function load(): Promise<Any> {
        return await import(`${CACHE_HANDLER}?cdnwire=${gen}`);
    }

    async function handler(): Promise<Any> {
        const mod = await load();
        return new mod.default({});
    }

    async function withRedis(options = {}) {
        fake = await startFakeRedis(options);
        process.env.REDIS_URL = fake.url;
        return fake;
    }

    const page = (tags: string) => ({
        kind: "APP_PAGE",
        html: "<html>p</html>",
        headers: { "x-next-cache-tags": tags },
    });
    const pageCtx = {
        cacheControl: { revalidate: 60 },
        isRoutePPREnabled: false,
        isFallback: false,
    };

    // ── 1. tag recording ────────────────────────────────────────────────────
    describe("tag recording into the request seam (D5.1)", () => {
        it("set() of an APP_PAGE records its header tags, implicit _N_T_ included, as kind 'page' -- before any await", async () => {
            const calls = installSeam();
            const h = await handler();
            const pending = h.set(
                "/p",
                page("posts,_N_T_/layout,_N_T_/p"),
                pageCtx,
            );
            // Synchronously, before the write's first await: an ISR miss's set
            // racing the first flush is the case condition 8 fails closed on.
            expect(calls).toEqual([
                { kind: "page", tags: ["posts", "_N_T_/layout", "_N_T_/p"] },
            ]);
            await pending;
        });

        it("maps entry kinds onto the seam's kinds: APP_ROUTE -> route, PAGES -> page, FETCH -> fetch", async () => {
            const calls = installSeam();
            const h = await handler();
            await h.set(
                "/r",
                {
                    kind: "APP_ROUTE",
                    body: Buffer.from("x"),
                    status: 200,
                    headers: { "x-next-cache-tags": "_N_T_/r" },
                },
                pageCtx,
            );
            await h.set(
                "/pg",
                {
                    kind: "PAGES",
                    html: "x",
                    pageData: {},
                    headers: { "x-next-cache-tags": "_N_T_/pg" },
                },
                pageCtx,
            );
            await h.set(
                "fetch-key",
                { kind: "FETCH", data: { body: "x" }, revalidate: 60 },
                { tags: ["data-tag"], revalidate: 60 },
            );
            expect(calls).toEqual([
                { kind: "route", tags: ["_N_T_/r"] },
                { kind: "page", tags: ["_N_T_/pg"] },
                { kind: "fetch", tags: ["data-tag"] },
            ]);
        });

        it("records nothing for kinds the edge never caches by tag (IMAGE, REDIRECT), a delete, or a tagless entry", async () => {
            const calls = installSeam();
            const h = await handler();
            await h.set(
                "img",
                {
                    kind: "IMAGE",
                    etag: "e",
                    buffer: Buffer.from("x"),
                    extension: "png",
                },
                { revalidate: 60 },
            );
            await h.set("redir", { kind: "REDIRECT", props: {} }, pageCtx);
            await h.set("/p", null, pageCtx);
            await h.set(
                "/q",
                { kind: "APP_PAGE", html: "q", headers: {} },
                pageCtx,
            );
            expect(calls).toEqual([]);
        });

        it("get() hit records the stored entry's tags (memory store)", async () => {
            const h = await handler();
            await h.set("/p", page("posts,_N_T_/p"), pageCtx);
            const calls = installSeam();
            expect(await h.get("/p", { kind: "APP_PAGE" })).not.toBeNull();
            expect(calls).toEqual([
                { kind: "page", tags: ["posts", "_N_T_/p"] },
            ]);
        });

        it("get() hit records the stored entry's tags (Redis store)", async () => {
            await withRedis();
            const h = await handler();
            await h.set("/p", page("posts,_N_T_/p"), pageCtx);
            const calls = installSeam();
            expect(await h.get("/p", { kind: "APP_PAGE" })).not.toBeNull();
            expect(calls).toEqual([
                { kind: "page", tags: ["posts", "_N_T_/p"] },
            ]);
        });

        it("get() of an entry stored without a tag list (an older writer) records its header tags", async () => {
            const redis = await withRedis();
            const h = await handler();
            redis.strings.set(
                "cdn-wire:cache:/legacy",
                JSON.stringify({
                    value: page("legacy,_N_T_/legacy"),
                    lastModified: Date.now(),
                }),
            );
            const calls = installSeam();
            expect(await h.get("/legacy", { kind: "APP_PAGE" })).not.toBeNull();
            expect(calls).toEqual([
                { kind: "page", tags: ["legacy", "_N_T_/legacy"] },
            ]);
        });

        it("with the seam absent the tag work is skipped entirely, not merely discarded", async () => {
            const h = await handler();
            const reads = { n: 0 };
            const counted = () => {
                const v = page("_N_T_/p");
                const headers = v.headers;
                return Object.defineProperty({ ...v }, "headers", {
                    enumerable: true,
                    get() {
                        reads.n += 1;
                        return headers;
                    },
                });
            };
            await h.set("/a", counted(), pageCtx);
            const absent = reads.n;
            reads.n = 0;
            installSeam();
            await h.set("/b", counted(), pageCtx);
            // One more read of the entry's tags with the seam than without it.
            expect(reads.n).toBe(absent + 1);
        });

        it("get() miss records nothing", async () => {
            const calls = installSeam();
            const h = await handler();
            expect(await h.get("/nothing", { kind: "APP_PAGE" })).toBeNull();
            expect(calls).toEqual([]);
        });

        it("a throwing seam never reaches the request path: set stores, get serves", async () => {
            installSeam(() => {
                throw new Error("seam exploded");
            });
            const h = await handler();
            await h.set("/p", page("_N_T_/p"), pageCtx);
            const hit = await h.get("/p", { kind: "APP_PAGE" });
            expect(hit?.value?.html).toBe("<html>p</html>");
        });

        it("with no seam installed (CDN off) set/get work and the handler never creates one", async () => {
            const h = await handler();
            await h.set("/p", page("_N_T_/p"), pageCtx);
            expect((await h.get("/p", { kind: "APP_PAGE" }))?.value?.html).toBe(
                "<html>p</html>",
            );
            expect(g[SEAM]).toBeUndefined();
        });

        it("the 'use cache' handler records nothing: its tags reach the edge through the page entry (D5.1)", async () => {
            await withRedis();
            const calls = installSeam();
            const mod = await load();
            const uc = mod.CacheHandler.forUseCache("default");
            const body = new ReadableStream({
                start(c) {
                    c.enqueue(new TextEncoder().encode("v"));
                    c.close();
                },
            });
            await uc.set(
                "k",
                Promise.resolve({
                    value: body,
                    tags: ["uc-tag"],
                    stale: 300,
                    timestamp: Date.now(),
                    expire: 3600,
                    revalidate: 900,
                }),
            );
            const hit = await uc.get("k", []);
            expect(hit).toBeDefined();
            expect(calls).toEqual([]);
        });
    });

    // ── 2. purge on revalidateTag ───────────────────────────────────────────
    describe("purge from the singular revalidateTag (D6.2, D6.3)", () => {
        it("enqueues exactly the revalidated tags, once, AFTER the Redis invalidation", async () => {
            const redis = await withRedis();
            const seen: { tags: unknown; entryStillThere: boolean }[] = [];
            installPurger({
                enqueue: (tags) => {
                    seen.push({
                        tags,
                        entryStillThere: redis.strings.has("cdn-wire:cache:/p"),
                    });
                    return { queued: 1 };
                },
            });
            const h = await handler();
            await h.set("/p", page("x,_N_T_/p"), pageCtx);
            expect(redis.strings.has("cdn-wire:cache:/p")).toBe(true);
            await h.revalidateTag("x");
            expect(seen).toEqual([{ tags: ["x"], entryStillThere: false }]);
        });

        it("passes an array of tags through as one enqueue", async () => {
            const { enqueued } = installPurger();
            const h = await handler();
            await h.revalidateTag(["a", "_N_T_/p"]);
            expect(enqueued).toEqual([["a", "_N_T_/p"]]);
        });

        it("is not awaited: a purge that never settles cannot hold revalidateTag open", async () => {
            installPurger({ enqueue: () => new Promise(() => {}) });
            const h = await handler();
            const outcome = await Promise.race([
                h.revalidateTag("x").then(() => "resolved"),
                new Promise((r) => setTimeout(() => r("held"), 500)),
            ]);
            expect(outcome).toBe("resolved");
        });

        it("a throwing purge never reaches the caller", async () => {
            installPurger({
                enqueue: () => {
                    throw new Error("purge exploded");
                },
            });
            const h = await handler();
            await h.set("/p", page("x"), pageCtx);
            await expect(h.revalidateTag("x")).resolves.toBeUndefined();
            expect(await h.get("/p", { kind: "APP_PAGE" })).toBeNull();
        });

        it("a Redis failure mid-loop purges only the tags whose invalidation completed", async () => {
            await withRedis({
                errorFor: (cmd: string, args: string[]) =>
                    cmd === "smembers" && args[0] === "cdn-wire:tag:b"
                        ? "boom"
                        : undefined,
            });
            const { enqueued } = installPurger();
            const h = await handler();
            await h.revalidateTag(["a", "b", "c"]);
            expect(enqueued).toEqual([["a"]]);
        });

        it("a failure before any tag is invalidated purges nothing", async () => {
            await withRedis({
                errorFor: (cmd: string) =>
                    cmd === "smembers" ? "boom" : undefined,
            });
            const { enqueued } = installPurger();
            const h = await handler();
            await h.revalidateTag(["a"]);
            expect(enqueued).toEqual([]);
        });

        it("without Redis (memory fallback) the purge still runs (D6.7)", async () => {
            const { enqueued } = installPurger();
            const h = await handler();
            await h.set("/p", page("x"), pageCtx);
            await h.revalidateTag("x");
            expect(enqueued).toEqual([["x"]]);
        });

        /** Redis configured, then the breaker opened by one faulting command. */
        async function breakerOpen() {
            process.env.REDIS_RETRY_COOLDOWN_MS = "60000";
            let failGets = false;
            await withRedis({
                errorFor: (cmd: string) =>
                    failGets && cmd === "get" ? "boom" : undefined,
            });
            const h = await handler();
            await h.set("/p", page("x,_N_T_/p"), pageCtx);
            failGets = true;
            expect(await h.get("/p", { kind: "APP_PAGE" })).toBeNull();
            failGets = false;
            return h;
        }

        const warned = () =>
            (
                console.warn as unknown as { mock: { calls: unknown[][] } }
            ).mock.calls
                .map((c) => c.map(String).join(" "))
                .filter((l) => l.includes("CDN purge skipped"));

        it("Redis configured but the breaker open: no purge, and the skip is logged when CDN mode is on", async () => {
            process.env.KNEXT_CDN_PROVIDER = "cloudflare";
            const h = await breakerOpen();
            const { enqueued } = installPurger();
            await h.revalidateTag(["x", "_N_T_/p"]);
            // The pod-local invalidation ran, but the shared store was not
            // reached: other pods would refill the edge from stale Redis.
            expect(enqueued).toEqual([]);
            expect(warned()).toHaveLength(1);
            expect(warned()[0]).toContain("tags=2");
        });

        it("breaker open with CDN mode off: no purge and no log line (inert)", async () => {
            const h = await breakerOpen();
            const { enqueued } = installPurger();
            await h.revalidateTag("x");
            expect(enqueued).toEqual([]);
            expect(warned()).toEqual([]);
        });

        it("the 'use cache' updateTags never purges: Next calls the singular handler for the same tags", async () => {
            await withRedis();
            const { enqueued } = installPurger();
            const mod = await load();
            const uc = mod.CacheHandler.forUseCache("default");
            await uc.updateTags(["x"], {});
            await settle();
            expect(enqueued).toEqual([]);
        });

        it("source scan: enqueuePurge is called from exactly one place, the singular #revalidateTag", () => {
            const sources = readdirSync(ADAPTERS, { recursive: true })
                .map(String)
                .filter((f) => /\.(m|c)?js$|\.ts$/.test(f))
                .filter((f) => !f.startsWith("cdn-purge"));
            expect(sources.length).toBeGreaterThan(20);
            const sites: string[] = [];
            for (const f of sources) {
                const text = readFileSync(join(ADAPTERS, f), "utf8")
                    .replace(/\/\*[\s\S]*?\*\//g, "")
                    .replace(/(^|[^:'"`\\])\/\/.*$/gm, "$1");
                for (const _ of text.matchAll(/\benqueuePurge\(/g))
                    sites.push(f);
            }
            expect(sites).toEqual(["cache-handler.js"]);
            // ...and that one site is inside the singular handler's revalidation.
            const src = readFileSync(
                join(ADAPTERS, "cache-handler.js"),
                "utf8",
            );
            const start = src.indexOf("async #revalidateTag(");
            const end = src.indexOf("resetRequestCache()", start);
            expect(start).toBeGreaterThan(0);
            expect(src.slice(start, end)).toMatch(/\bstartCdnPurge\(/);
            expect(src.match(/\bstartCdnPurge\(/g)?.length).toBe(2); // definition + one call
        });
    });

    // ── 3. first-ready purge ────────────────────────────────────────────────
    describe("first-ready purge (D7)", () => {
        it("starts once per process per build, however many handlers Next constructs", async () => {
            process.env.KNEXT_BUILD_ID = "build-1";
            const { firstReady } = installPurger();
            const mod = await load();
            new mod.default({});
            new mod.default({});
            new mod.default({});
            await settle();
            expect(firstReady.map((f) => f.buildId)).toEqual(["build-1"]);
        });

        it("does not start without a build id, and starts once one is known", async () => {
            const { firstReady } = installPurger();
            const mod = await load();
            new mod.default({});
            await settle();
            expect(firstReady).toEqual([]);
            process.env.KNEXT_BUILD_ID = "build-2";
            new mod.default({});
            await settle();
            expect(firstReady.map((f) => f.buildId)).toEqual(["build-2"]);
        });

        it("never blocks: a claim that has not settled leaves the handler fully usable", async () => {
            process.env.KNEXT_BUILD_ID = "build-3";
            let release: (v: unknown) => void = () => {};
            installPurger({
                firstReady: () =>
                    new Promise((r) => {
                        release = r;
                    }),
            });
            const h = await handler();
            await h.set("/p", page("_N_T_/p"), pageCtx);
            expect(await h.get("/p", { kind: "APP_PAGE" })).not.toBeNull();
            // Let it go, so the process-wide drain registry is clean for later cases.
            release({ purged: false });
            await settle();
        });

        it("hands the purger a Redis getter whose claim goes through the handler's connection (SET NX EX)", async () => {
            const redis = await withRedis();
            process.env.KNEXT_BUILD_ID = "build-4";
            const { firstReady } = installPurger();
            await handler();
            await settle();
            expect(firstReady.length).toBe(1);
            const given = firstReady[0]?.redis as Any;
            const client = typeof given === "function" ? await given() : given;
            expect(
                await client.send("SET", [
                    "knext:cdn:purged:p:build-4",
                    "1",
                    "NX",
                    "EX",
                    "604800",
                ]),
            ).toBe("OK");
            expect(
                await client.send("SET", [
                    "knext:cdn:purged:p:build-4",
                    "1",
                    "NX",
                    "EX",
                    "604800",
                ]),
            ).toBeNull();
            expect(redis.ttls.get("knext:cdn:purged:p:build-4")).toBe(604800);
        });

        it("a claim that faults trips the handler's breaker, like any other Redis command", async () => {
            await withRedis({
                errorFor: (cmd: string, args: string[]) =>
                    cmd === "set" && args.some((a) => a.toLowerCase() === "nx")
                        ? "boom"
                        : undefined,
            });
            process.env.KNEXT_BUILD_ID = "build-6";
            const { firstReady } = installPurger();
            const h = await handler();
            await h.set("/p", page("_N_T_/p"), pageCtx);
            expect(await h.get("/p", { kind: "APP_PAGE" })).not.toBeNull();
            await settle();
            const given = firstReady[0]?.redis as Any;
            const client = typeof given === "function" ? await given() : given;
            await expect(
                client.send("SET", [
                    "knext:cdn:purged:p:build-6",
                    "1",
                    "NX",
                    "EX",
                    "604800",
                ]),
            ).rejects.toThrow();
            // Breaker open: the handler fails open to its (empty) memory store.
            expect(await h.get("/p", { kind: "APP_PAGE" })).toBeNull();
        });

        it("hands the purger no client when Redis is not configured (no first-ready purge without Redis)", async () => {
            process.env.KNEXT_BUILD_ID = "build-5";
            const { firstReady } = installPurger();
            await handler();
            await settle();
            expect(firstReady.length).toBe(1);
            const given = firstReady[0]?.redis as Any;
            const client = typeof given === "function" ? await given() : given;
            expect(client ?? null).toBeNull();
            // Never retried: without Redis there is no first-ready purge (D7).
            const mod = await load();
            new mod.default({});
            new mod.default({});
            await settle();
            expect(firstReady.length).toBe(1);
        });

        /**
         * A purger stand-in with the real one's reply contract: it claims through
         * the handler's client and reports `redis_error` on a fault, `no_redis`
         * without a client, and a win or loss once Redis replied.
         */
        function claimingPurger() {
            const attempts: string[] = [];
            installPurger({
                firstReady: async (buildId: string, redis: unknown) => {
                    attempts.push(buildId);
                    const c = (
                        typeof redis === "function" ? await redis() : redis
                    ) as Any;
                    if (!c) return { purged: false, reason: "no_redis" };
                    try {
                        const r = await c.send("SET", [
                            `knext:cdn:purged:p:${buildId}`,
                            "1",
                            "NX",
                            "EX",
                            "604800",
                        ]);
                        return r === "OK"
                            ? { purged: true }
                            : { purged: false, reason: "already_purged" };
                    } catch {
                        return { purged: false, reason: "redis_error" };
                    }
                },
            });
            return attempts;
        }

        const drain = async () => {
            const registry = await import(
                "../adapters/cache-write-registry.js"
            );
            await registry.drainCacheWrites(2000);
            await settle();
        };

        it("a claim that faults is retried on a later construction, then never again once Redis replied", async () => {
            process.env.REDIS_RETRY_COOLDOWN_MS = "50";
            let fail = true;
            const redis = await withRedis({
                errorFor: (cmd: string, args: string[]) =>
                    fail && cmd === "set" && args.includes("NX")
                        ? "boom"
                        : undefined,
            });
            process.env.KNEXT_BUILD_ID = "build-retry";
            const attempts = claimingPurger();
            const mod = await load();
            new mod.default({});
            await drain();
            expect(attempts).toEqual(["build-retry"]);
            expect(redis.strings.has("knext:cdn:purged:p:build-retry")).toBe(
                false,
            );

            fail = false;
            await new Promise((r) => setTimeout(r, 80)); // past the breaker cooldown
            new mod.default({});
            await drain();
            expect(attempts).toEqual(["build-retry", "build-retry"]);
            expect(redis.strings.get("knext:cdn:purged:p:build-retry")).toBe(
                "1",
            );

            // Redis replied: done for this build in this process.
            new mod.default({});
            new mod.default({});
            await drain();
            expect(attempts).toHaveLength(2);
        });

        it("a lost claim (another pod won) is also final", async () => {
            const redis = await withRedis();
            redis.strings.set("knext:cdn:purged:p:build-lost", "1");
            process.env.KNEXT_BUILD_ID = "build-lost";
            const attempts = claimingPurger();
            const mod = await load();
            new mod.default({});
            await drain();
            new mod.default({});
            await drain();
            expect(attempts).toEqual(["build-lost"]);
        });

        it("never retries while the breaker is open (no hammering)", async () => {
            process.env.REDIS_RETRY_COOLDOWN_MS = "60000";
            await withRedis({
                errorFor: (cmd: string, args: string[]) =>
                    cmd === "set" && args.includes("NX") ? "boom" : undefined,
            });
            process.env.KNEXT_BUILD_ID = "build-open";
            const attempts = claimingPurger();
            const mod = await load();
            new mod.default({});
            await drain();
            expect(attempts).toHaveLength(1);
            for (let i = 0; i < 5; i++) new mod.default({});
            await drain();
            expect(attempts).toHaveLength(1);
        });

        it("no Redis configured: the no_redis outcome is final, never retried per request", async () => {
            process.env.KNEXT_BUILD_ID = "build-noredis";
            const attempts = claimingPurger();
            const mod = await load();
            new mod.default({});
            await drain();
            new mod.default({});
            new mod.default({});
            await drain();
            expect(attempts).toEqual(["build-noredis"]);
        });

        it("one attempt in flight at a time: constructions during a pending claim do not start another", async () => {
            await withRedis();
            process.env.KNEXT_BUILD_ID = "build-inflight";
            let release: (v: unknown) => void = () => {};
            let calls = 0;
            installPurger({
                firstReady: () => {
                    calls += 1;
                    return new Promise((r) => {
                        release = r;
                    });
                },
            });
            const mod = await load();
            new mod.default({});
            new mod.default({});
            new mod.default({});
            await settle();
            expect(calls).toBe(1);
            // A retryable outcome frees the slot for the NEXT construction.
            release({ purged: false, reason: "redis_error" });
            await settle();
            new mod.default({});
            await settle();
            expect(calls).toBe(2);
            release({ purged: true });
            await settle();
        });
    });

    // ── 4. inert without a provider ─────────────────────────────────────────
    describe("KNEXT_CDN_PROVIDER unset: inert", () => {
        it("no purge request, no Redis key, no pending purge, no timer held in the drain registry", async () => {
            const redis = await withRedis();
            process.env.KNEXT_BUILD_ID = "build-off";
            const fetchSpy = spyOn(globalThis, "fetch");
            const mod = await load();
            const registry = await import(
                "../adapters/cache-write-registry.js"
            );
            const purge = await import("../adapters/cdn-purge/index.js");

            const h = new mod.default({});
            await h.set("/p", page("x,_N_T_/p"), pageCtx);
            await h.get("/p", { kind: "APP_PAGE" });
            await h.revalidateTag(["x", "_N_T_/p"]);
            await settle();
            await registry.drainCacheWrites(2000);

            expect(fetchSpy).not.toHaveBeenCalled();
            expect(
                [...redis.strings.keys()].filter((k) =>
                    k.startsWith("knext:cdn:"),
                ),
            ).toEqual([]);
            expect(
                redis.commands.filter(
                    (c) =>
                        c.cmd === "set" &&
                        c.args.some((a) => a.toLowerCase() === "nx"),
                ),
            ).toEqual([]);
            expect(purge.getCdnPurger().status()).toMatchObject({
                state: "disabled",
                pending: 0,
            });
            // A queued purge holds a flush timer AND an entry in the drain
            // registry until it is sent; nothing may be left in either.
            expect(registry.inFlightCacheWriteCount()).toBe(0);
            expect(g[SEAM]).toBeUndefined();
        });
    });
});
