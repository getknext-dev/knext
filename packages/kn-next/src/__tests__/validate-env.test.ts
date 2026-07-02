import { describe, expect, it } from "vitest";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * #186 (review follow-up) — fast local validation of config.env.
 *
 * The operator's CRD CEL validation rejects reserved / malformed env var
 * names at `kubectl apply` time, but that is the LAST line of defense.
 * validateConfig must mirror those checks so a bad `env` in
 * kn-next.config.ts fails at validate/deploy time locally, with the same
 * rules the cluster enforces:
 *   - names must be C_IDENTIFIERs ([A-Za-z_][A-Za-z0-9_]*)
 *   - reserved names: HOSTNAME, PORT, K_SERVICE, K_REVISION, K_CONFIGURATION
 */

function baseConfig(env?: Record<string, string>): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        ...(env ? { env } : {}),
    } as KnativeNextConfig;
}

describe("validateConfig env checks (#186)", () => {
    it("accepts valid non-secret env vars", () => {
        expect(() =>
            validateConfig(
                baseConfig({
                    KNEXT_CACHE_CONTROL_NORMALIZE: "0",
                    FEATURE_FLAG_BETA: "on",
                    _UNDERSCORE_OK: "yes",
                }),
            ),
        ).not.toThrow();
    });

    it("accepts a config without env / with empty env", () => {
        expect(() => validateConfig(baseConfig())).not.toThrow();
        expect(() => validateConfig(baseConfig({}))).not.toThrow();
    });

    it("rejects the reserved name HOSTNAME (the #178/#184 hazard) locally", () => {
        expect(() =>
            validateConfig(baseConfig({ HOSTNAME: "evil.example.com" })),
        ).toThrow(ConfigValidationError);
        expect(() =>
            validateConfig(baseConfig({ HOSTNAME: "evil.example.com" })),
        ).toThrow(/reserved/i);
    });

    it("rejects every reserved name (PORT, K_SERVICE, K_REVISION, K_CONFIGURATION)", () => {
        for (const name of [
            "PORT",
            "K_SERVICE",
            "K_REVISION",
            "K_CONFIGURATION",
        ]) {
            expect(() => validateConfig(baseConfig({ [name]: "x" }))).toThrow(
                /reserved/i,
            );
        }
    });

    it("rejects env var names that are not C_IDENTIFIERs", () => {
        for (const name of ["1BAD", "BAD-NAME", "BAD.NAME", "BAD NAME", ""]) {
            expect(() => validateConfig(baseConfig({ [name]: "x" }))).toThrow(
                ConfigValidationError,
            );
        }
    });

    it("names the offending variable in the error message", () => {
        expect(() => validateConfig(baseConfig({ "BAD-NAME": "x" }))).toThrow(
            /BAD-NAME/,
        );
        expect(() => validateConfig(baseConfig({ PORT: "3000" }))).toThrow(
            /PORT/,
        );
    });
});
