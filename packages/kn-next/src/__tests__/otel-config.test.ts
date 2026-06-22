import { describe, expect, it } from "vitest";
import { resolveOtelOptions } from "../adapters/otel-config";

/**
 * #30 — OTel tracing gating.
 *
 * Tracing is DEFAULT-OFF: `resolveOtelOptions` returns null unless
 * OTEL_TRACING_ENABLED === 'true'. When enabled it resolves the service name,
 * OTLP endpoint, sample rate, and Knative resource attributes from env. This is
 * the pure unit the runtime instrumentation hook consumes.
 */

describe("resolveOtelOptions — gating", () => {
    it("returns null when OTEL_TRACING_ENABLED is unset (default OFF)", () => {
        expect(resolveOtelOptions({})).toBeNull();
    });

    it("returns null when OTEL_TRACING_ENABLED is not exactly 'true'", () => {
        expect(resolveOtelOptions({ OTEL_TRACING_ENABLED: "1" })).toBeNull();
        expect(resolveOtelOptions({ OTEL_TRACING_ENABLED: "TRUE" })).toBeNull();
        expect(
            resolveOtelOptions({ OTEL_TRACING_ENABLED: "false" }),
        ).toBeNull();
        expect(resolveOtelOptions({ OTEL_TRACING_ENABLED: "" })).toBeNull();
    });

    it("returns options when OTEL_TRACING_ENABLED === 'true'", () => {
        const opts = resolveOtelOptions({ OTEL_TRACING_ENABLED: "true" });
        expect(opts).not.toBeNull();
    });
});

describe("resolveOtelOptions — service name resolution", () => {
    it("prefers OTEL_SERVICE_NAME", () => {
        const opts = resolveOtelOptions({
            OTEL_TRACING_ENABLED: "true",
            OTEL_SERVICE_NAME: "explicit",
            KN_APP_NAME: "knapp",
        });
        expect(opts?.serviceName).toBe("explicit");
    });

    it("falls back to KN_APP_NAME", () => {
        const opts = resolveOtelOptions({
            OTEL_TRACING_ENABLED: "true",
            KN_APP_NAME: "knapp",
        });
        expect(opts?.serviceName).toBe("knapp");
    });

    it("defaults to 'file-manager' when neither is set", () => {
        const opts = resolveOtelOptions({ OTEL_TRACING_ENABLED: "true" });
        expect(opts?.serviceName).toBe("file-manager");
    });
});

describe("resolveOtelOptions — endpoint resolution", () => {
    it("uses OTEL_EXPORTER_OTLP_ENDPOINT when set", () => {
        const opts = resolveOtelOptions({
            OTEL_TRACING_ENABLED: "true",
            OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo.monitoring:4317",
        });
        expect(opts?.endpoint).toBe("http://tempo.monitoring:4317");
    });

    it("defaults to the in-cluster otel-collector endpoint", () => {
        const opts = resolveOtelOptions({ OTEL_TRACING_ENABLED: "true" });
        expect(opts?.endpoint).toBe("http://otel-collector.monitoring:4317");
    });
});

describe("resolveOtelOptions — sample rate", () => {
    it("parses OTEL_TRACES_SAMPLER_ARG into a number", () => {
        const opts = resolveOtelOptions({
            OTEL_TRACING_ENABLED: "true",
            OTEL_TRACES_SAMPLER_ARG: "0.25",
        });
        expect(opts?.sampleRate).toBe(0.25);
    });

    it("defaults sampleRate to 1 when unset or unparseable", () => {
        expect(
            resolveOtelOptions({ OTEL_TRACING_ENABLED: "true" })?.sampleRate,
        ).toBe(1);
        expect(
            resolveOtelOptions({
                OTEL_TRACING_ENABLED: "true",
                OTEL_TRACES_SAMPLER_ARG: "not-a-number",
            })?.sampleRate,
        ).toBe(1);
    });
});

describe("resolveOtelOptions — Knative resource attributes", () => {
    it("captures K_REVISION / K_SERVICE / K_CONFIGURATION / HOSTNAME", () => {
        const opts = resolveOtelOptions({
            OTEL_TRACING_ENABLED: "true",
            K_REVISION: "app-00007",
            K_SERVICE: "app",
            K_CONFIGURATION: "app",
            HOSTNAME: "app-00007-deployment-abc",
        });
        expect(opts?.resourceAttributes).toMatchObject({
            "knative.revision": "app-00007",
            "knative.service": "app",
            "knative.configuration": "app",
            "host.name": "app-00007-deployment-abc",
        });
    });

    it("omits resource attribute keys whose env is unset", () => {
        const opts = resolveOtelOptions({ OTEL_TRACING_ENABLED: "true" });
        expect(opts?.resourceAttributes).not.toHaveProperty("knative.revision");
        expect(opts?.resourceAttributes).not.toHaveProperty("host.name");
    });
});
