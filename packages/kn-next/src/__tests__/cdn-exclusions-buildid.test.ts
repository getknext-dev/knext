/**
 * Two fail-closed fixes (#2281 round 2):
 *
 * 1. `excludePaths` and the `/api/cache/` fence are written against the app's own
 *    routes (`/dashboard`, `/api/cache/...`), but the request path on the wire also
 *    carries the `basePath` and, with i18n, a locale prefix. They must match the
 *    path with basePath and locale stripped AND the raw path.
 * 2. A response whose BUILD_ID cannot be resolved has no build tag, so it carries
 *    a tag set a build-scoped purge cannot reach: it is not edge-cacheable.
 */
import { describe, expect, it } from "bun:test";
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

const { parseRoutingArtifact, decideEdge, loadCdnConfig } = edge;

function art(over: Record<string, unknown> = {}) {
    const a = parseRoutingArtifact(
        JSON.stringify({
            version: 1,
            basePath: "",
            i18n: null,
            middleware: "none",
            conditional: [],
            ...over,
        }),
    );
    if (!a.ok) throw new Error(`artifact rejected: ${a.reason}`);
    return a;
}

function input(
    over: Record<string, unknown> = {},
    env: Record<string, string> = {},
) {
    return {
        cfg: loadCdnConfig({
            KNEXT_CDN_PROVIDER: "cloudflare",
            KNEXT_CDN_TAG_PREFIX: "abcdef012345",
            ...env,
        }),
        artifact: art(),
        method: "GET",
        status: 200,
        originCacheControl: "s-maxage=60",
        hasSetCookie: false,
        hasAuthorization: false,
        hasDraftCookie: false,
        rawTarget: "/blog",
        rsc: { header: false, router: false, param: false },
        contentType: "text/html",
        ownTags: ["_N_T_/blog"],
        fetchTags: [],
        buildId: "b1",
        ...over,
    };
}

describe("excludePaths and /api/cache/ see through basePath and locale prefixes", () => {
    const EXCLUDE = { KNEXT_CDN_EXCLUDE_PATHS: "/dashboard" };
    const withBase = art({ basePath: "/base" });
    const withLocales = art({ i18n: { locales: ["en", "fr"] } });
    const both = art({ basePath: "/base", i18n: { locales: ["en", "fr"] } });

    const excluded: Array<[string, string, ReturnType<typeof art>]> = [
        ["basePath", "/base/dashboard", withBase],
        ["basePath, nested", "/base/dashboard/x", withBase],
        ["locale", "/fr/dashboard", withLocales],
        ["locale, mixed case", "/FR/dashboard", withLocales],
        ["basePath then locale", "/base/fr/dashboard", both],
        ["raw path with no stripping", "/dashboard", art()],
    ];
    for (const [name, rawTarget, artifact] of excluded) {
        it(`excludePaths ["/dashboard"] excludes ${name}: ${rawTarget}`, () => {
            expect(
                decideEdge(input({ rawTarget, artifact }, EXCLUDE)),
            ).toMatchObject({
                edge: false,
                reason: "excluded_path",
            });
        });
    }

    const fenced: Array<[string, string, ReturnType<typeof art>]> = [
        ["basePath", "/base/api/cache/events", withBase],
        ["locale", "/fr/api/cache/events", withLocales],
        ["basePath then locale", "/base/fr/api/cache/events", both],
        ["no prefix", "/api/cache/events", art()],
    ];
    for (const [name, rawTarget, artifact] of fenced) {
        it(`the /api/cache/ fence covers ${name}: ${rawTarget}`, () => {
            expect(decideEdge(input({ rawTarget, artifact }))).toMatchObject({
                edge: false,
                reason: "excluded_path",
            });
        });
    }

    it("a raw-path exclusion (the full path with the basePath) still works", () => {
        expect(
            decideEdge(
                input(
                    { rawTarget: "/base/dashboard", artifact: withBase },
                    { KNEXT_CDN_EXCLUDE_PATHS: "/base/dashboard" },
                ),
            ),
        ).toMatchObject({ reason: "excluded_path" });
    });

    it("stripping is segment-bounded: /basement/dashboard is not under /base, /frank is not the fr locale", () => {
        expect(
            decideEdge(
                input(
                    { rawTarget: "/basement/dashboard", artifact: withBase },
                    EXCLUDE,
                ),
            ).edge,
        ).toBe(true);
        expect(
            decideEdge(
                input(
                    { rawTarget: "/frank/dashboard", artifact: withLocales },
                    EXCLUDE,
                ),
            ).edge,
        ).toBe(true);
    });

    it("a locale is only stripped when the app has i18n", () => {
        expect(
            decideEdge(
                input({ rawTarget: "/fr/dashboard", artifact: art() }, EXCLUDE),
            ).edge,
        ).toBe(true);
    });

    it("unrelated paths under a basePath / locale are still cached", () => {
        expect(
            decideEdge(
                input({ rawTarget: "/base/blog", artifact: withBase }, EXCLUDE),
            ).edge,
        ).toBe(true);
        expect(
            decideEdge(
                input(
                    { rawTarget: "/fr/blog", artifact: withLocales },
                    EXCLUDE,
                ),
            ).edge,
        ).toBe(true);
    });
});

describe("an unresolved build id is not edge-cacheable (a build-scoped purge could not reach it)", () => {
    it("decideEdge refuses it", () => {
        expect(decideEdge(input({ buildId: undefined }))).toMatchObject({
            edge: false,
            reason: "build_id_unresolved",
        });
        expect(decideEdge(input({ buildId: "" }))).toMatchObject({
            reason: "build_id_unresolved",
        });
    });
});

for (const runtime of ["node", "bun"] as Runtime[]) {
    describe(`exclusions and build id over http (${runtime})`, () => {
        const isr = { cc: ISR_CC, ct: "text/html", tags: OWN_TAGS };

        it("excludePaths and the /api/cache/ fence see through basePath and locales", async () => {
            const srv = await startServer({
                runtime,
                env: { ...CDN_ENV, KNEXT_CDN_EXCLUDE_PATHS: "/dashboard" },
                artifact: artifact({
                    basePath: "/base",
                    i18n: { locales: ["en", "fr"] },
                }),
            });
            try {
                for (const path of [
                    "/base/dashboard",
                    "/base/fr/dashboard",
                    "/fr/dashboard",
                    "/base/api/cache/events",
                    "/fr/api/cache/events",
                ]) {
                    const r = await get(srv.port, path, isr);
                    expect(
                        r.header("cloudflare-cdn-cache-control"),
                        path,
                    ).toBeUndefined();
                    expect(r.header("cache-tag"), path).toBeUndefined();
                }
            } finally {
                srv.stop();
            }
        });

        it("no BUILD_ID file and no env: nothing is cached", async () => {
            const srv = await startServer({
                runtime,
                env: CDN_ENV,
                artifact: artifact(),
                buildId: null,
            });
            try {
                const r = await get(srv.port, "/blog", isr);
                expect(r.status).toBe(200);
                expect(
                    r.header("cloudflare-cdn-cache-control"),
                ).toBeUndefined();
                const m = await get(srv.port, "/", {}, {}, "metrics");
                expect(m.body).toContain('reason="build_id_unresolved"');
            } finally {
                srv.stop();
            }
        });

        it("Next's constant build id counts as unresolved", async () => {
            const srv = await startServer({
                runtime,
                env: CDN_ENV,
                artifact: artifact(),
                buildId: "build-TfctsWXpff2fKS",
            });
            try {
                const r = await get(srv.port, "/blog", isr);
                expect(
                    r.header("cloudflare-cdn-cache-control"),
                ).toBeUndefined();
            } finally {
                srv.stop();
            }
        });

        it("KNEXT_BUILD_ID is the fallback when the file gives none", async () => {
            const srv = await startServer({
                runtime,
                env: { ...CDN_ENV, KNEXT_BUILD_ID: "from-env" },
                artifact: artifact(),
                buildId: null,
            });
            try {
                const r = await get(srv.port, "/blog", isr);
                expect(r.header("cloudflare-cdn-cache-control")).toBe(
                    "max-age=30",
                );
            } finally {
                srv.stop();
            }
        });
    });
}
