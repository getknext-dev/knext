/**
 * #175 (compat B7b, #147 A3-3) — deployed-platform Cache-Control normalization.
 *
 * Evidence (compat run 28578203671, test/e2e/prerender.test.ts in deploy mode):
 *   ✕ revalidate page            expected "public, max-age=0, must-revalidate"
 *                                received "s-maxage=2, stale-while-revalidate=31535998"
 *   ✕ fallback-true (prerendered) same diff
 *   ✕ fallback-true (lazy)       expected "public, max-age=0, must-revalidate"
 *                                received "private, no-cache, no-store, max-age=0, must-revalidate"
 *   ✕ no-revalidate page         expected "public, max-age=0, must-revalidate"
 *                                received "s-maxage=31536000"
 *
 * Mechanism: Next's origin (packages/next/src/server/lib/cache-control.ts
 * getCacheControlHeader) ALWAYS emits `s-maxage=…` shared-cache directives; the
 * deploy-mode suite asserts what a DEPLOYED platform edge returns to the client
 * after consuming them. The OFFICIAL reference adapter (nextjs/adapter-bun,
 * src/runtime/server.ts normalizeCacheControlHeader) implements exactly this
 * normalization in its serving layer — so it is adapter-serving semantics, not a
 * Vercel-CDN-only artifact. knext ships the same rules as a dependency-free CJS
 * preload (`node --require`) applied to the standalone server:
 *   - `s-maxage=…` (no `immutable`)      → `public, max-age=0, must-revalidate`
 *   - pages-router fallback-shell `private, no-cache, no-store, max-age=0,
 *     must-revalidate` WITH an x-nextjs-cache marker on a non-/_next/data/
 *     GET/HEAD request                    → `public, max-age=0, must-revalidate`
 *   - `immutable` values, non-GET/HEAD, marker-less private responses → untouched
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const MODULE_PATH = resolve(
    import.meta.dirname,
    "../adapters/cache-control-normalize.cjs",
);

const PUBLIC_DEPLOY = "public, max-age=0, must-revalidate";
const PRIVATE_FALLBACK =
    "private, no-cache, no-store, max-age=0, must-revalidate";

// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
let mod: any;

beforeAll(() => {
    // Disable the auto-install side effect (prototype patch) — this file unit
    // tests the pure rule; the real `node --require` wiring is covered by the
    // e2e-deploy contract test.
    process.env.KNEXT_CACHE_CONTROL_NORMALIZE = "0";
    mod = require(MODULE_PATH);
});

describe("cache-control-normalize — deployed-platform header rules (#175)", () => {
    const ctx = (over: Record<string, unknown> = {}) => ({
        method: "GET",
        url: "/",
        hasNextCacheMarker: true,
        ...over,
    });

    it("rewrites ISR s-maxage + stale-while-revalidate to the deploy value", () => {
        expect(
            mod.normalizeCacheControl(
                "s-maxage=2, stale-while-revalidate=31535998",
                ctx(),
            ),
        ).toBe(PUBLIC_DEPLOY);
    });

    it("rewrites no-revalidate s-maxage=31536000 to the deploy value", () => {
        expect(mod.normalizeCacheControl("s-maxage=31536000", ctx())).toBe(
            PUBLIC_DEPLOY,
        );
    });

    it("rewrites the pages-router fallback-shell private value when the x-nextjs-cache marker is present", () => {
        expect(
            mod.normalizeCacheControl(
                PRIVATE_FALLBACK,
                ctx({ url: "/fallback-true/second" }),
            ),
        ).toBe(PUBLIC_DEPLOY);
    });

    it("keeps the private value for /_next/data/ requests (data responses are never fallback shells)", () => {
        expect(
            mod.normalizeCacheControl(
                PRIVATE_FALLBACK,
                ctx({ url: "/_next/data/BUILDID/fallback-true/second.json" }),
            ),
        ).toBe(PRIVATE_FALLBACK);
    });

    it("keeps the private value for genuinely dynamic responses (no x-nextjs-cache marker)", () => {
        expect(
            mod.normalizeCacheControl(
                PRIVATE_FALLBACK,
                ctx({ hasNextCacheMarker: false }),
            ),
        ).toBe(PRIVATE_FALLBACK);
    });

    it("keeps immutable static-asset values untouched", () => {
        const immutable = "public, max-age=31536000, immutable";
        expect(mod.normalizeCacheControl(immutable, ctx())).toBe(immutable);
    });

    it("keeps values untouched for non-GET/HEAD requests", () => {
        expect(
            mod.normalizeCacheControl("s-maxage=2", ctx({ method: "POST" })),
        ).toBe("s-maxage=2");
    });

    it("joins array header values before normalizing", () => {
        expect(
            mod.normalizeCacheControl(
                ["s-maxage=2", "stale-while-revalidate=1"],
                ctx(),
            ),
        ).toBe(PUBLIC_DEPLOY);
    });

    it("passes through empty/undefined values unchanged", () => {
        expect(mod.normalizeCacheControl("", ctx())).toBe("");
        expect(mod.normalizeCacheControl(undefined, ctx())).toBe("");
    });

    it("exports an idempotent install() for the http.ServerResponse prototype patch", () => {
        expect(typeof mod.install).toBe("function");
    });
});
