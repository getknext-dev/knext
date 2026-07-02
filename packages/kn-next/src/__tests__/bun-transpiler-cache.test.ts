/**
 * Bun transpiler-cache wiring for runtime=bun — the Bun analog of knext's
 * NODE_COMPILE_CACHE cold-start story.
 *
 * Evidence (measured on a real next@16.2.4 output:'standalone' build, Bun
 * 1.3.5, N=12, time from spawn to first successful dynamic-route response):
 *   - bun server.js, cache disabled:        median 287ms
 *   - bun server.js, warm transpiler cache: median 231ms  (-56ms, ~20%)
 *   - cold populate overhead:               ~8ms (negligible, one-time)
 *   - fail-open: read-only / nonexistent cache dir → server still serves
 *     (page 200, API 200, 404) — Bun silently skips caching.
 *
 * What Bun caches: `.pile` files containing the TRANSPILED CJS SOURCE of
 * modules ≥ ~50KB (13 files / 4.2MB for a minimal Next app — next-server,
 * base-server, react-dom-server, the parse-heavy chunks). It is NOT JSC
 * bytecode — Bun has no runtime bytecode cache; its bytecode only exists via
 * `bun build --compile`, which HARD-FAILS on the Next standalone server
 * (unresolvable dev-only requires; runtime-computed chunk requires). Hence
 * the runtime cache env var is the mechanism knext ships.
 *
 * Wiring mirrors NODE_COMPILE_CACHE exactly:
 *   - the operator injects BUN_RUNTIME_TRANSPILER_CACHE_PATH when
 *     spec.runtime == "bun" (same bytecode-cache PVC, /cache/bytecode/bun-transpiler);
 *   - buildChildEnv inherits it via spread, and — when the runtime entry
 *     itself runs under Bun with only NODE_COMPILE_CACHE present (older
 *     operator, runtime flipped to bun) — derives the Bun path from the
 *     mounted cache dir so the PVC is not dead weight. Node child env stays
 *     byte-identical: the derivation is gated on running under Bun.
 */

import { describe, expect, it } from "vitest";
import { buildChildEnv, deriveBunTranspilerCachePath } from "../adapters/env";

describe("deriveBunTranspilerCachePath", () => {
    it("derives a sibling bun-transpiler dir from NODE_COMPILE_CACHE under Bun", () => {
        expect(
            deriveBunTranspilerCachePath(
                { NODE_COMPILE_CACHE: "/cache/bytecode/latest" },
                true,
            ),
        ).toBe("/cache/bytecode/bun-transpiler");
    });

    it("returns undefined when not running under Bun (Node env byte-identical)", () => {
        expect(
            deriveBunTranspilerCachePath(
                { NODE_COMPILE_CACHE: "/cache/bytecode/latest" },
                false,
            ),
        ).toBeUndefined();
    });

    it("returns undefined when NODE_COMPILE_CACHE is unset (nothing mounted)", () => {
        expect(deriveBunTranspilerCachePath({}, true)).toBeUndefined();
    });

    it("never overrides an explicit BUN_RUNTIME_TRANSPILER_CACHE_PATH", () => {
        expect(
            deriveBunTranspilerCachePath(
                {
                    NODE_COMPILE_CACHE: "/cache/bytecode/latest",
                    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "/elsewhere",
                },
                true,
            ),
        ).toBeUndefined();
    });

    it('respects the explicit disable sentinel ("0")', () => {
        expect(
            deriveBunTranspilerCachePath(
                {
                    NODE_COMPILE_CACHE: "/cache/bytecode/latest",
                    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
                },
                true,
            ),
        ).toBeUndefined();
    });
});

describe("buildChildEnv bun transpiler cache", () => {
    const SAVED: Record<string, string | undefined> = {
        NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH:
            process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
    };
    const restore = () => {
        for (const [k, v] of Object.entries(SAVED)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };

    it("forwards an operator-injected BUN_RUNTIME_TRANSPILER_CACHE_PATH to the child", () => {
        try {
            process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH =
                "/cache/bytecode/bun-transpiler";
            expect(buildChildEnv().BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(
                "/cache/bytecode/bun-transpiler",
            );
        } finally {
            restore();
        }
    });

    it("derives the Bun cache path from NODE_COMPILE_CACHE only when running under Bun", () => {
        try {
            delete process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
            process.env.NODE_COMPILE_CACHE = "/cache/bytecode/latest";
            const env = buildChildEnv();
            if (process.versions.bun) {
                expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(
                    "/cache/bytecode/bun-transpiler",
                );
            } else {
                // Node path byte-identical: no Bun var appears from nowhere.
                expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBeUndefined();
            }
        } finally {
            restore();
        }
    });

    it("keeps NODE_COMPILE_CACHE inherited untouched", () => {
        try {
            process.env.NODE_COMPILE_CACHE = "/cache/bytecode/latest";
            expect(buildChildEnv().NODE_COMPILE_CACHE).toBe(
                "/cache/bytecode/latest",
            );
        } finally {
            restore();
        }
    });
});
