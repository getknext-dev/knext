import { describe, expect, it } from "vitest";
import { buildNextAppCRObject, renderNextAppCR } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * #186 — plain (non-secret) env vars via spec.env.
 *
 * kn-next.config.ts may declare `env: { NAME: "value" }` for NON-SECRET
 * configuration flags (e.g. KNEXT_CACHE_CONTROL_NORMALIZE=0). The CR builder
 * must carry it as spec.env so the operator injects it on the ksvc container.
 * Secrets stay on the dedicated spec.secrets mechanism.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(env?: Record<string, string>): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        // publicUrl is required by StorageConfig but NOT read by the CR
        // builder (it maps provider/bucket/region/endpoint only) — supplying
        // it satisfies the type without touching the built CR (#261).
        storage: {
            provider: "gcs",
            bucket: "bucket",
            publicUrl: "https://storage.googleapis.com/bucket",
        },
        ...(env ? { env } : {}),
    };
}

describe("cr-builder spec.env (#186)", () => {
    it("carries config.env into the CR's spec.env", () => {
        const cr = buildNextAppCRObject(
            baseConfig({
                KNEXT_CACHE_CONTROL_NORMALIZE: "0",
                FEATURE_FLAG_BETA: "on",
            }),
            IMG,
            "default",
        );
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.env).toEqual({
            KNEXT_CACHE_CONTROL_NORMALIZE: "0",
            FEATURE_FLAG_BETA: "on",
        });
    });

    it("omits spec.env when config.env is absent", () => {
        const cr = buildNextAppCRObject(baseConfig(), IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec).not.toHaveProperty("env");
    });

    it("omits spec.env when config.env is an empty object", () => {
        const cr = buildNextAppCRObject(baseConfig({}), IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec).not.toHaveProperty("env");
    });

    it("keeps spec.env independent of spec.secrets", () => {
        const config: KnativeNextConfig = {
            ...baseConfig({ FLAG: "1" }),
            secrets: { envFrom: ["db-credentials"] },
        };
        const cr = buildNextAppCRObject(config, IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.env).toEqual({ FLAG: "1" });
        expect(spec.secrets).toEqual({ envFrom: ["db-credentials"] });
    });

    it("renders spec.env in the YAML output", () => {
        const yaml = renderNextAppCR(
            baseConfig({ KNEXT_CACHE_CONTROL_NORMALIZE: "0" }),
            IMG,
            "default",
        );
        expect(yaml).toContain("KNEXT_CACHE_CONTROL_NORMALIZE");
        expect(yaml).toContain('"0"');
    });
});
