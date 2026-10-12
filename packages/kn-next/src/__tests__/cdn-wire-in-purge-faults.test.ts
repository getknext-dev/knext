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

mock.module("../adapters/cdn-purge/index.js", () => ({
    enqueuePurge() {
        throw new Error("enqueuePurge exploded");
    },
    firstReadyPurge() {
        throw new Error("firstReadyPurge exploded");
    },
}));

const original = { ...process.env };
afterAll(() => {
    process.env = { ...original };
});

describe("CDN wire-in survives a purge module that throws", () => {
    it("construction, set, get and revalidateTag all still work", async () => {
        spyOn(console, "error").mockImplementation(() => {});
        delete process.env.REDIS_URL;
        process.env.KNEXT_BUILD_ID = "build-faults";
        const mod = await import("../adapters/cache-handler.js?faults=1");
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
});
