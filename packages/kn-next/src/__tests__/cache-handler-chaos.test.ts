import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1 data-plane resilience — CHAOS test (CI-runnable, no live Redis).
 *
 * The cache-handler is the ISR/data-cache surface. Its degradation contract is
 * the load-bearing reliability property:
 *
 *   - Redis DOWN  → the handler must FAIL OPEN: `get` returns null (a MISS that
 *     Next.js re-renders from origin), `set` does not throw, and nothing crashes
 *     the process. A dead cache must degrade to origin-render, never take the app
 *     down. (CLAUDE.md §9 — "cache-handler fails open to origin-render when Redis
 *     is down".)
 *
 * Until now this was only verified by READING the code. This test PROVES it by
 * pointing the handler at a dead Redis port (a closed TCP port — connection is
 * refused on every attempt) and exercising the real ioredis client path.
 *
 * cache-handler.js reads REDIS_URL at module load and lazily connects, so each
 * case resets the module registry and re-imports with a fresh environment.
 */
describe("cache-handler chaos: Redis DOWN fails OPEN", () => {
    const original = { ...process.env };

    // A port in the high range that nothing in CI listens on. Connections are
    // refused immediately, simulating a dead Redis without needing a fault proxy.
    const DEAD_REDIS_URL = "redis://127.0.0.1:6390";

    // Non-literal specifier: cache-handler.js is a plain-JS runtime shim with no
    // type declarations; a variable import avoids tsc's implicit-any on the module.
    const CACHE_HANDLER: string = "../adapters/cache-handler.js";

    beforeEach(() => {
        vi.resetModules();
        process.env.REDIS_URL = DEAD_REDIS_URL;
        process.env.REDIS_KEY_PREFIX = "chaos-app";
        // Silence the expected connection-error noise so the suite output is clean.
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        process.env = { ...original };
        vi.restoreAllMocks();
    });

    it("get() on a dead Redis returns null (MISS → origin render), never throws", async () => {
        const mod = await import(CACHE_HANDLER);
        const CacheHandler = mod.default;
        const handler = new CacheHandler({});

        // Must resolve to null (a cache MISS) rather than reject/hang.
        const result = await handler.get("/some/isr/page");
        expect(result).toBeNull();
    });

    it("set() on a dead Redis does not throw (write is best-effort)", async () => {
        const mod = await import(CACHE_HANDLER);
        const CacheHandler = mod.default;
        const handler = new CacheHandler({});

        await expect(
            handler.set(
                "/some/isr/page",
                { value: { kind: "PAGE" }, rscData: Buffer.from("rsc") },
                { revalidate: 60, tags: ["t1"] },
            ),
        ).resolves.toBeUndefined();
    });

    it("revalidateTag() on a dead Redis does not throw", async () => {
        const mod = await import(CACHE_HANDLER);
        const CacheHandler = mod.default;
        const handler = new CacheHandler({});

        await expect(handler.revalidateTag(["t1"])).resolves.toBeUndefined();
    });

    it("a get→set→get cycle on a dead Redis never crashes (fail-open via in-memory fallback)", async () => {
        const mod = await import(CACHE_HANDLER);
        const CacheHandler = mod.default;
        const handler = new CacheHandler({});

        // First read is a cold MISS (empty in-memory fallback) — and crucially it
        // does NOT reject or hang: a dead Redis must degrade to origin render.
        const before = await handler.get("k");
        expect(before).toBeNull();

        // Best-effort write does not throw even though Redis is unreachable. The
        // handler falls back to the in-memory Map (spec: "in-memory fallback").
        await expect(
            handler.set("k", { value: { kind: "PAGE" } }, { revalidate: 30 }),
        ).resolves.toBeUndefined();

        // The whole cycle completed without an unhandled rejection / crash. The
        // in-memory fallback may now serve this pod (that is the documented
        // fail-OPEN behavior); the load-bearing guarantee is "no throw, no crash".
        const after = await handler.get("k");
        expect(after === null || typeof after === "object").toBe(true);
    });
});
