/**
 * ZERO DIFF (ADR-0068 D3): with no `spec.cdn` (no `KNEXT_CDN_PROVIDER`) the
 * response headers are byte-identical to what they were before the CDN tier
 * existed. The oracle is a FROZEN copy of the pre-CDN preload
 * (`fixtures/cache-control-normalize.pre-cdn.cjs`), run against the same stand-in
 * server and the same requests as the current preload, on Node and on Bun; the
 * entire raw response header block is compared (minus `date`).
 *
 * Also D12: CDN mode wins over the deprecated `KNEXT_CACHE_CONTROL_NORMALIZE=0`.
 */
import { describe, expect, it } from "bun:test";
import {
    artifact,
    CDN_ENV,
    FROZEN_PRE_CDN_PRELOAD,
    get,
    ISR_CC,
    OWN_TAGS,
    PRELOAD,
    type Runtime,
    startServer,
} from "./cdn-test-harness";

const SHELL = "private, no-cache, no-store, max-age=0, must-revalidate";
const corpus: Array<
    [string, string, Record<string, unknown>, Record<string, string>]
> = [
    ["ISR page", "/blog", { cc: ISR_CC, ct: "text/html", tags: OWN_TAGS }, {}],
    [
        "ISR page via writeHead",
        "/blog",
        { cc: ISR_CC, ct: "text/html", mode: "writehead" },
        {},
    ],
    [
        "ISR page via end",
        "/blog",
        { cc: ISR_CC, ct: "text/html", mode: "end" },
        {},
    ],
    [
        "revalidate:false",
        "/static",
        { cc: "s-maxage=31536000", ct: "text/html" },
        {},
    ],
    [
        "fallback shell",
        "/blog/x",
        { cc: SHELL, ct: "text/html", extra: { "x-nextjs-cache": "MISS" } },
        {},
    ],
    [
        "immutable asset",
        "/_next/static/a.js",
        { cc: "public, max-age=31536000, immutable", ct: "text/javascript" },
        {},
    ],
    ["no cache-control", "/dyn", { ct: "text/html" }, {}],
    [
        "private dynamic",
        "/dyn",
        { cc: "private, no-cache, no-store, max-age=0", ct: "text/html" },
        {},
    ],
    [
        "Set-Cookie",
        "/dyn",
        { cc: ISR_CC, ct: "text/html", setCookie: true },
        {},
    ],
    [
        "RSC request",
        "/blog?_rsc=abc",
        { cc: ISR_CC, ct: "text/x-component" },
        { RSC: "1" },
    ],
    [
        "redirect",
        "/old",
        { status: 308, extra: { Location: "/new", Vary: "Host" } },
        {},
    ],
    ["404", "/missing", { status: 404, cc: "private, no-cache, no-store" }, {}],
    [
        "data route",
        "/_next/data/b/blog.json",
        { cc: ISR_CC, ct: "application/json" },
        {},
    ],
    ["weird path", "/x/%2e%2e/dashboard", { cc: ISR_CC, ct: "text/html" }, {}],
];

/** The response header block, wire order, without the volatile `date`. */
function block(head: string): string[] {
    return head
        .split("\r\n")
        .slice(1)
        .filter((l) => !l.toLowerCase().startsWith("date:"));
}

for (const runtime of ["node", "bun"] as Runtime[]) {
    describe(`zero diff without spec.cdn (${runtime})`, () => {
        it("every response's header block equals the frozen pre-CDN preload's", async () => {
            const before = await startServer({
                runtime,
                preload: FROZEN_PRE_CDN_PRELOAD,
            });
            const after = await startServer({ runtime, preload: PRELOAD });
            try {
                for (const [name, path, spec, hdrs] of corpus) {
                    const a = await get(before.port, path, spec, hdrs);
                    const b = await get(after.port, path, spec, hdrs);
                    expect(a.status, name).toBeGreaterThan(0);
                    expect(block(b.head), name).toEqual(block(a.head));
                }
            } finally {
                before.stop();
                after.stop();
            }
        });

        it("no KNEXT_CDN_* env at all adds no edge or tag header, ever", async () => {
            const srv = await startServer({ runtime, preload: PRELOAD });
            try {
                for (const [name, path, spec, hdrs] of corpus) {
                    const r = await get(srv.port, path, spec, hdrs);
                    const names = r.headers.map(([n]) => n);
                    expect(names, name).not.toContain("cache-tag");
                    expect(names, name).not.toContain(
                        "cloudflare-cdn-cache-control",
                    );
                    expect(names, name).not.toContain("cdn-cache-control");
                }
            } finally {
                srv.stop();
            }
        });

        it("an invalid CDN config (bad tag prefix) is inert: still the frozen behaviour", async () => {
            const before = await startServer({
                runtime,
                preload: FROZEN_PRE_CDN_PRELOAD,
            });
            const bad = await startServer({
                runtime,
                preload: PRELOAD,
                env: { ...CDN_ENV, KNEXT_CDN_TAG_PREFIX: "victim" },
                artifact: artifact(),
            });
            try {
                for (const [name, path, spec, hdrs] of corpus) {
                    const a = await get(before.port, path, spec, hdrs);
                    const b = await get(bad.port, path, spec, hdrs);
                    expect(block(b.head), name).toEqual(block(a.head));
                }
            } finally {
                before.stop();
                bad.stop();
            }
        });

        it("KNEXT_CACHE_CONTROL_NORMALIZE=0 without CDN still installs nothing (unchanged)", async () => {
            const srv = await startServer({
                runtime,
                preload: PRELOAD,
                env: { KNEXT_CACHE_CONTROL_NORMALIZE: "0" },
            });
            try {
                const r = await get(srv.port, "/blog", {
                    cc: ISR_CC,
                    ct: "text/html",
                });
                expect(r.header("cache-control")).toBe(ISR_CC);
            } finally {
                srv.stop();
            }
        });

        it("CDN mode wins over KNEXT_CACHE_CONTROL_NORMALIZE=0 (D12), with one log line", async () => {
            const srv = await startServer({
                runtime,
                preload: PRELOAD,
                env: { ...CDN_ENV, KNEXT_CACHE_CONTROL_NORMALIZE: "0" },
                artifact: artifact(),
            });
            try {
                const r = await get(srv.port, "/blog", {
                    cc: ISR_CC,
                    ct: "text/html",
                    tags: OWN_TAGS,
                });
                expect(r.header("cache-control")).toBe(
                    "public, max-age=0, must-revalidate",
                );
                expect(r.header("cloudflare-cdn-cache-control")).toBe(
                    "max-age=30",
                );
                const lines = srv
                    .output()
                    .split("\n")
                    .filter((l) =>
                        l.includes(
                            "KNEXT_CACHE_CONTROL_NORMALIZE=0 ignored (CDN mode is on)",
                        ),
                    );
                expect(lines.length).toBe(1);
            } finally {
                srv.stop();
            }
        });
    });
}
