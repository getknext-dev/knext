/**
 * ADR-0068 D4.1 condition 10, Amendment 1: request-dependent ROUTING RULES count
 * as "matched" exactly like middleware.
 *
 * A `next.config` rewrite / redirect / headers rule with a `has` or `missing`
 * condition (cookie, header, query, host) decides the response from something the
 * CDN's cache key does not contain. With no middleware at all,
 * `rewrites: [{ source: '/home', has: [{ type: 'cookie', key: 'vip' }], destination: '/dashboard' }]`
 * makes `GET /home` serve `/dashboard` for a visitor with the cookie and `/home`
 * without it; a CDN that ignores cookies would store the first body under `/home`
 * and serve it to everyone. So the routing artifact records every such rule from
 * the official `onBuildComplete` routing outputs, and the preload refuses to
 * edge-cache any path they match. A rule whose regexp the adapter does not expose,
 * or a routing output that is missing, is never ignored: it matches everything.
 */
import { describe, expect, it } from "bun:test";
import { buildCdnRoutingArtifact } from "../adapters/cdn-routing-artifact";
import { edge } from "./cdn-edge-untyped";
import {
    artifact,
    CDN_ENV,
    get,
    ISR_CC,
    OWN_TAGS,
    type Runtime,
    startServer,
} from "./cdn-test-harness";

const { parseRoutingArtifact, middlewareMatches, decideEdge, loadCdnConfig } =
    edge;

const doc = (o: Record<string, unknown>) =>
    JSON.stringify({
        version: 1,
        basePath: "",
        i18n: null,
        middleware: "none",
        conditional: [],
        ...o,
    });

function parsed(o: Record<string, unknown>) {
    const a = parseRoutingArtifact(doc(o));
    if (!a.ok) throw new Error(`artifact rejected: ${a.reason}`);
    return a;
}

const HOME_RULE = { source: "/home", sourceRegex: "^\\/home(?:\\/)?$" };

describe("buildCdnRoutingArtifact records request-dependent routing rules", () => {
    const ctx = (routing: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: a minimal ctx; the writer reads only these fields
        ({ config: {}, outputs: {}, routing }) as any;

    it("records a rewrite / redirect / header rule with has or missing, from every routing group", () => {
        const a = buildCdnRoutingArtifact(
            ctx({
                beforeMiddleware: [
                    {
                        source: "/hdr",
                        sourceRegex: "^\\/hdr(?:\\/)?$",
                        has: [{ type: "header", key: "x-h" }],
                    },
                    {
                        source: "/old",
                        sourceRegex: "^\\/old(?:\\/)?$",
                        has: [{ type: "host", value: "beta.example.com" }],
                    },
                ],
                beforeFiles: [
                    { ...HOME_RULE, has: [{ type: "cookie", key: "vip" }] },
                ],
                afterFiles: [
                    {
                        source: "/aa",
                        sourceRegex: "^\\/aa(?:\\/)?$",
                        missing: [{ type: "header", key: "x-a" }],
                    },
                ],
                fallback: [
                    {
                        source: "/fb",
                        sourceRegex: "^\\/fb$",
                        has: [{ type: "query", key: "q" }],
                    },
                ],
                dynamicRoutes: [
                    {
                        source: "/d/[x]",
                        sourceRegex: "^/d/[^/]+$",
                        missing: [{ type: "cookie", key: "c" }],
                    },
                ],
                onMatch: [
                    {
                        sourceRegex: "^/m$",
                        has: [{ type: "header", key: "h" }],
                    },
                ],
            }),
        );
        expect(a.conditional).toEqual([
            { source: "/hdr", sourceRegex: "^\\/hdr(?:\\/)?$" },
            { source: "/old", sourceRegex: "^\\/old(?:\\/)?$" },
            { source: "/home", sourceRegex: "^\\/home(?:\\/)?$" },
            { source: "/aa", sourceRegex: "^\\/aa(?:\\/)?$" },
            { source: "/d/[x]", sourceRegex: "^/d/[^/]+$" },
            { sourceRegex: "^/m$" },
            { source: "/fb", sourceRegex: "^\\/fb$" },
        ]);
    });

    it("ignores rules with no condition (their result depends on the URL alone) and non-rule entries", () => {
        const a = buildCdnRoutingArtifact(
            ctx({
                beforeMiddleware: [
                    { source: "/plain", sourceRegex: "^/plain$" },
                ],
                beforeFiles: [
                    { source: "/e", sourceRegex: "^/e$", has: [], missing: [] },
                ],
                shouldNormalizeNextData: false,
                rsc: { header: "rsc" },
            }),
        );
        expect(a.conditional).toEqual([]);
    });

    it("a conditional rule whose regexp is not exposed is widened to match-all, never dropped", () => {
        const a = buildCdnRoutingArtifact(
            ctx({
                afterFiles: [
                    { source: "/x", has: [{ type: "cookie", key: "c" }] },
                ],
            }),
        );
        expect(a.conditional).toEqual([
            { source: "/:path*", sourceRegex: "^.*$" },
        ]);
    });

    it("no routing output at all is 'unknown' — never assumed to be empty", () => {
        expect(buildCdnRoutingArtifact(ctx(undefined)).conditional).toBe(
            "unknown",
        );
        expect(buildCdnRoutingArtifact(ctx(null)).conditional).toBe("unknown");
    });

    it("lists the groups in a fixed order: fallback before middlewareMatchers, unknown groups last", () => {
        const cond = [{ type: "cookie", key: "c" }];
        const a = buildCdnRoutingArtifact(
            ctx({
                futureGroup: [{ source: "/z", sourceRegex: "^/z$", has: cond }],
                middlewareMatchers: [
                    { source: "/m", sourceRegex: "^/m$", has: cond },
                ],
                fallback: [{ source: "/f", sourceRegex: "^/f$", has: cond }],
            }),
        );
        expect(
            (a.conditional as Array<{ source: string }>).map((r) => r.source),
        ).toEqual(["/f", "/m", "/z"]);
    });
    it("also folds in routing.middlewareMatchers", () => {
        const a = buildCdnRoutingArtifact(
            ctx({
                middlewareMatchers: [
                    {
                        source: "/m",
                        sourceRegex: "^/m$",
                        has: [{ type: "header", key: "x" }],
                    },
                ],
            }),
        );
        expect(a.conditional).toEqual([{ source: "/m", sourceRegex: "^/m$" }]);
    });
});

describe("parseRoutingArtifact reads the conditional rules (fail closed)", () => {
    it("an artifact with none and no conditional rules is 'none'", () => {
        expect(parsed({})).toMatchObject({ none: true, matchAll: false });
    });
    it("conditional rules make it not-'none'", () => {
        expect(parsed({ conditional: [HOME_RULE] })).toMatchObject({
            none: false,
        });
    });
    it("'unknown' matches everything", () => {
        expect(parsed({ conditional: "unknown" })).toMatchObject({
            none: false,
            matchAll: true,
        });
    });
    for (const [name, o] of [
        ["field absent (an older writer)", { conditional: undefined }],
        ["not an array", { conditional: "all" }],
        ["null", { conditional: null }],
        ["an entry that is not an object", { conditional: [null] }],
        [
            "a regexp that does not compile",
            { conditional: [{ sourceRegex: "(" }] },
        ],
    ] as Array<[string, Record<string, unknown>]>) {
        it(`rejects: ${name}`, () => {
            expect(parseRoutingArtifact(doc(o)).ok).toBe(false);
        });
    }
    it("an entry without a regexp matches everything", () => {
        expect(parsed({ conditional: [{ source: "/x" }] })).toMatchObject({
            matchAll: true,
        });
    });
});

describe("middlewareMatches covers conditional rules", () => {
    const a = parsed({ conditional: [HOME_RULE] });
    it("matches the rule's own path, case-insensitively, with and without a trailing slash", () => {
        expect(middlewareMatches(a, "/home")).toBe(true);
        expect(middlewareMatches(a, "/home/")).toBe(true);
        expect(middlewareMatches(a, "/HOME")).toBe(true);
    });
    it("does not match unrelated paths", () => {
        expect(middlewareMatches(a, "/homely")).toBe(false);
        expect(middlewareMatches(a, "/open")).toBe(false);
    });
    it("tests the decoded and data-route forms too", () => {
        expect(middlewareMatches(a, "/%68ome")).toBe(true);
        expect(middlewareMatches(a, "/_next/data/forged/home.json")).toBe(true);
    });
    it("with i18n, any conditional rule makes every path matched (locale insertion)", () => {
        const i = parsed({
            i18n: { locales: ["en", "fr"] },
            conditional: [HOME_RULE],
        });
        expect(middlewareMatches(i, "/anything")).toBe(true);
    });
    it("with i18n and no rules nothing is matched", () => {
        expect(
            middlewareMatches(parsed({ i18n: { locales: ["en"] } }), "/x"),
        ).toBe(false);
    });
    it("combines with middleware matchers", () => {
        const both = parsed({
            middleware: [{ sourceRegex: "^/dash$" }],
            conditional: [HOME_RULE],
        });
        expect(middlewareMatches(both, "/dash")).toBe(true);
        expect(middlewareMatches(both, "/home")).toBe(true);
        expect(middlewareMatches(both, "/open")).toBe(false);
    });
});

describe("decideEdge: a path a conditional rule matches is not edge-cached", () => {
    const cfg = (env: Record<string, string> = {}) =>
        loadCdnConfig({
            KNEXT_CDN_PROVIDER: "cloudflare",
            KNEXT_CDN_TAG_PREFIX: "abcdef012345",
            ...env,
        });
    const input = (over: Record<string, unknown> = {}) => ({
        cfg: cfg(),
        artifact: parsed({ conditional: [HOME_RULE] }),
        method: "GET",
        status: 200,
        originCacheControl: "s-maxage=60",
        hasSetCookie: false,
        hasAuthorization: false,
        hasDraftCookie: false,
        rawTarget: "/home",
        rsc: { header: false, router: false, param: false },
        contentType: "text/html",
        ownTags: ["_N_T_/home"],
        fetchTags: [],
        buildId: "b1",
        ...over,
    });
    it("refuses the matched path", () => {
        expect(decideEdge(input())).toMatchObject({
            edge: false,
            reason: "middleware_matched",
        });
    });
    it("allows an unmatched path", () => {
        expect(decideEdge(input({ rawTarget: "/open" })).edge).toBe(true);
    });
    it("includePaths opts it back in (and the docs must say that removes the protection)", () => {
        expect(
            decideEdge(
                input({ cfg: cfg({ KNEXT_CDN_INCLUDE_PATHS: "/home" }) }),
            ).edge,
        ).toBe(true);
    });
});

for (const runtime of ["node", "bun"] as Runtime[]) {
    describe(`conditional routing rules over http (${runtime})`, () => {
        const isr = { cc: ISR_CC, ct: "text/html", tags: OWN_TAGS };
        const cases: Array<{
            name: string;
            artifact: string;
            path: string;
            edge: boolean;
        }> = [
            {
                name: "a path matched by a conditional rule is not cached",
                artifact: artifact({ conditional: [HOME_RULE] }),
                path: "/home",
                edge: false,
            },
            {
                name: "an unrelated path is cached",
                artifact: artifact({ conditional: [HOME_RULE] }),
                path: "/open",
                edge: true,
            },
            {
                name: "'unknown' conditional rules: nothing is cached",
                artifact: artifact({ conditional: "unknown" }),
                path: "/open",
                edge: false,
            },
            {
                name: "an artifact without the field (older writer): nothing is cached",
                artifact: JSON.stringify({
                    version: 1,
                    basePath: "",
                    i18n: null,
                    middleware: "none",
                }),
                path: "/open",
                edge: false,
            },
        ];
        for (const c of cases) {
            it(c.name, async () => {
                const srv = await startServer({
                    runtime,
                    env: CDN_ENV,
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
    });
}
