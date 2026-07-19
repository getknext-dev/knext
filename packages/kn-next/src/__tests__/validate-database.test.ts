import { describe, expect, it } from "vitest";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * #417 — the ONE cheap CLI check mirroring the operator's XValidation on
 * `DatabaseSpec` (nextapp_types.go): `roSecretRef` requires `secretRef`.
 * All other database validation (Secret existence, DSN correctness) stays
 * the operator's job (envMap/secretKeyRef semantics) — the CLI does not
 * re-implement it.
 */

function baseConfig(
    database?: KnativeNextConfig["database"],
): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        database,
    } as KnativeNextConfig;
}

describe("validateConfig — database binding (#417)", () => {
    it("accepts a config with no database block", () => {
        expect(() => validateConfig(baseConfig(undefined))).not.toThrow();
    });

    it("accepts a bare secretRef", () => {
        expect(() =>
            validateConfig(
                baseConfig({ secretRef: { name: "storefront-db" } }),
            ),
        ).not.toThrow();
    });

    it("accepts secretRef + roSecretRef together", () => {
        expect(() =>
            validateConfig(
                baseConfig({
                    secretRef: { name: "storefront-db" },
                    roSecretRef: { name: "storefront-db" },
                }),
            ),
        ).not.toThrow();
    });

    it("rejects roSecretRef without secretRef (mirrors operator XValidation)", () => {
        expect(() =>
            validateConfig(
                baseConfig({ roSecretRef: { name: "storefront-db" } }),
            ),
        ).toThrow(ConfigValidationError);
        expect(() =>
            validateConfig(
                baseConfig({ roSecretRef: { name: "storefront-db" } }),
            ),
        ).toThrow(/roSecretRef.*secretRef/);
    });
});
