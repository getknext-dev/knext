/**
 * Golden response headers per provider row, over real http on Node and Bun
 * (ADR-0068 D2/D4.2). Which header carries the edge directive, whether the browser
 * `Cache-Control` changes, and where the tags go are the contract a CDN is
 * configured against, so each row is pinned to the exact wire bytes.
 */
import { describe, expect, it } from "bun:test";
import {
    artifact,
    CDN_ENV,
    get,
    ISR_CC,
    OWN_TAGS,
    type Runtime,
    startServer,
} from "./cdn-test-harness";

const TAGS = [
    "kn-abcdef012345",
    "kn-abcdef012345-bf1adbc6c3c0e",
    "kn-abcdef012345-tf015a2ba450e9cbd",
    "kn-abcdef012345-ta44f1b9751711635",
].join(",");
const COMPAT = "public, max-age=0, must-revalidate";

const rows: Array<{
    provider: string;
    env?: Record<string, string>;
    expect: Record<string, string | null>;
}> = [
    {
        provider: "cloudflare",
        expect: {
            "cache-control": COMPAT,
            "cloudflare-cdn-cache-control": "max-age=30",
            "cdn-cache-control": null,
            "cache-tag": TAGS,
        },
    },
    {
        provider: "cloudflare",
        env: { KNEXT_CDN_SWR_SECONDS: "20", KNEXT_CDN_HTML_TTL_SECONDS: "45" },
        expect: {
            "cache-control": COMPAT,
            "cloudflare-cdn-cache-control":
                "max-age=45, stale-while-revalidate=20",
            "cache-tag": TAGS,
        },
    },
    {
        provider: "google-cloud-cdn",
        expect: {
            "cache-control": COMPAT,
            "cdn-cache-control": "max-age=30",
            "cloudflare-cdn-cache-control": null,
            "cache-tag": TAGS,
        },
    },
    {
        provider: "cloudfront",
        expect: {
            "cache-control": "public, max-age=0, s-maxage=30",
            "cloudflare-cdn-cache-control": null,
            "cdn-cache-control": null,
            "cache-tag": TAGS,
        },
    },
    {
        provider: "azure-front-door",
        expect: {
            "cache-control": "public, max-age=0, s-maxage=30",
            "cloudflare-cdn-cache-control": null,
            "cache-tag": null,
        },
    },
    {
        provider: "emulator",
        env: { KNEXT_CDN_EMULATOR_ENDPOINT: "http://e.ns.svc.cluster.local" },
        expect: {
            "cache-control": COMPAT,
            "cloudflare-cdn-cache-control": "max-age=30",
            "cache-tag": TAGS,
        },
    },
];

for (const runtime of ["node", "bun"] as Runtime[]) {
    describe(`golden headers per provider (${runtime})`, () => {
        for (const row of rows) {
            const label = `${row.provider}${row.env ? ` ${JSON.stringify(row.env)}` : ""}`;
            for (const mode of ["write", "writehead"] as const) {
                it(`${label} (${mode})`, async () => {
                    const srv = await startServer({
                        runtime,
                        env: {
                            ...CDN_ENV,
                            KNEXT_CDN_PROVIDER: row.provider,
                            ...row.env,
                        },
                        artifact: artifact(),
                    });
                    try {
                        const r = await get(srv.port, "/blog", {
                            cc: ISR_CC,
                            ct: "text/html",
                            tags: OWN_TAGS,
                            mode,
                        });
                        for (const [name, value] of Object.entries(
                            row.expect,
                        )) {
                            if (value === null)
                                expect(r.header(name), name).toBeUndefined();
                            else expect(r.header(name), name).toBe(value);
                        }
                    } finally {
                        srv.stop();
                    }
                });
            }
        }

        it("an over-limit Google tag set is uncacheable, over the wire", async () => {
            const srv = await startServer({
                runtime,
                env: { ...CDN_ENV, KNEXT_CDN_PROVIDER: "google-cloud-cdn" },
                artifact: artifact(),
            });
            try {
                const many = Array.from({ length: 60 }, (_, i) => `t${i}`);
                const r = await get(srv.port, "/blog", {
                    cc: ISR_CC,
                    ct: "text/html",
                    tags: [{ kind: "page", tags: ["_N_T_/blog", ...many] }],
                });
                expect(r.header("cdn-cache-control")).toBeUndefined();
                expect(r.header("cache-tag")).toBeUndefined();
            } finally {
                srv.stop();
            }
        });

        it("CloudFront/Azure never cache an _rsc URL (their key depends on a policy knext cannot see)", async () => {
            for (const provider of ["cloudfront", "azure-front-door"]) {
                const srv = await startServer({
                    runtime,
                    env: { ...CDN_ENV, KNEXT_CDN_PROVIDER: provider },
                    artifact: artifact(),
                });
                try {
                    const r = await get(
                        srv.port,
                        "/blog?_rsc=abc",
                        { cc: ISR_CC, ct: "text/x-component", tags: OWN_TAGS },
                        { RSC: "1" },
                    );
                    expect(r.header("cache-control"), provider).toBe(COMPAT);
                } finally {
                    srv.stop();
                }
            }
        });
    });
}
