/**
 * The ISR contract the handler never implemented: stale-while-revalidate (#886).
 *
 * ## What was actually wrong
 *
 * #886 blames vinext for dropping `export const revalidate`. Measured against
 * the built app, vinext propagates it correctly. The gap is on knext's side, and
 * it is the whole of ISR's second half:
 *
 *  - `set` wrote the Redis entry with `EX <revalidate>`, so a `revalidate = 1`
 *    page was DELETED from Redis one second after it was written. `revalidate`
 *    is when an entry becomes STALE, not when it ceases to exist — Next.js and
 *    vinext both keep serving it while a background render replaces it. With the
 *    entry evicted there is nothing to serve stale, so every request past the
 *    window is a cold MISS that re-renders.
 *  - `get` returned the stored entry unchanged. vinext's cache contract reads
 *    `cacheState` off that result (`isr-cache.js` → `isrGet`: `"expired"` /
 *    `"stale"` / absent) and its own default handler computes it from
 *    `revalidateAt` / `expireAt` (`shims/cache-handler.js:92-110`). knext's
 *    handler set neither field, so EVERY hit read as fresh and the background
 *    regeneration path was unreachable.
 *
 * Together those are #886's headline symptom: two requests a few milliseconds
 * apart both MISS (the first's `waitUntil` write has not landed yet), each
 * renders a different value, and compat-smoke check (k) reports "the route is
 * not being cached at all".
 *
 * ## What this asserts
 *
 * The three states, on the path that needs no Redis, plus the TTL rule that made
 * the stale state unreachable on the path that does.
 */
import { describe, expect, it } from "bun:test";

async function freshHandler(): Promise<{
    handler: {
        get: (k: string) => Promise<Record<string, unknown> | null>;
        set: (k: string, d: unknown, c: unknown) => Promise<void> | void;
    };
    redisTtlSeconds: (ctx: unknown) => number | null;
}> {
    delete process.env.REDIS_URL;
    const mod = (await import(
        `../adapters/cache-handler.js?isr=${Math.random()}`
    )) as {
        default: new () => never;
        __redisTtlSeconds: (ctx: unknown) => number | null;
    };
    return {
        handler: new mod.default() as never,
        redisTtlSeconds: mod.__redisTtlSeconds,
    };
}

const ONE_SECOND_ROUTE = {
    revalidate: 1,
    cacheControl: { revalidate: 1 },
    tags: [],
};

describe("ISR stale-while-revalidate", () => {
    it("reports a just-written entry as fresh", async () => {
        const { handler } = await freshHandler();
        await handler.set("isr-fresh", { kind: "APP_PAGE" }, ONE_SECOND_ROUTE);
        const hit = await handler.get("isr-fresh");
        expect(hit).not.toBeNull();
        expect(
            hit?.cacheState,
            "absent cacheState is vinext's encoding of FRESH",
        ).toBeUndefined();
    });

    it("keeps the entry and reports it STALE once the revalidate window passes", async () => {
        const { handler } = await freshHandler();
        await handler.set("isr-stale", { kind: "APP_PAGE" }, ONE_SECOND_ROUTE);
        await Bun.sleep(1100);
        const hit = await handler.get("isr-stale");
        // Both halves: it must still BE there (the stale body is what gets
        // served) and it must be LABELLED stale (or nothing regenerates).
        expect(hit, "a stale entry is retained, not evicted").not.toBeNull();
        expect(hit?.value).toBeTruthy();
        expect(hit?.cacheState).toBe("stale");
    });

    it("reports EXPIRED past the expire window", async () => {
        const { handler } = await freshHandler();
        await handler.set(
            "isr-expired",
            { kind: "APP_PAGE" },
            { revalidate: 1, cacheControl: { revalidate: 1, expire: 1 } },
        );
        await Bun.sleep(1100);
        const hit = await handler.get("isr-expired");
        expect(hit?.cacheState).toBe("expired");
    });

    describe("the Redis TTL that made STALE unreachable", () => {
        it("is not the revalidate window", async () => {
            const { redisTtlSeconds } = await freshHandler();
            expect(
                redisTtlSeconds(ONE_SECOND_ROUTE),
                "EX <revalidate> evicts the entry exactly when it should go stale",
            ).not.toBe(1);
        });

        it("is the expire window when the render claimed one", async () => {
            const { redisTtlSeconds } = await freshHandler();
            expect(
                redisTtlSeconds({
                    revalidate: 1,
                    cacheControl: { revalidate: 1, expire: 120 },
                }),
            ).toBe(120);
        });

        it("never evicts sooner than the revalidate window even for a long one", async () => {
            const { redisTtlSeconds } = await freshHandler();
            const revalidate = 7200; // longer than the old 3600 default
            const ttl = redisTtlSeconds({
                revalidate,
                cacheControl: { revalidate },
            });
            expect(ttl).not.toBeNull();
            expect(ttl as number).toBeGreaterThanOrEqual(revalidate);
        });
    });
});

/**
 * The same two properties, on the REDIS path.
 *
 * Kept as its own describe because the distinction is what a mutation run
 * exposed: asserting `__redisTtlSeconds` proves the function, not that `set`
 * CALLS it, and the in-memory cases above never touch the Redis read at all.
 * Both Redis-path call sites survived mutation while the suite stayed green.
 */
describe("ISR stale-while-revalidate — the Redis path", () => {
    /** A native-shaped client (no `.on`) recording the commands it receives. */
    function fakeNativeClient(stored: string | null = null) {
        const sent: string[][] = [];
        return {
            sent,
            client: {
                connected: true,
                async connect() {},
                async get() {
                    return stored;
                },
                async send(command: string, args: string[] = []) {
                    sent.push([command, ...args]);
                    return "OK";
                },
            },
        };
    }

    async function redisBackedHandler(stored: string | null = null) {
        const mod = (await import(
            `../adapters/cache-handler.js?redisisr=${Math.random()}`
        )) as {
            default: new () => {
                get: (k: string) => Promise<Record<string, unknown> | null>;
                set: (k: string, d: unknown, c: unknown) => Promise<void>;
            };
            __setRedisClientForTests: (c: unknown) => void;
        };
        const fake = fakeNativeClient(stored);
        const handler = new mod.default();
        mod.__setRedisClientForTests(fake.client);
        return { handler, sent: fake.sent };
    }

    it("does not write the entry with EX <revalidate>", async () => {
        const { handler, sent } = await redisBackedHandler();
        await handler.set(
            "isr-redis-ttl",
            { kind: "APP_PAGE" },
            ONE_SECOND_ROUTE,
        );
        const set = sent.find((cmd) => cmd[0] === "SET");
        expect(
            set,
            `no SET was issued — commands were ${JSON.stringify(sent)}`,
        ).toBeTruthy();
        const ex = (set as string[])[(set as string[]).indexOf("EX") + 1];
        expect(
            ex,
            "EX <revalidate> evicts the entry exactly when it should go stale",
        ).not.toBe("1");
        expect(Number(ex)).toBeGreaterThan(1);
    });

    it("labels a read past the revalidate window STALE", async () => {
        const stored = JSON.stringify({
            value: { kind: "APP_PAGE" },
            lastModified: Date.now() - 5000,
            tags: [],
            cacheControl: { revalidate: 1 },
        });
        const { handler } = await redisBackedHandler(stored);
        const hit = await handler.get("isr-redis-stale");
        expect(hit, "the entry is retained, not evicted").not.toBeNull();
        expect(hit?.cacheState).toBe("stale");
    });

    it("labels a read inside the revalidate window fresh", async () => {
        const stored = JSON.stringify({
            value: { kind: "APP_PAGE" },
            lastModified: Date.now(),
            tags: [],
            cacheControl: { revalidate: 60 },
        });
        const { handler } = await redisBackedHandler(stored);
        const hit = await handler.get("isr-redis-fresh");
        expect(hit?.cacheState).toBeUndefined();
    });
});
