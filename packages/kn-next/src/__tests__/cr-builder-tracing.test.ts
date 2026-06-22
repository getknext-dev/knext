import { describe, expect, it } from "vitest";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * #30 — OTel tracing config threading.
 *
 * observability.tracing (default OFF) must flow into the NextApp CR's
 * spec.observability.tracing so the operator can propagate OTEL_TRACING_ENABLED /
 * OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_TRACES_SAMPLER_ARG to the pod. Tracing
 * requires observability.enabled. Mirrors the RUM (#94) pattern.
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

describe("buildNextAppCRObject — tracing", () => {
    it("omits tracing when observability is disabled", () => {
        const spec = specOf(
            baseConfig({ enabled: false, tracing: { enabled: true } }),
        );
        expect(spec.observability).toBeUndefined();
    });

    it("omits tracing block when not configured (default off)", () => {
        const spec = specOf(baseConfig({ enabled: true }));
        const obs = spec.observability as Record<string, unknown>;
        expect(obs).toEqual({ enabled: true });
        expect(obs.tracing).toBeUndefined();
    });

    it("threads tracing.enabled into spec.observability.tracing, emitting sampleRate as a STRING", () => {
        const spec = specOf(
            baseConfig({
                enabled: true,
                tracing: {
                    enabled: true,
                    endpoint: "http://tempo.monitoring:4317",
                    sampleRate: 0.5,
                },
            }),
        );
        const obs = spec.observability as Record<string, unknown>;
        expect(obs.enabled).toBe(true);
        // The CRD types observability.tracing.sampleRate as a string; emitting a
        // number would fail `kubectl apply` OpenAPI validation (same reason as RUM).
        const tracing = obs.tracing as Record<string, unknown>;
        expect(typeof tracing.sampleRate).toBe("string");
        expect(obs.tracing).toEqual({
            enabled: true,
            endpoint: "http://tempo.monitoring:4317",
            sampleRate: "0.5",
        });
    });

    it('stringifies an integer sampleRate (e.g. 1 → "1")', () => {
        const spec = specOf(
            baseConfig({
                enabled: true,
                tracing: { enabled: true, sampleRate: 1 },
            }),
        );
        const tracing = (spec.observability as Record<string, unknown>)
            .tracing as Record<string, unknown>;
        expect(tracing.sampleRate).toBe("1");
        expect(typeof tracing.sampleRate).toBe("string");
    });

    it("threads tracing.enabled without endpoint or sampleRate", () => {
        const spec = specOf(
            baseConfig({ enabled: true, tracing: { enabled: true } }),
        );
        const obs = spec.observability as Record<string, unknown>;
        expect(obs.tracing).toEqual({ enabled: true });
    });

    it("coexists with rum in the same observability block", () => {
        const spec = specOf(
            baseConfig({
                enabled: true,
                rum: { enabled: true, sampleRate: 0.5 },
                tracing: { enabled: true, sampleRate: 0.1 },
            }),
        );
        const obs = spec.observability as Record<string, unknown>;
        expect(obs.rum).toEqual({ enabled: true, sampleRate: "0.5" });
        expect(obs.tracing).toEqual({ enabled: true, sampleRate: "0.1" });
    });
});
