/**
 * The CDN header preload against a REAL http server, on BOTH Node and Bun
 * (ADR-0068 D5.1: Bun parity is proved, not assumed). The stand-in server loads
 * `cache-control-normalize.cjs` exactly as `--require` does and the client speaks
 * raw bytes over a socket, so nothing normalises the request-target first.
 *
 * Covers: per-provider golden headers, the tag seam across an async hop,
 * `writeHead` / implicit-header interception (`write`, `end`, object-form
 * `writeHead`), the never-cache set, RSC both ways, and how the raw path is derived.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    artifact,
    CDN_ENV,
    get,
    ISR_CC,
    OWN_TAGS,
    type Running,
    type Runtime,
    rawRequest,
    startServer,
} from "./cdn-test-harness";

const NOW_TAGS = [
    "kn-abcdef012345",
    "kn-abcdef012345-bf1adbc6c3c0e",
    "kn-abcdef012345-tf015a2ba450e9cbd",
    "kn-abcdef012345-ta44f1b9751711635",
].join(",");
const COMPAT_CC = "public, max-age=0, must-revalidate";

for (const runtime of ["node", "bun"] as Runtime[]) {
    describe(`CDN preload over http (${runtime})`, () => {
        let srv: Running;
        beforeAll(async () => {
            srv = await startServer({
                runtime,
                env: CDN_ENV,
                artifact: artifact(),
            });
        });
        afterAll(() => srv?.stop());

        const isr = { cc: ISR_CC, ct: "text/html", tags: OWN_TAGS, hop: true };

        for (const mode of ["write", "end", "writehead"] as const) {
            it(`golden cloudflare headers (${mode}): edge directive + tags, browser value unchanged`, async () => {
                const r = await get(srv.port, "/blog", { ...isr, mode });
                expect(r.status).toBe(200);
                expect(r.header("cloudflare-cdn-cache-control")).toBe(
                    "max-age=30",
                );
                expect(r.header("cache-tag")).toBe(NOW_TAGS);
                expect(r.header("cache-control")).toBe(COMPAT_CC);
            });
        }

        it("tags recorded after an async hop still reach the response (ALS carries the store)", async () => {
            const r = await get(srv.port, "/blog", { ...isr, hop: true });
            expect(r.header("cache-tag")).toBe(NOW_TAGS);
        });

        it("two concurrent requests do not share tags", async () => {
            const [a, b] = await Promise.all([
                get(srv.port, "/a", {
                    ...isr,
                    tags: [{ kind: "page", tags: ["_N_T_/a"] }],
                }),
                get(srv.port, "/b", {
                    ...isr,
                    tags: [{ kind: "page", tags: ["_N_T_/b"] }],
                }),
            ]);
            expect(a.header("cache-tag")).not.toBe(b.header("cache-tag"));
            expect(a.header("cache-tag")?.split(",").length).toBe(3);
            expect(b.header("cache-tag")?.split(",").length).toBe(3);
        });

        it("a request whose handler rewrote req.url is still judged by the wire path", async () => {
            const r = await get(srv.port, "/blog", {
                ...isr,
                rewriteUrl: "/api/cache/invalidate",
            });
            expect(r.header("cloudflare-cdn-cache-control")).toBe("max-age=30");
        });

        // ---- the never-cache set -------------------------------------------------
        const never: Array<
            [string, Record<string, unknown>, Record<string, string>]
        > = [
            ["Set-Cookie response", { setCookie: true }, {}],
            [
                "private origin value",
                {
                    cc: "private, no-cache, no-store, max-age=0, must-revalidate",
                },
                {},
            ],
            ["no-store origin value", { cc: "no-store, s-maxage=60" }, {}],
            ["no s-maxage at all", { cc: "public, max-age=0" }, {}],
            ["404 status", { status: 404 }, {}],
            [
                "308 redirect with Vary",
                {
                    status: 308,
                    extra: { Vary: "Host, X-Forwarded-Host", Location: "/x" },
                },
                {},
            ],
            ["Authorization request", {}, { Authorization: "Bearer t" }],
            ["draft-mode cookie", {}, { Cookie: "a=b; __prerender_bypass=1" }],
            ["preview data cookie", {}, { Cookie: "__next_preview_data=zzz" }],
            ["no recorded tags", { tags: [] }, {}],
            [
                "fetch-kind tags only",
                { tags: [{ kind: "fetch", tags: ["posts"] }] },
                {},
            ],
            [
                "own tags without the _N_T_ path tag",
                { tags: [{ kind: "page", tags: ["posts"] }] },
                {},
            ],
        ];
        for (const [name, over, hdrs] of never) {
            it(`never gains an edge directive or tag header: ${name}`, async () => {
                const r = await get(
                    srv.port,
                    "/blog",
                    { ...isr, ...over },
                    hdrs,
                );
                expect(
                    r.header("cloudflare-cdn-cache-control"),
                ).toBeUndefined();
                expect(r.header("cache-tag")).toBeUndefined();
            });
        }

        it("/api/cache/ is never edge-cached", async () => {
            const r = await get(srv.port, "/api/cache/events", isr);
            expect(r.header("cloudflare-cdn-cache-control")).toBeUndefined();
        });

        it("a POST is never edge-cached", async () => {
            const body = "";
            const r = await rawRequest(
                srv.port,
                `POST /blog HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${body.length}\r\nx-spec: ${JSON.stringify(isr)}\r\n\r\n${body}`,
            );
            expect(r.header("cloudflare-cdn-cache-control")).toBeUndefined();
        });

        it("immutable build assets pass through untouched, untagged", async () => {
            const cc = "public, max-age=31536000, immutable";
            const r = await get(srv.port, "/_next/static/chunks/a.js", {
                cc,
                ct: "text/javascript",
            });
            expect(r.header("cache-control")).toBe(cc);
            expect(r.header("cloudflare-cdn-cache-control")).toBeUndefined();
            expect(r.header("cache-tag")).toBeUndefined();
        });

        // ---- RSC rules, both ways, and the content-type key ----------------------
        it("RSC: 1 without _rsc is never edge-cached (the flight payload must not key on HTML)", async () => {
            const r = await get(
                srv.port,
                "/blog",
                { ...isr, ct: "text/x-component" },
                { RSC: "1" },
            );
            expect(r.header("cloudflare-cdn-cache-control")).toBeUndefined();
        });
        it("Next-Router-* without _rsc is never edge-cached", async () => {
            const r = await get(srv.port, "/blog", isr, {
                "Next-Router-Prefetch": "1",
            });
            expect(r.header("cloudflare-cdn-cache-control")).toBeUndefined();
        });
        it("_rsc in the URL but no RSC: 1 is never edge-cached (crafted-URL poisoning)", async () => {
            const r = await get(srv.port, "/blog?_rsc=abc12", isr);
            expect(r.header("cloudflare-cdn-cache-control")).toBeUndefined();
        });
        it("_rsc with RSC: 1 and a flight content type IS edge-cached on a query-keyed row", async () => {
            const r = await get(
                srv.port,
                "/blog?_rsc=abc12",
                { ...isr, ct: "text/x-component" },
                { RSC: "1" },
            );
            expect(r.header("cloudflare-cdn-cache-control")).toBe("max-age=30");
        });
        it("_rsc with RSC: 1 but an HTML response is not edge-cached (content type must match the key)", async () => {
            const r = await get(srv.port, "/blog?_rsc=abc12", isr, {
                RSC: "1",
            });
            expect(r.header("cloudflare-cdn-cache-control")).toBeUndefined();
        });
        it("a flight response under a non-_rsc key is not edge-cached", async () => {
            const r = await get(srv.port, "/blog", {
                ...isr,
                ct: "text/x-component",
            });
            expect(r.header("cloudflare-cdn-cache-control")).toBeUndefined();
        });

        // ---- how raw is derived (condition 11) -----------------------------------
        const wire = [
            "/blog",
            "/x/%2e%2e/dashboard",
            "/x/%2E%2E/dashboard",
            "/%2F",
            "//x",
            "/a\\b",
            "/a/./b",
            "/a/../b",
            "/%5c",
            "/%64ashboard",
            "/caf%C3%A9?x=1",
            "/blog?_rsc=1&b=%2e%2e",
            "http://h.test/blog",
        ];
        for (const target of wire) {
            it(`the captured raw request-target equals the wire bytes: ${JSON.stringify(target)}`, async () => {
                const r = await get(srv.port, target, {}, {}, "raw");
                const seen = JSON.parse(r.body) as { url: string; raw: string };
                expect(seen.raw).toBe(target);
            });
        }

        const nonCanonical = [
            "/x/%2e%2e/dashboard",
            "/x/%2E%2E/dashboard",
            "/%2F",
            "//x",
            "/a\\b",
            "/a/./b",
            "/a/../b",
            "/%5c",
            "/%25",
            "/%64ashboard",
            "/%E0%A4%A",
            "http://h.test/blog",
        ];
        for (const target of nonCanonical) {
            it(`a non-canonical path is never edge-cached: ${JSON.stringify(target)}`, async () => {
                const r = await get(srv.port, target, isr);
                expect(
                    r.header("cloudflare-cdn-cache-control"),
                ).toBeUndefined();
                expect(r.header("cache-tag")).toBeUndefined();
            });
        }

        it("percent-encoded non-ASCII stays canonical and cacheable", async () => {
            const r = await get(srv.port, "/blog/caf%C3%A9", isr);
            expect(r.header("cloudflare-cdn-cache-control")).toBe("max-age=30");
        });

        it("counts every decision under a closed reason set", async () => {
            await get(srv.port, "/x/%2e%2e/blog", isr);
            const m = await get(srv.port, "/", {}, {}, "metrics");
            expect(m.body).toContain(
                "# TYPE knext_cdn_edge_decision_total counter",
            );
            expect(m.body).toContain(
                'result="skipped",reason="non_canonical_path"',
            );
            expect(m.body).toContain('result="edge",reason="allowed"');
        });
    });
}

for (const runtime of ["node", "bun"] as Runtime[]) {
    describe(`CDN preload, routing artifact and middleware (${runtime})`, () => {
        const isr = { cc: ISR_CC, ct: "text/html", tags: OWN_TAGS };
        const cases: Array<{
            name: string;
            artifact: string | undefined;
            path: string;
            edge: boolean;
            env?: Record<string, string>;
        }> = [
            {
                name: "artifact missing: nothing non-immutable is cached",
                artifact: undefined,
                path: "/blog",
                edge: false,
            },
            {
                name: "artifact corrupt: nothing is cached",
                artifact: "{not json",
                path: "/blog",
                edge: false,
            },
            {
                name: "artifact with a bad regex: nothing is cached",
                artifact: artifact({ middleware: [{ sourceRegex: "(" }] }),
                path: "/blog",
                edge: false,
            },
            {
                name: 'middleware "none": paths are eligible',
                artifact: artifact(),
                path: "/blog",
                edge: true,
            },
            {
                name: "middleware without matchers: every path is matched",
                artifact: artifact({ middleware: [] }),
                path: "/blog",
                edge: false,
            },
            {
                name: "matcher covers the path: not cached",
                artifact: artifact({
                    middleware: [{ sourceRegex: "^/blog(?:/)?$" }],
                }),
                path: "/blog",
                edge: false,
            },
            {
                name: "matcher elsewhere: cached",
                artifact: artifact({
                    middleware: [{ sourceRegex: "^/dashboard(?:/)?$" }],
                }),
                path: "/blog",
                edge: true,
            },
            {
                name: "encoded path cannot dodge a matcher",
                artifact: artifact({
                    middleware: [{ sourceRegex: "^/dashboard(?:/)?$" }],
                }),
                path: "/%64ashboard",
                edge: false,
            },
            {
                name: "includePaths opts a matched prefix back in",
                artifact: artifact({
                    middleware: [{ sourceRegex: "^/blog(?:/.*)?$" }],
                }),
                path: "/blog/x",
                edge: true,
                env: { KNEXT_CDN_INCLUDE_PATHS: "/blog" },
            },
            {
                name: "includePaths is segment-bounded",
                artifact: artifact({
                    middleware: [{ sourceRegex: "^/blogger(?:/.*)?$" }],
                }),
                path: "/blogger",
                edge: false,
                env: { KNEXT_CDN_INCLUDE_PATHS: "/blog" },
            },
            {
                name: "excludePaths wins",
                artifact: artifact(),
                path: "/account/x",
                edge: false,
                env: { KNEXT_CDN_EXCLUDE_PATHS: "/account" },
            },
            {
                name: "excludePaths is segment-bounded",
                artifact: artifact(),
                path: "/accounts",
                edge: true,
                env: { KNEXT_CDN_EXCLUDE_PATHS: "/account" },
            },
            {
                name: "i18n with any matcher: every path is matched",
                artifact: artifact({
                    i18n: { locales: ["en", "fr"] },
                    middleware: [{ sourceRegex: "^/en/dashboard$" }],
                }),
                path: "/dashboard",
                edge: false,
            },
            {
                name: "i18n without middleware stays eligible",
                artifact: artifact({ i18n: { locales: ["en", "fr"] } }),
                path: "/blog",
                edge: true,
            },
        ];
        for (const c of cases) {
            it(c.name, async () => {
                const srv = await startServer({
                    runtime,
                    env: { ...CDN_ENV, ...c.env },
                    artifact: c.artifact,
                });
                try {
                    const r = await get(srv.port, c.path, isr);
                    expect(
                        r.header("cloudflare-cdn-cache-control") !== undefined,
                    ).toBe(c.edge);
                } finally {
                    srv.stop();
                }
            });
        }

        it("a missing artifact is counted as routing_artifact_missing", async () => {
            const srv = await startServer({
                runtime,
                env: CDN_ENV,
                artifact: undefined,
            });
            try {
                await get(srv.port, "/blog", isr);
                const m = await get(srv.port, "/", {}, {}, "metrics");
                expect(m.body).toContain('reason="routing_artifact_missing"');
            } finally {
                srv.stop();
            }
        });
    });
}
