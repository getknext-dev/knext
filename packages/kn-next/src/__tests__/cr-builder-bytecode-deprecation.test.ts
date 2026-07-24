import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    __resetLegacyBytecodeInferenceWarning,
    buildNextAppCRObject,
} from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * #457 — the CLI's legacy `redis ⇒ on` bytecode-cache inference is DEPRECATED.
 *
 * When `bytecodeCache` is unset and `cache.provider === "redis"`, cr-builder
 * historically flips `enableBytecodeCache` on implicitly. That inference (and
 * the operator PVC path it feeds) is superseded by the image-baked V8 compile
 * cache (ADR-0035). We now warn to STDERR on that path so users set
 * `bytecodeCache.enabled` explicitly — WITHOUT changing the computed CR.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(
    overrides: Partial<KnativeNextConfig> = {},
): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://example.com",
        },
        ...overrides,
    };
}

const REDIS: KnativeNextConfig["cache"] = {
    provider: "redis",
    url: "redis://r:6379",
};

describe("#457 legacy redis⇒on bytecode inference deprecation warning", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        __resetLegacyBytecodeInferenceWarning();
        // The warning MUST go to stderr (fd 2), never stdout (which may carry the CR YAML).
        warnSpy = vi
            .spyOn(process.stderr, "write")
            .mockImplementation(() => true);
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    function warnedDeprecation(): boolean {
        return warnSpy.mock.calls.some((args) =>
            args.some(
                (a) =>
                    typeof a === "string" &&
                    /deprecat/i.test(a) &&
                    /bytecodeCache\.enabled/.test(a),
            ),
        );
    }

    it("(a) warns on the legacy-inference path (bytecodeCache unset + redis provider)", () => {
        buildNextAppCRObject(baseConfig({ cache: REDIS }), IMG, "ns");
        expect(warnedDeprecation()).toBe(true);
    });

    it("(b) does NOT warn when bytecodeCache.enabled is set explicitly", () => {
        buildNextAppCRObject(
            baseConfig({ cache: REDIS, bytecodeCache: { enabled: true } }),
            IMG,
            "ns",
        );
        expect(warnedDeprecation()).toBe(false);
    });

    it("(b2) does NOT warn when bytecodeCache.enabled is explicitly false with a redis provider", () => {
        buildNextAppCRObject(
            baseConfig({ cache: REDIS, bytecodeCache: { enabled: false } }),
            IMG,
            "ns",
        );
        expect(warnedDeprecation()).toBe(false);
    });

    it("(c) does NOT warn when the provider is not redis", () => {
        buildNextAppCRObject(baseConfig(), IMG, "ns");
        expect(warnedDeprecation()).toBe(false);
    });

    it("(d) the produced CR is byte-identical to a build with the warning suppressed", () => {
        // Reset so both calls take the same code path; the warning is a
        // side-effect only, the returned CR object must be unchanged.
        const withWarn = buildNextAppCRObject(
            baseConfig({ cache: REDIS }),
            IMG,
            "ns",
        );
        __resetLegacyBytecodeInferenceWarning();
        const again = buildNextAppCRObject(
            baseConfig({ cache: REDIS }),
            IMG,
            "ns",
        );
        expect(withWarn).toEqual(again);
        // And the legacy inference still flipped bytecode caching ON.
        const cache = (withWarn.spec as Record<string, unknown>).cache as
            | Record<string, unknown>
            | undefined;
        expect(cache?.enableBytecodeCache).toBe(true);
    });

    it("warns only once per process (one-time)", () => {
        buildNextAppCRObject(baseConfig({ cache: REDIS }), IMG, "ns");
        buildNextAppCRObject(baseConfig({ cache: REDIS }), IMG, "ns");
        const deprecationCalls = warnSpy.mock.calls.filter((args) =>
            args.some((a) => typeof a === "string" && /deprecat/i.test(a)),
        );
        expect(deprecationCalls.length).toBe(1);
    });
});
