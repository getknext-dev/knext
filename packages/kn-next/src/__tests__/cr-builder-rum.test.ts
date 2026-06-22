import { describe, expect, it } from "vitest";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * #94 — RUM config threading.
 *
 * observability.rum (default OFF) must flow into the NextApp CR's
 * spec.observability so the operator can propagate NEXT_PUBLIC_RUM_ENABLED /
 * NEXT_PUBLIC_RUM_SAMPLE_RATE to the pod. RUM requires observability.enabled.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(
    observability?: KnativeNextConfig["observability"],
): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://example.com",
        },
        observability,
    };
}

function specOf(config: KnativeNextConfig) {
    const cr = buildNextAppCRObject(config, IMG, "ns");
    return cr.spec as Record<string, unknown>;
}

describe("buildNextAppCRObject — RUM", () => {
    it("omits rum when observability is disabled", () => {
        const spec = specOf(
            baseConfig({ enabled: false, rum: { enabled: true } }),
        );
        expect(spec.observability).toBeUndefined();
    });

    it("omits rum block when not configured (default off)", () => {
        const spec = specOf(baseConfig({ enabled: true }));
        const obs = spec.observability as Record<string, unknown>;
        expect(obs).toEqual({ enabled: true });
        expect(obs.rum).toBeUndefined();
    });

    it("threads rum.enabled into spec.observability.rum, emitting sampleRate as a STRING", () => {
        const spec = specOf(
            baseConfig({
                enabled: true,
                rum: { enabled: true, sampleRate: 0.5 },
            }),
        );
        const obs = spec.observability as Record<string, unknown>;
        expect(obs.enabled).toBe(true);
        // The CRD types observability.rum.sampleRate as a string; emitting a
        // number would fail `kubectl apply` OpenAPI validation (#94).
        const rum = obs.rum as Record<string, unknown>;
        expect(typeof rum.sampleRate).toBe("string");
        expect(obs.rum).toEqual({ enabled: true, sampleRate: "0.5" });
    });

    it('stringifies an integer sampleRate (e.g. 1 → "1")', () => {
        const spec = specOf(
            baseConfig({
                enabled: true,
                rum: { enabled: true, sampleRate: 1 },
            }),
        );
        const rum = (spec.observability as Record<string, unknown>)
            .rum as Record<string, unknown>;
        expect(rum.sampleRate).toBe("1");
        expect(typeof rum.sampleRate).toBe("string");
    });

    it("threads rum.enabled without sampleRate", () => {
        const spec = specOf(
            baseConfig({ enabled: true, rum: { enabled: true } }),
        );
        const obs = spec.observability as Record<string, unknown>;
        expect(obs.rum).toEqual({ enabled: true });
    });
});
