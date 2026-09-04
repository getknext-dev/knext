/**
 * The ISR cache must survive an IDLE Redis connection (#886).
 *
 * ## The live failure, and why it was misattributed
 *
 * #886 reports that `/knext-smoke/isr` "MISSes twice and is never SET" under the
 * vinext build, and concludes that vinext drops `export const revalidate`. That
 * conclusion is WRONG, and it was disproved by measurement rather than by
 * reading: booting `apps/file-manager/.output/server/index.mjs` under bun with
 * `NEXT_PRIVATE_DEBUG_CACHE=1` shows vinext honouring the route segment config
 * exactly as Next.js does —
 *
 *   [Cache] MISS   app:…:/knext-smoke/isr:html
 *   [vinext] ISR: MISS (no cache entry) /knext-smoke/isr
 *   [Cache] SET    app:…:/knext-smoke/isr:html
 *   [Cache] SET    app:…:/knext-smoke/isr:rsc
 *   [vinext] ISR: HTML cache written …
 *   [Cache] HIT    app:…:/knext-smoke/isr:html
 *   [vinext] ISR: HIT (HTML) /knext-smoke/isr
 *
 * The same run against a REAL Redis instead interleaves that with
 *
 *   [CacheHandler] Redis unhealthy, failing open: Connection has failed
 *   [Cache] MISS app:…:/knext-smoke/isr:html (redis)
 *   [Cache] SET  app:…:/knext-smoke/isr:html (memory)
 *
 * — which is #886's evidence table exactly: the MISSes are recorded against the
 * Redis path while the SETs land in the in-memory fallback, so the Redis event
 * log shows `MISS × 2, SET × 0` for that key. Two requests either side of a trip
 * are served by two DIFFERENT backends and render two different values, which is
 * what compat-smoke check (k) reports as "the route is not being cached at all".
 *
 * ## The actual defect
 *
 * `bunRedisClient` passed `idleTimeout: COMMAND_TIMEOUT_MS` to Bun's native
 * client on the belief that it was the per-command budget ioredis's
 * `commandTimeout` provides. It is not: Bun's `idleTimeout` is an IDLE-CONNECTION
 * REAPER. Measured on bun 1.3.5 against redis:7-alpine, `idleTimeout: 2000`:
 *
 *   after 3000 ms idle  → OK
 *   after 5000 ms idle  → ERR_REDIS_CONNECTION_CLOSED ("Connection has failed")
 *   after 11000 ms idle → ERR_REDIS_CONNECTION_CLOSED
 *
 * and with the option omitted entirely, both gaps succeed. Worse, `client.connected`
 * still reads `true` across the reap, so `waitForNativeReady`'s fast path hands
 * back a dead socket and the failure arrives as a command error.
 *
 * A cache handler whose connection dies after two idle seconds is broken for
 * exactly the workload knext exists to serve: a scale-to-zero pod sees gaps far
 * longer than any command budget.
 *
 * ## What this asserts — both halves
 *
 * Removing the reaper must not silently remove the budget it was mistaken for.
 * So this pins BOTH: that the native client is given no idle reaper, AND that a
 * native command really is bounded by `REDIS_COMMAND_TIMEOUT_MS`.
 */
import { describe, expect, it } from "bun:test";

async function freshModule(): Promise<{
    __nativeClientOptions: () => Record<string, unknown>;
    __budgetNativeClient: <T extends object>(client: T) => T;
}> {
    // A query suffix makes a DISTINCT module key, which is how these suites get a
    // clean module instance — bun has no registry reset.
    return (await import(
        `../adapters/cache-handler.js?idle=${Math.random()}`
    )) as never;
}

describe("Bun native Redis client: idle connection", () => {
    it("is given no idle reaper — the connection must outlive a scale-to-zero gap", async () => {
        const { __nativeClientOptions } = await freshModule();
        const options = __nativeClientOptions();
        // 0 is Bun's "never reap". `undefined` would inherit Bun's own default,
        // which is not ours to assume, so the option must be stated explicitly.
        expect(
            options.idleTimeout,
            "Bun's `idleTimeout` reaps an IDLE CONNECTION; it is not a command budget",
        ).toBe(0);
    });

    it("still bounds a single command, so removing the reaper does not remove the budget", async () => {
        process.env.REDIS_COMMAND_TIMEOUT_MS = "150";
        try {
            const { __budgetNativeClient } = await freshModule();
            // A command that never settles — the established-but-dead socket the
            // old `idleTimeout` was believed to cover.
            const hung = __budgetNativeClient({
                get: (_key?: unknown) => new Promise(() => {}),
            });
            const started = Date.now();
            await expect(hung.get("k")).rejects.toThrow();
            expect(
                Date.now() - started,
                "a hung command must not outlive REDIS_COMMAND_TIMEOUT_MS",
            ).toBeLessThan(2000);
        } finally {
            delete process.env.REDIS_COMMAND_TIMEOUT_MS;
        }
    });

    it("does not budget `connect`, which has its own (longer) connection timeout", async () => {
        process.env.REDIS_COMMAND_TIMEOUT_MS = "50";
        process.env.REDIS_CONNECT_TIMEOUT_MS = "5000";
        try {
            const { __budgetNativeClient } = await freshModule();
            let resolveConnect: () => void = () => {};
            const client = __budgetNativeClient({
                connect: () =>
                    new Promise<void>((r) => {
                        resolveConnect = r;
                    }),
            });
            const pending = client.connect();
            await Bun.sleep(200); // well past the 50ms command budget
            resolveConnect();
            // Rejecting here would mean the command budget had been applied to the
            // handshake, turning a slow connect into a hard failure.
            await pending;
        } finally {
            delete process.env.REDIS_COMMAND_TIMEOUT_MS;
            delete process.env.REDIS_CONNECT_TIMEOUT_MS;
        }
    });

    it("invokes every method on the REAL client, so Bun's receiver brand-check passes", async () => {
        // Measured, not hypothetical: an earlier revision returned the raw
        // function for the unbudgeted `connect`, so it ran with the proxy as its
        // receiver and Bun answered "Expected this to be instanceof RedisClient".
        // That is a hard failure on the handshake — the cache never reaches Redis
        // at all, which is a worse outage than the one being fixed.
        const { __budgetNativeClient } = await freshModule();
        const seen: unknown[] = [];
        const target = {
            connect() {
                seen.push(this);
                return Promise.resolve();
            },
            get(_key?: unknown) {
                seen.push(this);
                return Promise.resolve("v");
            },
        };
        const client = __budgetNativeClient(target);
        await client.connect();
        await client.get("k");
        expect(seen, "both receivers must be the real client").toEqual([
            target,
            target,
        ]);
    });

    it("passes non-promise property reads straight through", async () => {
        const { __budgetNativeClient } = await freshModule();
        const client = __budgetNativeClient({
            connected: true,
            onclose: null as null | (() => void),
        });
        expect(client.connected).toBe(true);
        // `getRedis` assigns `native.onclose = …`; a wrapper that swallowed writes
        // would silently drop the only error channel the native client has.
        client.onclose = () => {};
        expect(typeof client.onclose).toBe("function");
    });
});
