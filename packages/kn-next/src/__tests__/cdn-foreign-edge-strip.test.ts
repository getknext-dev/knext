/**
 * Foreign edge directives are stripped (ADR-0068 D4, Amendment 2).
 *
 * `cdn-edge` ADDS an edge directive when the allowlist passes. A response can
 * also arrive at `writeHead` already carrying one it did not add: a proxied
 * (external-style) rewrite copies the inner response's headers onto the outer
 * response, and another app behind an external rewrite may emit its own. With CDN
 * mode on, a response whose decision is NOT `edge` must leave the origin with no
 * `Cloudflare-CDN-Cache-Control`, no `CDN-Cache-Control` and no tag header, and
 * on the rows that carry the directive in `Cache-Control` itself (CloudFront,
 * Azure) no `s-maxage` the decision did not produce. Counted under
 * `reason="foreign_edge_header_stripped"`.
 *
 * The pure half (`stripForeignEdgeHeaders`) is pinned first; then the preload over
 * real http on Node and Bun, through every way a header reaches the wire:
 * `setHeader` + the implicit flush on `write` / `end`, object- and array-form
 * `writeHead`, `appendHeader`, and a streamed body whose headers flush late.
 * The real-Next repro is `cdn-foreign-edge-rewrite.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { edge } from "./cdn-edge-untyped";
import {
    artifact,
    CDN_ENV,
    FROZEN_PRE_CDN_PRELOAD,
    get,
    ISR_CC,
    OWN_TAGS,
    PRELOAD,
    type RawResponse,
    type Runtime,
    rawRequest,
    startServer,
} from "./cdn-test-harness";

const { loadCdnConfig, stripForeignEdgeHeaders } = edge;

const FOREIGN_CF = "max-age=999";
const FOREIGN_CDN = "max-age=998";
const FOREIGN_TAGS = "kn-abcdef012345,kn-abcdef012345-tdeadbeefdeadbeef";
const FOREIGN = {
    "Cloudflare-CDN-Cache-Control": FOREIGN_CF,
    "CDN-Cache-Control": FOREIGN_CDN,
    "Cache-Tag": FOREIGN_TAGS,
};
const EDGE_NAMES = ["cloudflare-cdn-cache-control", "cdn-cache-control"];
const COMPAT_CC = "public, max-age=0, must-revalidate";
const NOW_TAGS = [
    "kn-abcdef012345",
    "kn-abcdef012345-bf1adbc6c3c0e",
    "kn-abcdef012345-tf015a2ba450e9cbd",
    "kn-abcdef012345-ta44f1b9751711635",
].join(",");

/** `/variant` is middleware-matched: the outer response of the repro. */
const MATCHED = artifact({
    middleware: [{ source: "/variant", sourceRegex: "^/variant$" }],
});

/** A header store with the `ServerResponse` header API, for the pure half. */
function fakeRes(initial: Record<string, string | string[]> = {}) {
    const m = new Map<string, string | string[]>();
    for (const [k, v] of Object.entries(initial)) m.set(k.toLowerCase(), v);
    return {
        m,
        getHeader: (n: string) => m.get(n.toLowerCase()),
        removeHeader: (n: string) => {
            m.delete(n.toLowerCase());
        },
        setHeader: (n: string, v: string | string[]) => {
            m.set(n.toLowerCase(), v);
        },
    };
}

const cfgFor = (provider: string) =>
    loadCdnConfig({ ...CDN_ENV, KNEXT_CDN_PROVIDER: provider });

describe("stripForeignEdgeHeaders (pure)", () => {
    it("a response already carrying edge headers ends up with none of them (stored headers)", () => {
        const res = fakeRes({
            ...FOREIGN,
            "Cache-Control": COMPAT_CC,
            "Content-Type": "text/html",
        });
        expect(stripForeignEdgeHeaders(cfgFor("cloudflare"), res, null)).toBe(
            true,
        );
        expect([...res.m.keys()].sort()).toEqual([
            "cache-control",
            "content-type",
        ]);
        expect(res.m.get("cache-control")).toBe(COMPAT_CC);
    });

    it("strips them from an object-form writeHead headers argument, any case", () => {
        const res = fakeRes();
        const hdrs: Record<string, string> = {
            "CLOUDFLARE-CDN-CACHE-CONTROL": FOREIGN_CF,
            "cdn-cache-control": FOREIGN_CDN,
            "Cache-Tag": FOREIGN_TAGS,
            "Content-Type": "text/html",
        };
        expect(stripForeignEdgeHeaders(cfgFor("cloudflare"), res, hdrs)).toBe(
            true,
        );
        expect(hdrs).toEqual({ "Content-Type": "text/html" });
    });

    it("strips them from flat and pair-array writeHead headers, in place", () => {
        const flat = [
            "Content-Type",
            "text/html",
            "Cloudflare-CDN-Cache-Control",
            FOREIGN_CF,
            "Cache-Tag",
            FOREIGN_TAGS,
        ];
        expect(
            stripForeignEdgeHeaders(cfgFor("cloudflare"), fakeRes(), flat),
        ).toBe(true);
        expect(flat).toEqual(["Content-Type", "text/html"]);
        const pairs = [
            ["CDN-Cache-Control", FOREIGN_CDN],
            ["Content-Type", "text/html"],
            ["cache-tag", FOREIGN_TAGS],
        ];
        expect(
            stripForeignEdgeHeaders(cfgFor("cloudflare"), fakeRes(), pairs),
        ).toBe(true);
        expect(pairs).toEqual([["Content-Type", "text/html"]]);
    });

    it("strips only the ROW's tag header (Azure has none to strip)", () => {
        const res = fakeRes({ "Cache-Tag": FOREIGN_TAGS });
        expect(
            stripForeignEdgeHeaders(cfgFor("azure-front-door"), res, null),
        ).toBe(false);
        expect(res.m.get("cache-tag")).toBe(FOREIGN_TAGS);
    });

    it("on rows without an edge-only header, drops an s-maxage the decision did not produce", () => {
        for (const provider of ["cloudfront", "azure-front-door"]) {
            const res = fakeRes({
                "Cache-Control": "public, max-age=0, s-maxage=60",
            });
            const hdrs: Record<string, string> = {
                "cache-control": "S-MaxAge=60, public",
            };
            expect(stripForeignEdgeHeaders(cfgFor(provider), res, hdrs)).toBe(
                true,
            );
            expect(res.m.get("cache-control")).toBe("public, max-age=0");
            expect(hdrs["cache-control"]).toBe("public");
        }
        // Only s-maxage goes: nothing else of the value is rewritten.
        const only = fakeRes({ "Cache-Control": "s-maxage=60" });
        stripForeignEdgeHeaders(cfgFor("cloudfront"), only, null);
        expect(only.m.has("cache-control")).toBe(false);
    });

    it("leaves Cache-Control alone on rows that have an edge-only header", () => {
        const res = fakeRes({ "Cache-Control": "public, s-maxage=60" });
        expect(stripForeignEdgeHeaders(cfgFor("cloudflare"), res, null)).toBe(
            false,
        );
        expect(res.m.get("cache-control")).toBe("public, s-maxage=60");
    });

    it("reports false and changes nothing when there is nothing foreign", () => {
        const res = fakeRes({ "Cache-Control": COMPAT_CC });
        const hdrs = { "Content-Type": "text/html" };
        expect(stripForeignEdgeHeaders(cfgFor("cloudflare"), res, hdrs)).toBe(
            false,
        );
        expect(hdrs).toEqual({ "Content-Type": "text/html" });
        expect(res.m.get("cache-control")).toBe(COMPAT_CC);
    });
});

function noForeign(r: RawResponse, label: string): void {
    for (const n of [...EDGE_NAMES, "cache-tag"]) {
        expect(r.header(n), `${label}: ${n}\n${r.head}`).toBeUndefined();
    }
}

async function metrics(port: number): Promise<string> {
    return (await get(port, "/", {}, {}, "metrics")).body;
}

function strippedCount(text: string): number {
    let n = 0;
    for (const line of text.split("\n")) {
        if (line.includes('reason="foreign_edge_header_stripped"'))
            n += Number(line.trim().split(" ").pop());
    }
    return n;
}

const MODES = [
    "write",
    "end",
    "writehead",
    "writehead-pairs",
    "writehead-flat",
    "append",
    "stream",
    "flush",
] as const;

for (const runtime of ["node", "bun"] as Runtime[]) {
    describe(`foreign edge headers over http (${runtime})`, () => {
        const isr = { cc: ISR_CC, ct: "text/html", tags: OWN_TAGS };

        it("a 'no' decision (middleware-matched) leaves with none of them, on every header path", async () => {
            const srv = await startServer({
                runtime,
                env: CDN_ENV,
                artifact: MATCHED,
            });
            try {
                for (const mode of MODES) {
                    const r = await get(srv.port, "/variant", {
                        ...isr,
                        mode,
                        extra: FOREIGN,
                    });
                    expect(r.status, mode).toBe(200);
                    noForeign(r, mode);
                    // The response is still served whole.
                    expect(r.body, mode).toContain(
                        mode.startsWith("writehead") || mode === "end"
                            ? "body"
                            : "bo",
                    );
                }
                expect(strippedCount(await metrics(srv.port))).toBe(
                    MODES.length,
                );
            } finally {
                srv.stop();
            }
        });

        it("every other 'no' path strips too: no request state, a throwing decision, no tags", async () => {
            const srv = await startServer({
                runtime,
                env: CDN_ENV,
                artifact: artifact(),
            });
            try {
                for (const kase of ["nostate", "poison"]) {
                    const r = await get(
                        srv.port,
                        "/blog",
                        { ...isr, extra: FOREIGN },
                        {},
                        kase,
                    );
                    expect(r.status, kase).toBe(200);
                    noForeign(r, kase);
                }
                const untagged = await get(srv.port, "/blog", {
                    ...isr,
                    tags: [],
                    extra: FOREIGN,
                });
                noForeign(untagged, "no tags");
                const m = await metrics(srv.port);
                expect(strippedCount(m)).toBe(3);
            } finally {
                srv.stop();
            }
        });

        it("an 'edge' decision is untouched: its own directive and tags, nothing stripped or counted", async () => {
            const srv = await startServer({
                runtime,
                env: CDN_ENV,
                artifact: artifact(),
            });
            try {
                for (const mode of ["write", "writehead", "stream"] as const) {
                    const r = await get(srv.port, "/blog", { ...isr, mode });
                    expect(r.header("cloudflare-cdn-cache-control"), mode).toBe(
                        "max-age=30",
                    );
                    expect(r.header("cache-tag"), mode).toBe(NOW_TAGS);
                    expect(r.header("cache-control"), mode).toBe(COMPAT_CC);
                }
                const m = await metrics(srv.port);
                expect(m).toContain(
                    'knext_cdn_edge_decision_total{result="edge",reason="allowed"} 3',
                );
                expect(strippedCount(m)).toBe(0);
            } finally {
                srv.stop();
            }
        });

        it("a 'no' decision with nothing foreign is counted under its own reason, not as stripped", async () => {
            const srv = await startServer({
                runtime,
                env: CDN_ENV,
                artifact: MATCHED,
            });
            try {
                const r = await get(srv.port, "/variant", isr);
                noForeign(r, "plain");
                const m = await metrics(srv.port);
                expect(m).toContain('reason="middleware_matched"} 1');
                expect(strippedCount(m)).toBe(0);
            } finally {
                srv.stop();
            }
        });

        it("CloudFront: an s-maxage the decision did not produce never leaves the origin", async () => {
            const srv = await startServer({
                runtime,
                env: { ...CDN_ENV, KNEXT_CDN_PROVIDER: "cloudfront" },
                artifact: MATCHED,
            });
            try {
                // appendHeader and the array forms bypass the browser-value
                // normaliser, so the raw s-maxage reached the wire before.
                for (const mode of [
                    "append",
                    "writehead-flat",
                    "writehead-pairs",
                ] as const) {
                    const r = await get(srv.port, "/variant", {
                        ct: "text/html",
                        tags: OWN_TAGS,
                        mode,
                        extra: { "Cache-Control": "public, s-maxage=60" },
                    });
                    expect(r.status, mode).toBe(200);
                    // (Bun routes appendHeader through setHeader, so there the
                    // normaliser already rewrote it; on Node the strip did.)
                    const cc = r.header("cache-control") ?? "";
                    expect(cc, mode).toContain("public");
                    expect(cc, mode).not.toMatch(/s-maxage/i);
                }
                // A non-GET response is passed through by the normaliser too.
                const post = await rawRequest(
                    srv.port,
                    [
                        "POST /variant HTTP/1.1",
                        "Host: example.test",
                        "Connection: close",
                        "Content-Length: 0",
                        `x-spec: ${JSON.stringify({ cc: "public, max-age=0, s-maxage=60", ct: "text/html" })}`,
                        "",
                        "",
                    ].join("\r\n"),
                );
                expect(post.header("cache-control")).toBe("public, max-age=0");
            } finally {
                srv.stop();
            }
        });

        it("CloudFront: the decision's own s-maxage on an 'edge' response stays", async () => {
            const srv = await startServer({
                runtime,
                env: { ...CDN_ENV, KNEXT_CDN_PROVIDER: "cloudfront" },
                artifact: artifact(),
            });
            try {
                const r = await get(srv.port, "/blog", isr);
                expect(r.header("cache-control")).toBe(
                    "public, max-age=0, s-maxage=30",
                );
            } finally {
                srv.stop();
            }
        });

        it("with CDN off the headers are byte-identical to the pre-CDN preload, foreign ones included", async () => {
            const before = await startServer({
                runtime,
                preload: FROZEN_PRE_CDN_PRELOAD,
            });
            const after = await startServer({ runtime, preload: PRELOAD });
            try {
                for (const mode of MODES) {
                    for (const spec of [
                        { ...isr, mode, extra: FOREIGN },
                        {
                            ct: "text/html",
                            mode,
                            extra: { "Cache-Control": "public, s-maxage=60" },
                        },
                    ]) {
                        const a = await get(before.port, "/variant", spec);
                        const b = await get(after.port, "/variant", spec);
                        const block = (h: string) =>
                            h
                                .split("\r\n")
                                .slice(1)
                                .filter(
                                    (l) => !l.toLowerCase().startsWith("date:"),
                                );
                        expect(a.status, mode).toBe(200);
                        expect(block(b.head), mode).toEqual(block(a.head));
                        if (spec.extra === FOREIGN) {
                            expect(
                                b.header("cloudflare-cdn-cache-control"),
                                mode,
                            ).toBe(FOREIGN_CF);
                        }
                    }
                }
            } finally {
                before.stop();
                after.stop();
            }
        });
    });
}
