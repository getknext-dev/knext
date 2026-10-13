// @vitest-environment node
//
// A proxied (external-style) middleware rewrite must not carry the INNER
// response's edge directive onto the OUTER, middleware-matched response
// (ADR-0068 D4.1 condition 10; Amendment 2).

import { afterAll, describe, expect, it } from "bun:test";
import {
    buildKindApp,
    cleanupKindApp,
    getRaw,
    KIND_PREFIX,
    serveKindApp,
} from "./cdn-kind-app-harness";

/**
 * THE REPRO (the CDN-3a fixture `fixtures/cdn-kind-app`, real `next build`, the
 * real knext adapter and cache handler, the standalone server on Node and Bun).
 *
 * `proxy.ts` rewrites `/variant` by cookie with `new URL('/variant-a',
 * request.url)`. Bound to `127.0.0.1`, Next's `request.url` host is `localhost`,
 * so the destination is a DIFFERENT origin and Next handles the rewrite as an
 * EXTERNAL one: it proxies it over HTTP. The proxied inner request reaches the
 * preload as a fresh request on an unmatched path, gets an allowed edge
 * decision and edge headers, and Next copies the inner response's headers onto
 * the outer response, whose path IS middleware-matched (condition 10). Before
 * the fix the outer `/variant` response left the origin carrying
 * `cloudflare-cdn-cache-control` and `cache-tag`, and a Vary-ignoring CDN served
 * variant A to a variant-B visitor.
 *
 * The preconditions are asserted, not assumed, so this cannot go green by the
 * rewrite turning internal (`x-middleware-rewrite` must be the absolute
 * loopback URL) or by nothing being edge-cacheable at all (`/variant-a`
 * requested directly must carry the edge directive).
 *
 * NOTHING here skips: a missing precondition is a FAILURE, never a silent pass.
 */

const EDGE = "cloudflare-cdn-cache-control";

// Removing the built trees can outlast bun's default 5 s hook timeout.
afterAll(cleanupKindApp, 120_000);

for (const runtime of ["node", "bun"] as const) {
    describe(`CDN: a proxied middleware rewrite on a 127.0.0.1 bind, real Next (${runtime})`, () => {
        it("the outer, middleware-matched response carries no edge directive and no cache tag", async () => {
            const b = await buildKindApp();
            const s = await serveKindApp(b, runtime);
            try {
                // Precondition 1: the inner page IS edge-cacheable on its own, so
                // the headers the rewrite would carry over really exist. (Twice:
                // the first request may render, the second is a HIT.)
                await getRaw(s.port, "/variant-a");
                const inner = await getRaw(s.port, "/variant-a");
                expect(inner.status, s.log()).toBe(200);
                expect(inner.header(EDGE), inner.head).toBe("max-age=30");
                expect(inner.header("cache-tag"), inner.head).toContain(
                    `kn-${KIND_PREFIX}`,
                );

                for (const [cookie, body] of [
                    ["v=a", "VARIANT-A-BODY"],
                    ["v=b", "VARIANT-B-BODY"],
                ] as const) {
                    const r = await getRaw(s.port, "/variant", cookie);
                    expect(r.status, `${r.head}\n${s.log()}`).toBe(200);
                    expect(r.body).toContain(body);
                    // Precondition 2: the rewrite was handled as EXTERNAL (proxied
                    // over HTTP to an absolute loopback URL), not internally.
                    expect(r.header("x-middleware-rewrite") ?? "").toMatch(
                        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/variant-/,
                    );
                    // The fix: none of the inner response's edge headers survive.
                    expect(r.header(EDGE), r.head).toBeUndefined();
                    expect(
                        r.header("cdn-cache-control"),
                        r.head,
                    ).toBeUndefined();
                    expect(r.header("cache-tag"), r.head).toBeUndefined();
                }
            } finally {
                s.stop();
            }
        }, 300_000);
    });
}
