/**
 * The pure half of the CDN tier (ADR-0068 D4/D5): config, tag encoding, the
 * canonical-path gate (condition 11), the routing artifact reader and middleware
 * matching (condition 10), and the allowlist decision. The http-level behaviour on
 * Node and Bun is `cdn-preload-http.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { edge } from "./cdn-edge-untyped";

const {
    PROVIDER_ROWS,
    loadCdnConfig,
    encodeTags,
    tagsFit,
    isCanonicalRawPath,
    underPrefix,
    parseRoutingArtifact,
    middlewareMatches,
    decideEdge,
    edgeHeaders,
} = edge;

const ENV = {
    KNEXT_CDN_PROVIDER: "cloudflare",
    KNEXT_CDN_TAG_PREFIX: "abcdef012345",
};

function cfg(env: Record<string, string> = {}, provider = "cloudflare") {
    const c = loadCdnConfig({ ...ENV, KNEXT_CDN_PROVIDER: provider, ...env });
    if (!c) throw new Error("config unexpectedly off");
    return c;
}

const NONE = parseRoutingArtifact(
    JSON.stringify({
        version: 1,
        basePath: "",
        i18n: null,
        middleware: "none",
    }),
);

function base(over: Record<string, unknown> = {}) {
    return {
        cfg: cfg(),
        artifact: NONE,
        method: "GET",
        status: 200,
        originCacheControl: "s-maxage=60, stale-while-revalidate=31535940",
        hasSetCookie: false,
        hasAuthorization: false,
        hasDraftCookie: false,
        rawTarget: "/blog",
        rsc: { header: false, router: false, param: false },
        contentType: "text/html; charset=utf-8",
        ownTags: ["_N_T_/blog", "posts"],
        fetchTags: [],
        buildId: "build-xyz",
        ...over,
    };
}

describe("loadCdnConfig", () => {
    it("is off (null) without a provider — the zero-diff state", () => {
        expect(loadCdnConfig({})).toBeNull();
        expect(loadCdnConfig({ KNEXT_CDN_PROVIDER: "" })).toBeNull();
    });
    it("is off for an unknown provider, and says so", () => {
        const lines: string[] = [];
        expect(
            loadCdnConfig(
                { ...ENV, KNEXT_CDN_PROVIDER: "fastly" },
                (l: string) => lines.push(l),
            ),
        ).toBeNull();
        expect(lines.join()).toContain("unknown KNEXT_CDN_PROVIDER");
    });
    it("is off unless the tag prefix is the operator-derived 12 hex digits", () => {
        for (const bad of [
            undefined,
            "",
            "ABCDEF012345",
            "abcdef01234",
            "abcdef0123456",
            "victim",
            "zzzzzzzzzzzz",
        ]) {
            expect(
                loadCdnConfig({
                    KNEXT_CDN_PROVIDER: "cloudflare",
                    ...(bad === undefined ? {} : { KNEXT_CDN_TAG_PREFIX: bad }),
                }),
            ).toBeNull();
        }
    });
    it("reads TTL, SWR and the path lists, with bounds and defaults", () => {
        const c = cfg({
            KNEXT_CDN_HTML_TTL_SECONDS: "45",
            KNEXT_CDN_SWR_SECONDS: "10",
            KNEXT_CDN_EXCLUDE_PATHS: "/account, /admin",
            KNEXT_CDN_INCLUDE_PATHS: "/blog",
        });
        expect(c.htmlTtlSeconds).toBe(45);
        expect(c.swrSeconds).toBe(10);
        expect(c.excludePaths).toEqual(["/account", "/admin"]);
        expect(c.includePaths).toEqual(["/blog"]);
        const d = cfg();
        expect(d.htmlTtlSeconds).toBe(30);
        expect(d.swrSeconds).toBe(0);
        expect(cfg({ KNEXT_CDN_HTML_TTL_SECONDS: "9999" }).htmlTtlSeconds).toBe(
            30,
        );
        expect(cfg({ KNEXT_CDN_HTML_TTL_SECONDS: "0" }).htmlTtlSeconds).toBe(
            30,
        );
    });
    it("has a row for every provider the CRD enum names", () => {
        expect(Object.keys(PROVIDER_ROWS).sort()).toEqual([
            "azure-front-door",
            "cloudflare",
            "cloudfront",
            "emulator",
            "google-cloud-cdn",
        ]);
    });
});

describe("encodeTags (D5.2) — golden vectors shared with the purge side", () => {
    it("app tag, build tag, then one hashed tag per Next tag in order", () => {
        expect(
            encodeTags("abcdef012345", "build-xyz", ["_N_T_/blog", "posts"]),
        ).toEqual([
            "kn-abcdef012345",
            "kn-abcdef012345-bf1adbc6c3c0e",
            "kn-abcdef012345-tf015a2ba450e9cbd",
            "kn-abcdef012345-ta44f1b9751711635",
        ]);
    });
    it("dedupes and omits the build tag when there is no build id", () => {
        expect(
            encodeTags("abcdef012345", undefined, ["posts", "posts"]),
        ).toEqual(["kn-abcdef012345", "kn-abcdef012345-ta44f1b9751711635"]);
    });
    it("is ASCII, lowercase and comma-free even for hostile tags", () => {
        const tags = encodeTags("abcdef012345", "b", [
            "a,b",
            "café",
            "日本",
            "UPPER",
        ]);
        for (const t of tags)
            expect(t).toMatch(/^kn-[0-9a-f]{12}(-[bt][0-9a-f]{12,16})?$/);
    });
});

describe("tag limits (D5.4)", () => {
    it("Google: 50 tags max, so 49 Next tags + app + build overflows", () => {
        const row = PROVIDER_ROWS["google-cloud-cdn"];
        const ok = encodeTags(
            "abcdef012345",
            "b",
            Array.from({ length: 48 }, (_, i) => `t${i}`),
        );
        const over = encodeTags(
            "abcdef012345",
            "b",
            Array.from({ length: 49 }, (_, i) => `t${i}`),
        );
        expect(ok.length).toBe(50);
        expect(tagsFit(row, ok)).toBe(true);
        expect(over.length).toBe(51);
        expect(tagsFit(row, over)).toBe(false);
    });
    it("Cloudflare: bounded by 16 KB of header, not by count", () => {
        const row = PROVIDER_ROWS.cloudflare;
        expect(
            tagsFit(
                row,
                encodeTags(
                    "abcdef012345",
                    "b",
                    Array.from({ length: 128 }, (_, i) => `t${i}`),
                ),
            ),
        ).toBe(true);
        expect(
            tagsFit(
                row,
                encodeTags(
                    "abcdef012345",
                    "b",
                    Array.from({ length: 600 }, (_, i) => `t${i}`),
                ),
            ),
        ).toBe(false);
    });
    it("an over-limit set is uncacheable, never truncated", () => {
        const d = decideEdge(
            base({
                cfg: cfg({}, "google-cloud-cdn"),
                ownTags: [
                    "_N_T_/blog",
                    ...Array.from({ length: 60 }, (_, i) => `t${i}`),
                ],
            }),
        );
        expect(d).toMatchObject({ edge: false, reason: "tag_overflow" });
    });
});

describe("isCanonicalRawPath (condition 11)", () => {
    const canonical = [
        "/",
        "/blog",
        "/blog/",
        "/a/b/c",
        "/blog/caf%C3%A9",
        "/a-b_c~d",
        "/a.b",
        "/.well-known/x",
        "/a%20b",
        "/_next/static/chunks/a.js",
    ];
    for (const p of canonical) {
        it(`canonical: ${p}`, () => expect(isCanonicalRawPath(p)).toBe(true));
    }
    const non = [
        "",
        "blog",
        "//x",
        "/a//b",
        "/a/./b",
        "/a/../b",
        "/./",
        "/a/..",
        "/a\\b",
        "/%2e",
        "/%2E%2E/x",
        "/x/%2e%2e/dashboard",
        "/a%2fb",
        "/a%2Fb",
        "/a%5cb",
        "/a%5Cb",
        "/a%25b",
        "/%64ashboard", // an encoded unreserved letter
        "/%41",
        "/%7e",
        "/%2d",
        "/%5f",
        "/%30",
        "/%E0%A4%A", // malformed
        "/%zz",
        "/%",
        "/a%2",
        "http://h/blog",
        "*",
        "/a b", // a character the WHATWG parser would encode
        "/a{b}",
        "/caf\u00e9", // raw non-ASCII on the wire
        "/%E0%A4", // valid-looking escapes that do not decode
    ];
    for (const p of non) {
        it(`non-canonical: ${JSON.stringify(p)}`, () =>
            expect(isCanonicalRawPath(p)).toBe(false));
    }
    it("a non-string is not canonical", () => {
        expect(isCanonicalRawPath(undefined)).toBe(false);
        expect(isCanonicalRawPath(null)).toBe(false);
    });
});

describe("underPrefix is segment-bounded", () => {
    it("/blog covers /blog and /blog/x but never /blogger", () => {
        expect(underPrefix("/blog", "/blog")).toBe(true);
        expect(underPrefix("/blog/x", "/blog")).toBe(true);
        expect(underPrefix("/blogger", "/blog")).toBe(false);
        expect(underPrefix("/blog/", "/blog/")).toBe(true);
        expect(underPrefix("/x", "/")).toBe(true);
    });
    it("can be case-insensitive (excludes) or exact (includes)", () => {
        expect(underPrefix("/Account/x", "/account", true)).toBe(true);
        expect(underPrefix("/Account/x", "/account", false)).toBe(false);
    });
});

describe("parseRoutingArtifact (condition 10)", () => {
    const doc = (o: unknown) => JSON.stringify(o);
    it('explicit middleware "none"', () => {
        const a = parseRoutingArtifact(
            doc({ version: 1, basePath: "", i18n: null, middleware: "none" }),
        );
        expect(a).toMatchObject({ ok: true, none: true });
    });
    it("matchers compile case-insensitively", () => {
        const a = parseRoutingArtifact(
            doc({
                version: 1,
                basePath: "",
                i18n: null,
                middleware: [{ sourceRegex: "^/dash$" }],
            }),
        );
        expect(a.ok && a.matchers[0].test("/DASH")).toBe(true);
    });
    it("middleware with no matchers matches every path", () => {
        const a = parseRoutingArtifact(
            doc({ version: 1, basePath: "", i18n: null, middleware: [] }),
        );
        expect(a).toMatchObject({ ok: true, none: false, matchAll: true });
    });
    for (const [name, text] of [
        ["not json", "{nope"],
        ["empty", ""],
        ["an array", "[]"],
        ["null", "null"],
        [
            "wrong version",
            doc({ version: 2, basePath: "", i18n: null, middleware: "none" }),
        ],
        ["no version", doc({ basePath: "", i18n: null, middleware: "none" })],
        [
            "bad basePath",
            doc({ version: 1, basePath: "x", i18n: null, middleware: "none" }),
        ],
        [
            "bad i18n",
            doc({ version: 1, basePath: "", i18n: "en", middleware: "none" }),
        ],
        [
            "bad middleware",
            doc({ version: 1, basePath: "", i18n: null, middleware: "all" }),
        ],
        [
            "bad matcher",
            doc({ version: 1, basePath: "", i18n: null, middleware: [null] }),
        ],
        [
            "bad regex",
            doc({
                version: 1,
                basePath: "",
                i18n: null,
                middleware: [{ sourceRegex: "(" }],
            }),
        ],
    ] as Array<[string, string]>) {
        it(`rejects: ${name}`, () =>
            expect(parseRoutingArtifact(text).ok).toBe(false));
    }
});

describe("middlewareMatches (condition 10)", () => {
    const art = (middleware: unknown, over: Record<string, unknown> = {}) => {
        const a = parseRoutingArtifact(
            JSON.stringify({
                version: 1,
                basePath: "",
                i18n: null,
                middleware,
                ...over,
            }),
        );
        if (!a.ok) throw new Error("artifact rejected");
        return a;
    };
    it('"none" matches nothing', () =>
        expect(middlewareMatches(art("none"), "/x")).toBe(false));
    it("a matcher matches its own path and not others", () => {
        const a = art([{ sourceRegex: "^/dashboard(?:/)?$" }]);
        expect(middlewareMatches(a, "/dashboard")).toBe(true);
        expect(middlewareMatches(a, "/dashboard/")).toBe(true);
        expect(middlewareMatches(a, "/blog")).toBe(false);
    });
    it("is case-insensitive", () => {
        expect(
            middlewareMatches(
                art([{ sourceRegex: "^/dashboard$" }]),
                "/DashBoard",
            ),
        ).toBe(true);
    });
    it("ignores has/missing: a regexp match counts as matched", () => {
        const a = art([
            {
                sourceRegex: "^/d$",
                has: [{ type: "cookie", key: "s" }],
                missing: [{ type: "header", key: "x" }],
            },
        ]);
        expect(middlewareMatches(a, "/d")).toBe(true);
    });
    it("tests the decoded pathname too (web-cache deception)", () => {
        expect(
            middlewareMatches(
                art([{ sourceRegex: "^/dashboard$" }]),
                "/%64ashboard",
            ),
        ).toBe(true);
    });
    it("a decode failure counts as matched", () => {
        expect(
            middlewareMatches(art([{ sourceRegex: "^/zzz$" }]), "/%E0%A4%A"),
        ).toBe(true);
    });
    it("normalises a pages-router data request under the current, a stale and a forged build id", () => {
        const a = art([{ sourceRegex: "^/dashboard$" }]);
        for (const id of ["build-xyz", "build-old", "forged", "a.b-c_d"]) {
            expect(
                middlewareMatches(a, `/_next/data/${id}/dashboard.json`),
            ).toBe(true);
        }
        expect(
            middlewareMatches(
                art([{ sourceRegex: "^/$" }]),
                "/_next/data/whatever/index.json",
            ),
        ).toBe(true);
        expect(
            middlewareMatches(
                art([{ sourceRegex: "^/blog$" }]),
                "/_next/data/whatever/blog/index.json",
            ),
        ).toBe(true);
    });
    it("strips the basePath as well as keeping it", () => {
        const a = art([{ sourceRegex: "^/dashboard$" }], { basePath: "/app" });
        expect(middlewareMatches(a, "/app/dashboard")).toBe(true);
        expect(middlewareMatches(a, "/app/blog")).toBe(false);
    });
    it("i18n with any matcher: every path counts as matched", () => {
        const a = art([{ sourceRegex: "^/en/dashboard$" }], {
            i18n: { locales: ["en", "fr"] },
        });
        expect(middlewareMatches(a, "/dashboard")).toBe(true);
        expect(middlewareMatches(a, "/anything/else")).toBe(true);
    });
    it("i18n without middleware matches nothing", () => {
        expect(
            middlewareMatches(art("none", { i18n: { locales: ["en"] } }), "/x"),
        ).toBe(false);
    });
    it("middleware without matchers matches everything", () => {
        expect(middlewareMatches(art([]), "/anything")).toBe(true);
    });
    it("tests the trailing-slash variant of a path as well", () => {
        const a = art([{ sourceRegex: "^/dashboard$" }]);
        expect(middlewareMatches(a, "/dashboard/")).toBe(true);
        expect(
            middlewareMatches(
                art([{ sourceRegex: "^/dashboard/$" }]),
                "/dashboard",
            ),
        ).toBe(true);
    });
    it("a matcher with no testable regex is treated as match-all", () => {
        expect(middlewareMatches(art([{ source: "/x" }]), "/anything")).toBe(
            true,
        );
    });
});

describe("decideEdge — the allowlist (D4.1)", () => {
    it("allows a plain ISR page with its own tags", () => {
        const d = decideEdge(base());
        expect(d).toMatchObject({ edge: true, edgeMaxAge: 30, swr: 0 });
        if (d.edge) expect(d.tags[0]).toBe("kn-abcdef012345");
    });
    it("edge max-age is min(s-maxage, TTL)", () => {
        expect(
            decideEdge(base({ originCacheControl: "s-maxage=5" })),
        ).toMatchObject({ edgeMaxAge: 5 });
        expect(
            decideEdge(base({ originCacheControl: "s-maxage=31536000" })),
        ).toMatchObject({ edgeMaxAge: 30 });
        expect(
            decideEdge(
                base({ cfg: cfg({ KNEXT_CDN_HTML_TTL_SECONDS: "120" }) }),
            ),
        ).toMatchObject({ edgeMaxAge: 60 });
    });
    it("s-maxage=0 is not cacheable", () => {
        expect(
            decideEdge(base({ originCacheControl: "s-maxage=0" })),
        ).toMatchObject({ reason: "zero_ttl" });
    });
    const table: Array<[string, Record<string, unknown>, string]> = [
        ["POST", { method: "POST" }, "method"],
        ["no method", { method: undefined }, "method"],
        ["201", { status: 201 }, "status"],
        ["304", { status: 304 }, "status"],
        ["308", { status: 308 }, "status"],
        ["404", { status: 404 }, "status"],
        [
            "no shared directive",
            { originCacheControl: "public, max-age=0" },
            "no_shared_directive",
        ],
        [
            "no cache-control",
            { originCacheControl: undefined },
            "no_shared_directive",
        ],
        [
            "private",
            { originCacheControl: "private, s-maxage=60" },
            "private_or_no_store",
        ],
        [
            "no-store",
            { originCacheControl: "s-maxage=60, no-store" },
            "private_or_no_store",
        ],
        [
            "no-cache",
            { originCacheControl: "s-maxage=60, no-cache" },
            "private_or_no_store",
        ],
        ["Set-Cookie", { hasSetCookie: true }, "set_cookie"],
        ["Authorization", { hasAuthorization: true }, "auth_or_draft"],
        ["draft cookie", { hasDraftCookie: true }, "auth_or_draft"],
        ["no request target", { rawTarget: undefined }, "non_canonical_path"],
        [
            "a dot-segment path",
            { rawTarget: "/a/../blog" },
            "non_canonical_path",
        ],
        ["/api/cache/", { rawTarget: "/api/cache/events" }, "excluded_path"],
        [
            "/API/CACHE/ (case)",
            { rawTarget: "/API/CACHE/events" },
            "excluded_path",
        ],
        [
            "excludePaths",
            { cfg: cfg({ KNEXT_CDN_EXCLUDE_PATHS: "/blog" }) },
            "excluded_path",
        ],
        [
            "artifact missing (null)",
            { artifact: null },
            "routing_artifact_missing",
        ],
        [
            "artifact corrupt",
            { artifact: { ok: false, reason: "unparseable" } },
            "routing_artifact_missing",
        ],
        ["no recorded tags", { ownTags: [] }, "tags_missing"],
        [
            "fetch tags only",
            { ownTags: [], fetchTags: ["posts", "_N_T_/x"] },
            "tags_missing",
        ],
        ["own tags without _N_T_", { ownTags: ["posts"] }, "tags_missing"],
    ];
    for (const [name, over, reason] of table) {
        it(`skips: ${name} -> ${reason}`, () => {
            expect(decideEdge(base(over))).toMatchObject({
                edge: false,
                reason,
            });
        });
    }
    it("a 3xx with Vary: Host is never edge-cacheable (status rule)", () => {
        expect(decideEdge(base({ status: 308 }))).toMatchObject({
            edge: false,
            reason: "status",
        });
    });
    it("excludePaths is segment-bounded", () => {
        const c = cfg({ KNEXT_CDN_EXCLUDE_PATHS: "/blog" });
        expect(decideEdge(base({ cfg: c, rawTarget: "/blogger" })).edge).toBe(
            true,
        );
        expect(decideEdge(base({ cfg: c, rawTarget: "/blog/x" })).edge).toBe(
            false,
        );
    });
    it("immutable assets are reported as immutable, with nothing added", () => {
        expect(
            decideEdge(
                base({
                    originCacheControl: "public, max-age=31536000, immutable",
                }),
            ),
        ).toEqual({
            edge: false,
            result: "immutable",
            reason: "immutable",
        });
    });
    it("fetch-kind tags join the own tags once the own entry's are present", () => {
        const d = decideEdge(base({ fetchTags: ["data-tag"] }));
        expect(d.edge && d.tags.length).toBe(5); // app + build + 3 tags
    });

    describe("condition 10 — middleware", () => {
        const withMatcher = parseRoutingArtifact(
            JSON.stringify({
                version: 1,
                basePath: "",
                i18n: null,
                middleware: [{ sourceRegex: "^/blog(?:/.*)?$" }],
            }),
        );
        it("a middleware-matched path is not cached by default", () => {
            expect(decideEdge(base({ artifact: withMatcher }))).toMatchObject({
                reason: "middleware_matched",
            });
        });
        it("includePaths opts it back in", () => {
            const c = cfg({ KNEXT_CDN_INCLUDE_PATHS: "/blog" });
            expect(
                decideEdge(base({ artifact: withMatcher, cfg: c })).edge,
            ).toBe(true);
        });
        it("includePaths is segment-bounded and case-sensitive", () => {
            const c = cfg({ KNEXT_CDN_INCLUDE_PATHS: "/blog" });
            const art = parseRoutingArtifact(
                JSON.stringify({
                    version: 1,
                    basePath: "",
                    i18n: null,
                    middleware: [{ sourceRegex: "^/blogger$" }],
                }),
            );
            expect(
                decideEdge(
                    base({ artifact: art, cfg: c, rawTarget: "/blogger" }),
                ).edge,
            ).toBe(false);
            expect(
                decideEdge(
                    base({ artifact: withMatcher, cfg: c, rawTarget: "/Blog" }),
                ).edge,
            ).toBe(false);
        });
    });

    describe("condition 9 — the RSC rule (D4.3)", () => {
        const rsc = (header: boolean, router: boolean, param: boolean) => ({
            header,
            router,
            param,
        });
        it("RSC: 1 without _rsc is never cached (any content type)", () => {
            for (const ct of ["text/html", "text/x-component"]) {
                expect(
                    decideEdge(
                        base({ rsc: rsc(true, false, false), contentType: ct }),
                    ),
                ).toMatchObject({
                    reason: "rsc_without_rsc_param",
                });
            }
        });
        it("Next-Router-* without _rsc is never cached", () => {
            expect(
                decideEdge(base({ rsc: rsc(false, true, false) })),
            ).toMatchObject({ reason: "rsc_without_rsc_param" });
        });
        it("_rsc without RSC: 1 is never cached (crafted URL)", () => {
            expect(
                decideEdge(
                    base({
                        rsc: rsc(false, false, true),
                        contentType: "text/x-component",
                    }),
                ),
            ).toMatchObject({
                reason: "rsc_param_without_rsc_header",
            });
        });
        it("_rsc + RSC: 1 + flight content type is cached on a query-keyed row", () => {
            expect(
                decideEdge(
                    base({
                        rsc: rsc(true, false, true),
                        contentType: "text/x-component; charset=utf-8",
                    }),
                ).edge,
            ).toBe(true);
        });
        it("_rsc + RSC: 1 but an HTML body is not cached", () => {
            expect(
                decideEdge(base({ rsc: rsc(true, false, true) })),
            ).toMatchObject({ reason: "rsc_content_type_mismatch" });
        });
        it("a flight body under a plain key is not cached", () => {
            expect(
                decideEdge(base({ contentType: "text/x-component" })),
            ).toMatchObject({
                reason: "rsc_content_type_mismatch",
            });
        });
        it("_rsc is never cached on rows that do not key on the query", () => {
            for (const p of ["cloudfront", "azure-front-door"]) {
                expect(
                    decideEdge(
                        base({
                            cfg: cfg({}, p),
                            rsc: rsc(true, false, true),
                            contentType: "text/x-component",
                        }),
                    ),
                ).toMatchObject({ reason: "rsc_not_query_keyed" });
            }
        });
        it("_rsc is cached on every row that keys on the query string", () => {
            for (const p of ["cloudflare", "google-cloud-cdn", "emulator"]) {
                expect(
                    decideEdge(
                        base({
                            cfg: cfg({}, p),
                            rsc: rsc(true, false, true),
                            contentType: "text/x-component",
                        }),
                    ).edge,
                    p,
                ).toBe(true);
            }
        });
        it("a plain HTML response is cached on every row", () => {
            for (const p of Object.keys(PROVIDER_ROWS)) {
                expect(decideEdge(base({ cfg: cfg({}, p) })).edge).toBe(true);
            }
        });
    });
});

describe("edgeHeaders — golden headers per provider (D2, D4.2)", () => {
    const decision = (provider: string, env: Record<string, string> = {}) => {
        const d = decideEdge(base({ cfg: cfg(env, provider) }));
        if (!d.edge) throw new Error(`not edge: ${d.reason}`);
        return edgeHeaders(cfg(env, provider), d);
    };
    const TAGS = [
        "kn-abcdef012345",
        "kn-abcdef012345-bf1adbc6c3c0e",
        "kn-abcdef012345-tf015a2ba450e9cbd",
        "kn-abcdef012345-ta44f1b9751711635",
    ].join(",");
    it("cloudflare: Cloudflare-CDN-Cache-Control + Cache-Tag", () => {
        expect(decision("cloudflare")).toEqual([
            ["cloudflare-cdn-cache-control", "max-age=30"],
            ["cache-tag", TAGS],
        ]);
    });
    it("cloudflare with SWR uses max-age, never s-maxage", () => {
        expect(
            decision("cloudflare", { KNEXT_CDN_SWR_SECONDS: "15" })[0],
        ).toEqual([
            "cloudflare-cdn-cache-control",
            "max-age=30, stale-while-revalidate=15",
        ]);
    });
    it("google-cloud-cdn: CDN-Cache-Control + Cache-Tag", () => {
        expect(decision("google-cloud-cdn")).toEqual([
            ["cdn-cache-control", "max-age=30"],
            ["cache-tag", TAGS],
        ]);
    });
    it("cloudfront: s-maxage in Cache-Control + Cache-Tag", () => {
        expect(decision("cloudfront")).toEqual([
            ["cache-control", "public, max-age=0, s-maxage=30"],
            ["cache-tag", TAGS],
        ]);
    });
    it("cloudfront with SWR keeps must-revalidate off", () => {
        expect(
            decision("cloudfront", { KNEXT_CDN_SWR_SECONDS: "15" })[0],
        ).toEqual([
            "cache-control",
            "public, max-age=0, s-maxage=30, stale-while-revalidate=15",
        ]);
    });
    it("azure-front-door: s-maxage in Cache-Control and no tag header", () => {
        expect(decision("azure-front-door")).toEqual([
            ["cache-control", "public, max-age=0, s-maxage=30"],
        ]);
    });
    it("emulator: Cloudflare-shaped", () => {
        expect(decision("emulator")).toEqual([
            ["cloudflare-cdn-cache-control", "max-age=30"],
            ["cache-tag", TAGS],
        ]);
    });
});

describe("the preload reads no Next internal manifest (condition 10 scan)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const strip = (src: string) =>
        src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .split("\n")
            .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
            .join("\n");
    for (const file of ["cdn-edge.cjs", "cache-control-normalize.cjs"]) {
        it(`${file} names no Next build manifest`, () => {
            const code = strip(
                readFileSync(join(here, "..", "adapters", file), "utf8"),
            );
            expect(code).not.toMatch(/manifest/i);
            expect(code).not.toMatch(
                /required-server-files|routes-manifest|functions-config/,
            );
        });
    }
    it("the only files cdn-edge.cjs reads are the knext artifact and BUILD_ID", () => {
        const code = strip(
            readFileSync(join(here, "..", "adapters", "cdn-edge.cjs"), "utf8"),
        );
        const reads = [
            ...code.matchAll(/readFirst\(fs, [^,]+, \[([^\]]*)\]\)/g),
        ].map((m) => m[1]);
        expect(reads.sort()).toEqual([
            "'BUILD_ID', 'BUILD_ID.'",
            "ROUTING_ARTIFACT_NAME",
        ]);
        expect(code).toContain(
            "const ROUTING_ARTIFACT_NAME = 'knext-cdn-routing.json'",
        );
    });
});
