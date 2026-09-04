/**
 * The ISR cache must survive Bun's NATIVE Redis client.
 *
 * ## The live failure
 *
 * `compat-smoke` fails on every ISR read and write:
 *
 *   [vinext] ISR cache read error: The export is not a function …
 *   TypeError: sm.on is not a function. (In 'sm.on("ready", mm)', 'sm.on' is undefined)
 *
 * `getRedis()` returns `Bun.RedisClient` when one is available, and that client
 * has NO EventEmitter surface — measured, not assumed:
 *
 *   status: undefined   on: undefined   removeListener: undefined
 *   connected: boolean  connect: function
 *
 * `ensureReady` then does `client.status === 'ready'` (undefined, so it falls
 * through) and hands the client to `waitForReady`, which is written entirely
 * against ioredis: `instrumentConnectTiming(client)` calls `client.on('ready',
 * …)` and throws.
 *
 * So under Bun the cache does not degrade — it throws on every operation. The
 * in-memory fallback that exists precisely for an unavailable Redis is never
 * reached, because the failure is a TypeError rather than a connection error.
 *
 * ## Why nothing caught it
 *
 * Every existing cache-handler suite asserts IOREDIS-shaped behaviour — two of
 * them say so in their own headers — and they force that branch. Nothing
 * exercised the branch `getRedis()` actually takes when running on Bun, which is
 * the branch production uses.
 *
 * ## What this asserts
 *
 * The contract the handler already documents for an unreachable Redis: reads
 * return a miss and writes are dropped, quietly, without throwing. A TypeError
 * from the client shape violates that just as surely as a crash would.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer } from "node:net";

/** A port nothing is listening on — bound, then released. */
async function reservedClosedPort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    return port;
}

const ORIGINAL_URL = process.env.REDIS_URL;
const ORIGINAL_SELECTOR = process.env.KNEXT_CACHE_REDIS_CLIENT;

async function freshHandler() {
    // A query suffix makes a DISTINCT module key, which is how this suite gets a
    // clean module instance — bun has no registry reset.
    const mod = await import(
        `../adapters/cache-handler.js?bunnative=${Math.random()}`
    );
    return new mod.default();
}

describe("ISR cache with Bun’s native Redis client", () => {
    beforeEach(() => {
        // Force the native branch: this is the shape production takes on Bun, and
        // the one every other cache-handler suite deliberately avoids.
        process.env.KNEXT_CACHE_REDIS_CLIENT = undefined;
        delete process.env.KNEXT_CACHE_REDIS_CLIENT;
    });

    afterEach(() => {
        if (ORIGINAL_URL === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = ORIGINAL_URL;
        if (ORIGINAL_SELECTOR === undefined)
            delete process.env.KNEXT_CACHE_REDIS_CLIENT;
        else process.env.KNEXT_CACHE_REDIS_CLIENT = ORIGINAL_SELECTOR;
    });

    it("is running on a Bun whose native client has no EventEmitter surface", () => {
        // The premise, asserted rather than assumed. If a future Bun grows `.on`,
        // this fails and the tests below stop describing anything real.
        const B = (globalThis as { Bun?: { RedisClient?: unknown } }).Bun;
        expect(
            typeof B?.RedisClient,
            "this suite requires Bun.RedisClient",
        ).toBe("function");
        const client = new (
            B as {
                RedisClient: new (
                    u: string,
                    o: unknown,
                ) => Record<string, unknown>;
            }
        ).RedisClient("redis://127.0.0.1:1", { autoReconnect: false });
        expect(typeof client.on, "Bun’s client must still lack `.on`").toBe(
            "undefined",
        );
        expect(typeof client.connected).toBe("boolean");
    });

    it("a read against an unreachable Redis returns a miss, it does not throw", async () => {
        process.env.REDIS_URL = `redis://127.0.0.1:${await reservedClosedPort()}`;
        const handler = await freshHandler();
        // The bug surfaces as `TypeError: client.on is not a function`, which is a
        // REJECTION rather than a miss — so asserting "resolves" is the assertion.
        const hit = await handler.get("bun-native-read");
        expect(hit, "an unreachable Redis is a miss, not a crash").toBeNull();
    });

    it("a write against an unreachable Redis is dropped, it does not throw", async () => {
        process.env.REDIS_URL = `redis://127.0.0.1:${await reservedClosedPort()}`;
        const handler = await freshHandler();
        await handler.set("bun-native-write", { value: "x" }, {});
        // Reaching here at all is the assertion: `set` must not reject.
        expect(true).toBe(true);
    });
});
