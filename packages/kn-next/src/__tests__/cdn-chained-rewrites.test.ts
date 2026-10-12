/**
 * ADR-0068 D4.1 condition 10, Amendment 1, chains.
 *
 * An UNCONDITIONAL rewrite is deterministic by URL, so on its own it is safe to
 * cache. But when its destination can reach a request-dependent rule, the answer
 * depends on the request after all: with `/alias -> /af` and `/af -> /dashboard`
 * only `has: cookie vip`, `GET /alias` serves `open` without the cookie and
 * `dashboard` with it, under one URL. So the writer follows rewrite chains to a
 * fixpoint: a rewrite whose destination reaches a conditional source, or whose
 * destination cannot be evaluated statically while a conditional rule exists,
 * becomes conditional itself. Beyond a cap it widens to match-all.
 */
import { describe, expect, it } from "bun:test";
import { buildCdnRoutingArtifact } from "../adapters/cdn-routing-artifact";

const ctx = (routing: unknown, config: Record<string, unknown> = {}) =>
    // biome-ignore lint/suspicious/noExplicitAny: a minimal ctx; the writer reads only these fields
    ({ config, outputs: {}, routing }) as any;

const COOKIE = [{ type: "cookie", key: "vip" }];
const rule = (
    source: string,
    destination: string,
    extra: Record<string, unknown> = {},
) => ({
    source,
    sourceRegex: `^${source.replace(/\//g, "\\/")}(?:\\/)?$`,
    destination,
    ...extra,
});

function sources(
    routing: unknown,
    config: Record<string, unknown> = {},
): string[] {
    const c = buildCdnRoutingArtifact(ctx(routing, config)).conditional;
    if (c === "unknown") throw new Error("unexpected 'unknown'");
    return c.map((r) => r.source ?? "<none>");
}

describe("an unconditional rewrite that reaches a conditional rule becomes conditional", () => {
    it("1 hop: /alias -> /af, /af has a cookie rule", () => {
        const s = sources({
            beforeFiles: [
                rule("/alias", "/af"),
                rule("/af", "/dashboard", { has: COOKIE }),
            ],
        });
        expect(s.sort()).toEqual(["/af", "/alias"]);
    });

    it("2 hops: /a -> /b -> /af", () => {
        const s = sources({
            beforeFiles: [
                rule("/a", "/b"),
                rule("/b", "/af"),
                rule("/af", "/dashboard", { has: COOKIE }),
            ],
        });
        expect(s.sort()).toEqual(["/a", "/af", "/b"]);
    });

    it("3 hops across phases, whatever order they are listed in", () => {
        const s = sources({
            fallback: [rule("/c", "/d")],
            afterFiles: [
                rule("/af", "/dashboard", {
                    missing: [{ type: "header", key: "x" }],
                }),
                rule("/b", "/c"),
            ],
            beforeFiles: [rule("/d", "/af")],
        });
        expect(s.sort()).toEqual(["/af", "/b", "/c", "/d"]);
    });

    it("the destination's trailing slash and query do not hide it", () => {
        expect(
            sources({
                beforeFiles: [
                    rule("/x", "/af/?a=1"),
                    rule("/af", "/o", { has: COOKIE }),
                ],
            }).sort(),
        ).toEqual(["/af", "/x"]);
    });

    it("a basePath-prefixed destination reaches it", () => {
        const s = sources(
            {
                beforeFiles: [
                    rule("/x", "/base/af"),
                    rule("/af", "/o", { has: COOKIE }),
                ],
            },
            { basePath: "/base" },
        );
        expect(s.sort()).toEqual(["/af", "/x"]);
    });

    it("a destination that reaches an UNCOMPILABLE conditional regexp counts as reaching it", () => {
        const s = sources({
            beforeFiles: [
                rule("/x", "/anything"),
                {
                    source: "/bad",
                    sourceRegex: "(",
                    destination: "/o",
                    has: COOKIE,
                },
            ],
        });
        expect(s).toContain("/x");
    });

    it("a conditional rule with no exposed regexp makes every static rewrite reach it", () => {
        const s = sources({
            beforeFiles: [
                rule("/x", "/anything"),
                { source: "/y", destination: "/o", has: COOKIE },
            ],
        });
        expect(s).toContain("/x");
    });
});

describe("the destination is tested in every form the rule's regexp might expect", () => {
    const strict = (sourceRegex: string) => ({
        source: "/af",
        sourceRegex,
        destination: "/o",
        has: COOKIE,
    });
    it("a trailing-slash destination reaches a regexp that has none", () => {
        expect(
            sources({
                beforeFiles: [rule("/x", "/af/"), strict("^/af$")],
            }).sort(),
        ).toEqual(["/af", "/x"]);
    });
    it("a destination without the slash reaches a regexp that requires it (trailingSlash apps)", () => {
        expect(
            sources({
                beforeFiles: [rule("/x", "/af"), strict("^/af/$")],
            }).sort(),
        ).toEqual(["/af", "/x"]);
    });
    it("a plain destination reaches a regexp that carries the basePath", () => {
        const s = sources(
            { beforeFiles: [rule("/x", "/af"), strict("^/base/af$")] },
            { basePath: "/base" },
        );
        expect(s.sort()).toEqual(["/af", "/x"]);
    });
});

describe("a rewrite whose destination cannot be evaluated statically", () => {
    it("is conditional when ANY conditional rule exists (params / regex captures)", () => {
        const s = sources({
            beforeFiles: [
                rule("/p/:x", "/q/$1"),
                rule("/af", "/o", { has: COOKIE }),
            ],
        });
        expect(s).toContain("/p/:x");
    });

    it("also for a named capture", () => {
        const s = sources({
            afterFiles: [
                rule("/p/:x", "/q/$x"),
                rule("/af", "/o", { has: COOKIE }),
            ],
        });
        expect(s).toContain("/p/:x");
    });

    it("is NOT conditional when no conditional rule exists (nothing to reach)", () => {
        expect(sources({ beforeFiles: [rule("/p/:x", "/q/$1")] })).toEqual([]);
    });

    it("is conditional through a chain that only becomes conditional later (fixpoint)", () => {
        const s = sources({
            beforeFiles: [
                rule("/p/:x", "/q/$1"),
                rule("/a", "/af"),
                rule("/af", "/o", { has: COOKIE }),
            ],
        });
        expect(s.sort()).toEqual(["/a", "/af", "/p/:x"]);
    });
});

describe("what is NOT made conditional (the control cases stay cacheable)", () => {
    it("an unconditional chain with no conditional rule anywhere", () => {
        expect(
            sources({
                beforeFiles: [
                    rule("/c1", "/c2"),
                    rule("/c2", "/c3"),
                    rule("/c3", "/open"),
                ],
            }),
        ).toEqual([]);
    });

    it("a rewrite that does not reach any conditional source", () => {
        const s = sources({
            beforeFiles: [
                rule("/z", "/open"),
                rule("/af", "/o", { has: COOKIE }),
            ],
        });
        expect(s).toEqual(["/af"]);
    });

    it("an external destination cannot reach the app's own rules", () => {
        const s = sources({
            beforeFiles: [
                rule("/api2", "https://api.example.com/x"),
                rule("/af", "/o", { has: COOKIE }),
            ],
        });
        expect(s).toEqual(["/af"]);
    });

    it("dynamicRoutes (page-file mapping, not URL rewrites) are not chain edges", () => {
        const s = sources({
            dynamicRoutes: [
                {
                    source: "/af/[x]",
                    sourceRegex: "^/af/[^/]+$",
                    destination: "/af/[x]$2?nxtPx=$nxtPx",
                },
            ],
            beforeFiles: [rule("/af", "/o", { has: COOKIE })],
        });
        expect(s).toEqual(["/af"]);
    });

    it("redirects and header rules (no destination field) are not rewrites", () => {
        const s = sources({
            beforeMiddleware: [
                {
                    source: "/r",
                    sourceRegex: "^\\/r$",
                    headers: { Location: "/af" },
                    status: 307,
                },
                {
                    source: "/h",
                    sourceRegex: "^\\/h$",
                    headers: { "x-a": "1" },
                },
            ],
            beforeFiles: [rule("/af", "/o", { has: COOKIE })],
        });
        expect(s).toEqual(["/af"]);
    });
});

describe("the fixpoint is capped at match-all", () => {
    it("a very large chain widens to one match-all entry", () => {
        const rules = [] as Array<ReturnType<typeof rule>>;
        for (let i = 0; i < 400; i++) rules.push(rule(`/r${i}`, `/r${i + 1}`));
        rules.push(rule("/r400", "/o", { has: COOKIE }));
        const c = buildCdnRoutingArtifact(
            ctx({ beforeFiles: rules }),
        ).conditional;
        expect(c).toEqual([{ source: "/:path*", sourceRegex: "^.*$" }]);
    });

    it("a small chain is not widened", () => {
        const c = buildCdnRoutingArtifact(
            ctx({
                beforeFiles: [
                    rule("/a", "/b"),
                    rule("/b", "/o", { has: COOKIE }),
                ],
            }),
        ).conditional;
        expect(c).not.toEqual([{ source: "/:path*", sourceRegex: "^.*$" }]);
    });
});
