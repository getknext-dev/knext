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

// This file asserts IOREDIS-shaped behaviour, same reason as
// cache-handler-sigterm-atomicity.test.ts: under `bun test` the handler would
// otherwise pick Bun's native client, whose shape differs.
process.env.KNEXT_CACHE_REDIS_CLIENT = "ioredis";

/**
 * The defect (rc-blocking): `set()` only indexes `ctx.tags` into the Redis tag
 * sets `revalidateTag`/`revalidatePath` read. For an APP_PAGE/APP_ROUTE write,
 * Next 16.3.5's response-cache calls `cacheHandler.set(key, value, ctx)` with
 * `ctx = { cacheControl, isRoutePPREnabled, isFallback }` — NO `tags` field at
 * all (`response-cache/index.js` ~:295). A page's tags — including the
 * implicit `_N_T_<path>` tag `revalidatePath` targets — live ONLY in
 * `value.headers['x-next-cache-tags']` (`file-system-cache.js` ~:216, the
 * official handler's own source of truth for exactly these three kinds).
 *
 * Effect: `revalidateTag`/`revalidatePath` report success but the tag's
 * key-set in Redis is empty, so the cached page is never deleted and never
 * re-renders. Found live on rc.3 (weekly lane run 36826933632): an
 * `/isr-smoke` page with `revalidate: false` and a `unstable_cache` tag of
 * `isr-smoke` served the stale value 20s after an invalidate POST returned
 * 200.
 */
describe("cache-handler: revalidateTag/revalidatePath via x-next-cache-tags header", () => {
    const original = { ...process.env };
    const PREFIX = "header-tag-app";
    const CACHE_HANDLER = "../adapters/cache-handler.js";

    let fake: FakeRedis | undefined;
    let gen = 0;

    beforeEach(() => {
        gen += 1;
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

    const newHandler = async (): Promise<{
        set: (k: string, d: unknown, c: unknown) => Promise<void>;
        get: (k: string) => Promise<Record<string, unknown> | null>;
        revalidateTag: (t: string | string[]) => Promise<void>;
    }> => {
        const mod = await import(`${CACHE_HANDLER}?headergen=${gen}`);
        return new mod.default({});
    };

    it("revalidateTag invalidates an APP_PAGE entry tagged only via the x-next-cache-tags header", async () => {
        fake = await startFakeRedis();
        process.env.REDIS_URL = fake.url;
        const handler = await newHandler();

        const key = "/isr-smoke";
        const value = {
            kind: "APP_PAGE",
            html: "<html>stale</html>",
            headers: { "x-next-cache-tags": "isr-smoke,_N_T_/isr-smoke" },
        };
        // The real ctx Next 16.3.5 passes for an APP_PAGE write: no `tags`.
        const ctx = {
            cacheControl: { revalidate: false },
            isRoutePPREnabled: false,
            isFallback: false,
        };

        await handler.set(key, value, ctx);
        expect(
            await handler.get(key),
            "sanity: the write must have landed before invalidating it",
        ).not.toBeNull();

        await handler.revalidateTag("isr-smoke");

        expect(
            await handler.get(key),
            "revalidateTag('isr-smoke') must evict the page whose only tag record " +
                "is the x-next-cache-tags header, not ctx.tags",
        ).toBeNull();
    });

    it("revalidatePath invalidates an APP_PAGE entry via its implicit _N_T_ path tag", async () => {
        fake = await startFakeRedis();
        process.env.REDIS_URL = fake.url;
        const handler = await newHandler();

        const key = "/isr-smoke";
        const value = {
            kind: "APP_PAGE",
            html: "<html>stale</html>",
            headers: { "x-next-cache-tags": "_N_T_/isr-smoke" },
        };
        const ctx = {
            cacheControl: { revalidate: false },
            isRoutePPREnabled: false,
            isFallback: false,
        };

        await handler.set(key, value, ctx);
        expect(await handler.get(key)).not.toBeNull();

        // `revalidatePath('/isr-smoke')` is `revalidateTag('_N_T_/isr-smoke')`
        // at the IncrementalCache layer.
        await handler.revalidateTag("_N_T_/isr-smoke");

        expect(await handler.get(key)).toBeNull();
    });

    it("revalidateTag invalidates an APP_ROUTE entry tagged only via the header", async () => {
        fake = await startFakeRedis();
        process.env.REDIS_URL = fake.url;
        const handler = await newHandler();

        const key = "/api/isr-smoke";
        const value = {
            kind: "APP_ROUTE",
            body: Buffer.from("{}"),
            headers: { "x-next-cache-tags": "isr-smoke" },
        };
        const ctx = {
            cacheControl: { revalidate: false },
            isRoutePPREnabled: false,
            isFallback: false,
        };

        await handler.set(key, value, ctx);
        expect(await handler.get(key)).not.toBeNull();

        await handler.revalidateTag("isr-smoke");

        expect(await handler.get(key)).toBeNull();
    });

    it("still works for the data cache (FETCH), which carries tags only on ctx — unchanged behaviour", async () => {
        fake = await startFakeRedis();
        process.env.REDIS_URL = fake.url;
        const handler = await newHandler();

        const key = "fetch:data-key";
        const value = { kind: "FETCH", data: { body: "x" } };
        const ctx = { tags: ["data-tag"], revalidate: 60 };

        await handler.set(key, value, ctx);
        expect(await handler.get(key)).not.toBeNull();

        await handler.revalidateTag("data-tag");

        expect(await handler.get(key)).toBeNull();
    });

    it("a page without the header still writes and invalidates normally via ctx.tags", async () => {
        fake = await startFakeRedis();
        process.env.REDIS_URL = fake.url;
        const handler = await newHandler();

        const key = "/plain";
        const value = { kind: "APP_PAGE", html: "<html>plain</html>" };
        const ctx = { tags: ["plain-tag"], revalidate: 60 };

        await handler.set(key, value, ctx);
        expect(await handler.get(key)).not.toBeNull();

        await handler.revalidateTag("plain-tag");

        expect(await handler.get(key)).toBeNull();
    });
});
