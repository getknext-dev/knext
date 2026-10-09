import { describe, expect, it } from "bun:test";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * #1865 — `networking.visibility` lets an app deploy with its Knative Route
 * cluster-local only. Validated here so a typo surfaces as a fast, local
 * config error rather than only at cluster-side admission (the CRD enum
 * rejects it too, but that round-trip costs a deploy attempt).
 */

function baseConfig(visibility?: string): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        ...(visibility !== undefined ? { networking: { visibility } } : {}),
    } as KnativeNextConfig;
}

describe("validateConfig networking.visibility checks", () => {
    it("accepts a config with no networking block (default: public)", () => {
        expect(() => validateConfig(baseConfig())).not.toThrow();
    });

    it('accepts visibility: "public"', () => {
        expect(() => validateConfig(baseConfig("public"))).not.toThrow();
    });

    it('accepts visibility: "cluster-local"', () => {
        expect(() => validateConfig(baseConfig("cluster-local"))).not.toThrow();
    });

    it("rejects an unrecognised visibility value", () => {
        expect(() => validateConfig(baseConfig("internal"))).toThrow(
            ConfigValidationError,
        );
        expect(() => validateConfig(baseConfig("internal"))).toThrow(
            /networking\.visibility/,
        );
    });

    it("names the offending value in the error message", () => {
        expect(() => validateConfig(baseConfig("internal"))).toThrow(
            /"internal"/,
        );
    });
});
