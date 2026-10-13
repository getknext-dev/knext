import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";

/**
 * The cache handler's CDN calls must never fail a cache operation, even if the
 * purge module itself breaks its "total" contract and throws synchronously
 * (ADR-0068 D6.3: a purge never reaches the request path).
 *
 * `cdn-purge/index.js` already catches internally, so this replaces the module
 * outright: only then is the handler's OWN guard what stands between a throw
 * and the caller. Its own file, because a module mock lasts for the process
 * (the runner gives each file one).
 */

/** How the fake `firstReadyPurge` misbehaves, and how often it was called. */
const fault = { firstReady: "throw" as "throw" | "reject-once", calls: 0 };

mock.module("../adapters/cdn-purge/index.js", () => ({
    enqueuePurge() {
        throw new Error("enqueuePurge exploded");
    },
    firstReadyPurge() {
        fault.calls += 1;
        if (fault.firstReady === "throw") {
            throw new Error("firstReadyPurge exploded");
        }
        return fault.calls === 1
            ? Promise.reject(new Error("firstReadyPurge rejected"))
            : Promise.resolve({ purged: true });
    },
}));

/** The handler surface these cases exercise (cache-handler.d.ts types the default as `unknown`). */
interface Handler {
    set(key: string, data: unknown, ctx: unknown): Promise<void>;
    get(key: string, ctx: unknown): Promise<unknown>;
    revalidateTag(tags: string | string[]): Promise<void>;
}
interface HandlerModule {
    default: new (options: object) => Handler;
}
// A fresh module instance per case (query suffix), through a `string`-typed
// specifier, cast to the shape exercised.
const HANDLER: string = "../adapters/cache-handler.js";
const loadHandler = async (instance: string) =>
    (await import(`${HANDLER}?faults=${instance}`)) as unknown as HandlerModule;

const original = { ...process.env };
afterAll(() => {
    process.env = { ...original };
});

describe("CDN wire-in survives a purge module that throws", () => {
    it("construction, set, get and revalidateTag all still work", async () => {
        spyOn(console, "error").mockImplementation(() => {});
        delete process.env.REDIS_URL;
        process.env.KNEXT_BUILD_ID = "build-faults";
        const mod = await loadHandler("1");
        const h = new mod.default({});
        await h.set(
            "/p",
            {
                kind: "APP_PAGE",
                html: "<html>p</html>",
                headers: { "x-next-cache-tags": "x,_N_T_/p" },
            },
            { cacheControl: { revalidate: 60 } },
        );
        expect(await h.get("/p", { kind: "APP_PAGE" })).not.toBeNull();
        await expect(h.revalidateTag("x")).resolves.toBeUndefined();
        expect(await h.get("/p", { kind: "APP_PAGE" })).toBeNull();
    });

    it("a first-ready attempt that rejects is forgotten, so a later construction retries it", async () => {
        fault.firstReady = "reject-once";
        fault.calls = 0;
        delete process.env.REDIS_URL;
        process.env.KNEXT_BUILD_ID = "build-reject-once";
        const mod = await loadHandler("2");
        const tick = () => new Promise((r) => setTimeout(r, 0));
        new mod.default({});
        await tick();
        new mod.default({});
        await tick();
        new mod.default({});
        await tick();
        expect(fault.calls).toBe(2);
    });
});
