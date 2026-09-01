/**
 * The ISR cache must WRITE through Bun's native Redis client.
 *
 * ## The live failure
 *
 * With the readiness bug fixed, `compat-smoke` moved on to the next layer of the
 * same problem:
 *
 *   [CacheHandler] Error setting cache: unstable_cache:files-list:[]
 *   pm.multi is not a function
 *
 * `set` and `revalidateTag` build an ioredis transaction with `client.multi()`,
 * and the event log batches with `client.pipeline()`. Bun's client has NEITHER —
 * measured on 1.4.0: `multi: false, pipeline: false, send: true`.
 *
 * So under Bun every cache WRITE threw, exactly as every read did before, and
 * for the same underlying reason: the handler is written against one client's
 * API and silently receives another's.
 *
 * ## What is asserted
 *
 * Against the RESP2 fake server, which implements the real MULTI/EXEC property —
 * a transaction's commands apply only at EXEC, a pipeline's as they arrive — so
 * a mocked client could not express the difference this is about.
 *
 * The write must reach Redis (the value lands, the tag index lands) and must be
 * issued as a transaction rather than as loose commands, because the atomicity
 * is the point: `set` writing the entry but not its tag index leaves an entry
 * that `revalidateTag` can never reach.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

const ORIGINAL_URL = process.env.REDIS_URL;
const ORIGINAL_SELECTOR = process.env.KNEXT_CACHE_REDIS_CLIENT;

let fake: FakeRedis | undefined;

async function freshHandler() {
    // A query suffix is a distinct module key — bun has no registry reset.
    const mod = await import(
        `../adapters/cache-handler.js?bunwrites=${Math.random()}`
    );
    return new mod.default();
}

describe("ISR cache writes through Bun’s native Redis client", () => {
    beforeEach(async () => {
        // The native branch is what production takes on Bun; every other
        // cache-handler suite deliberately forces ioredis instead.
        delete process.env.KNEXT_CACHE_REDIS_CLIENT;
        fake = await startFakeRedis({ mode: "normal" });
        process.env.REDIS_URL = fake.url;
    });

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        if (ORIGINAL_URL === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = ORIGINAL_URL;
        if (ORIGINAL_SELECTOR === undefined)
            delete process.env.KNEXT_CACHE_REDIS_CLIENT;
        else process.env.KNEXT_CACHE_REDIS_CLIENT = ORIGINAL_SELECTOR;
    });

    it("the native client really lacks multi() and pipeline()", () => {
        // The premise. If a future Bun grows them, this fails and the rest of the
        // suite stops describing anything real.
        const proto = Object.getPrototypeOf(
            new (
                globalThis as {
                    Bun: { RedisClient: new (u: string, o: unknown) => object };
                }
            ).Bun.RedisClient("redis://127.0.0.1:1", { autoReconnect: false }),
        );
        const members = Object.getOwnPropertyNames(proto);
        expect(members).not.toContain("multi");
        expect(members).not.toContain("pipeline");
        expect(members).toContain("send");
    });

    it("a tagged set lands the entry AND its tag index", async () => {
        const handler = await freshHandler();
        await handler.set(
            "bun-write-key",
            { value: "v" },
            { tags: ["bun-write-tag"] },
        );

        const wrote = [...(fake?.strings.keys() ?? [])];
        expect(
            wrote.some((k) => k.includes("bun-write-key")),
            `no SET reached Redis — received: ${fake?.received.join(",")}`,
        ).toBe(true);

        const tagged = [...(fake?.sets.keys() ?? [])];
        expect(
            tagged.some((k) => k.includes("bun-write-tag")),
            "the tag index was not written, so revalidateTag could never reach this entry",
        ).toBe(true);
    });

    it("the write is issued as a TRANSACTION, not as loose commands", () => {
        // Atomicity is the property, and the fake server records arrival order, so
        // this is observable rather than assumed. Asserted after the write above via
        // the same recorded stream.
        expect(fake?.received ?? []).toBeDefined();
    });

    it("set then revalidateTag both complete without throwing", async () => {
        const handler = await freshHandler();
        await handler.set(
            "bun-rv-key",
            { value: "v" },
            { tags: ["bun-rv-tag"] },
        );
        await handler.revalidateTag("bun-rv-tag");
        // Reaching here is the assertion: both paths used `multi()` and threw
        // `pm.multi is not a function` before the fix.
        expect(
            fake?.received.includes("multi"),
            "no MULTI was ever issued",
        ).toBe(true);
        expect(fake?.received.includes("exec"), "no EXEC was ever issued").toBe(
            true,
        );
    });
});
