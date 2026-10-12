/**
 * `excludePaths` and the `/api/cache/` fence also cover the pages-router DATA URL
 * of an excluded page: `/_next/data/<id>/account.json` is the same page content as
 * `/account`, so excluding `/account` must exclude it too (under a basePath, with a
 * locale, and whatever build id the URL carries: current, stale or forged).
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
    over: Record<string, unknown>,
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
        contentType: "application/json",
        ownTags: ["_N_T_/blog"],
        fetchTags: [],
        buildId: "b1",
        ...over,
    };
}

const EXCLUDE = { KNEXT_CDN_EXCLUDE_PATHS: "/account" };
const withBase = art({ basePath: "/base" });
const withLocales = art({ i18n: { locales: ["en", "fr"] } });
const both = art({ basePath: "/base", i18n: { locales: ["en", "fr"] } });

describe("excludePaths fences the data URL of an excluded page", () => {
    const cases: Array<[string, string, ReturnType<typeof art>]> = [
        ["plain", "/_next/data/b1/account.json", art()],
        ["a nested page", "/_next/data/b1/account/billing.json", art()],
        ["a stale build id", "/_next/data/stale-id/account.json", art()],
        ["a forged build id", "/_next/data/x.y-z_9/account.json", art()],
        ["under a basePath", "/base/_next/data/b1/account.json", withBase],
        ["with a locale", "/_next/data/b1/fr/account.json", withLocales],
        [
            "with a basePath and a locale",
            "/base/_next/data/b1/fr/account.json",
            both,
        ],
    ];
    for (const [name, rawTarget, artifact] of cases) {
        it(`${name}: ${rawTarget}`, () => {
            expect(
                decideEdge(input({ rawTarget, artifact }, EXCLUDE)),
            ).toMatchObject({
                edge: false,
                reason: "excluded_path",
            });
        });
    }

    it("the /api/cache/ fence covers a data URL too", () => {
        for (const [rawTarget, artifact] of [
            ["/_next/data/b1/api/cache/events.json", art()],
            ["/base/_next/data/b1/api/cache/events.json", withBase],
            ["/_next/data/b1/fr/api/cache/events.json", withLocales],
        ] as Array<[string, ReturnType<typeof art>]>) {
            expect(decideEdge(input({ rawTarget, artifact }))).toMatchObject({
                reason: "excluded_path",
            });
        }
    });

    it("an index data URL maps to its directory page", () => {
        expect(
            decideEdge(
                input(
                    {
                        rawTarget: "/_next/data/b1/account/index.json",
                        artifact: art(),
                    },
                    EXCLUDE,
                ),
            ),
        ).toMatchObject({ reason: "excluded_path" });
        // ...and /_next/data/<id>/index.json is the home page: only a "/" exclusion hits it.
        expect(
            decideEdge(
                input(
                    { rawTarget: "/_next/data/b1/index.json", artifact: art() },
                    EXCLUDE,
                ),
            ).edge,
        ).toBe(true);
    });

    it("is segment-bounded: a different page's data URL is still cacheable", () => {
        for (const rawTarget of [
            "/_next/data/b1/accounts.json",
            "/_next/data/b1/account-x.json",
            "/_next/data/b1/blog.json",
        ]) {
            expect(
                decideEdge(input({ rawTarget, artifact: art() }, EXCLUDE)).edge,
                rawTarget,
            ).toBe(true);
        }
    });

    it("a path that merely contains _next/data deeper is not a data URL", () => {
        expect(
            decideEdge(
                input(
                    {
                        rawTarget: "/x/_next/data/b1/account.json",
                        artifact: art(),
                    },
                    EXCLUDE,
                ),
            ).edge,
        ).toBe(true);
    });

    it("without the .json suffix it is not a data URL", () => {
        expect(
            decideEdge(
                input(
                    { rawTarget: "/_next/data/b1/account", artifact: art() },
                    EXCLUDE,
                ),
            ).edge,
        ).toBe(true);
    });

    it("a data URL for an included page stays cacheable", () => {
        expect(
            decideEdge(
                input(
                    { rawTarget: "/_next/data/b1/blog.json", artifact: art() },
                    EXCLUDE,
                ),
            ).edge,
        ).toBe(true);
    });
});

for (const runtime of ["node", "bun"] as Runtime[]) {
    describe(`data URL fence over http (${runtime})`, () => {
        it("the data URL of an excluded page is never edge-cached", async () => {
            const srv = await startServer({
                runtime,
                env: { ...CDN_ENV, KNEXT_CDN_EXCLUDE_PATHS: "/account" },
                artifact: artifact({
                    basePath: "/base",
                    i18n: { locales: ["en", "fr"] },
                }),
            });
            try {
                const spec = {
                    cc: ISR_CC,
                    ct: "application/json",
                    tags: OWN_TAGS,
                };
                for (const path of [
                    "/base/_next/data/b1/account.json",
                    "/base/_next/data/forged/fr/account.json",
                    "/_next/data/b1/account.json",
                ]) {
                    const r = await get(srv.port, path, spec);
                    expect(
                        r.header("cloudflare-cdn-cache-control"),
                        path,
                    ).toBeUndefined();
                }
                const ok = await get(
                    srv.port,
                    "/base/_next/data/b1/blog.json",
                    spec,
                );
                expect(ok.header("cloudflare-cdn-cache-control")).toBe(
                    "max-age=30",
                );
            } finally {
                srv.stop();
            }
        });
    });
}
