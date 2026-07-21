import { describe, expect, it } from "vitest";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * #435 — cheap, CLI-side checks for the four resource quantities
 * (scaling.cpuRequest / memoryRequest / cpuLimit / memoryLimit) that flow into
 * the NextApp CR's spec.resources. The OPERATOR stays the single source of
 * validation truth (internal/validation/validate.go parses these with
 * resource.ParseQuantity and rejects zero/negative + request>limit); this is
 * only the early, CLI-side copy so a typo like "1GB" / "0.5 CPU" / "0" is caught
 * at `kn-next deploy` time instead of by a rejected CR — and so the CLI and
 * operator agree that a zero quantity is invalid (the #433-noted divergence).
 */

function baseConfig(scaling?: KnativeNextConfig["scaling"]): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        scaling,
    } as KnativeNextConfig;
}

describe("validateConfig — resource quantities (#435)", () => {
    it("accepts valid CPU and memory quantities", () => {
        expect(() =>
            validateConfig(
                baseConfig({
                    cpuRequest: "250m",
                    memoryRequest: "512Mi",
                    cpuLimit: "1000m",
                    memoryLimit: "1Gi",
                }),
            ),
        ).not.toThrow();
    });

    it("accepts a config with no resource fields set", () => {
        expect(() =>
            validateConfig(baseConfig({ minScale: 0, maxScale: 10 })),
        ).not.toThrow();
    });

    it("rejects a malformed CPU request", () => {
        expect(() =>
            validateConfig(baseConfig({ cpuRequest: "0.5 CPU" })),
        ).toThrow(/cpuRequest/);
    });

    it("rejects a malformed memory request (GB is not a suffix)", () => {
        expect(() =>
            validateConfig(baseConfig({ memoryRequest: "1GB" })),
        ).toThrow(/memoryRequest/);
    });

    it("rejects a malformed CPU limit", () => {
        expect(() => validateConfig(baseConfig({ cpuLimit: "abc" }))).toThrow(
            /cpuLimit/,
        );
    });

    it("rejects a malformed memory limit", () => {
        expect(() =>
            validateConfig(baseConfig({ memoryLimit: "12MB" })),
        ).toThrow(/memoryLimit/);
    });

    it("rejects a zero or negative quantity", () => {
        expect(() => validateConfig(baseConfig({ cpuRequest: "0" }))).toThrow(
            ConfigValidationError,
        );
        expect(() =>
            validateConfig(baseConfig({ memoryRequest: "-1Gi" })),
        ).toThrow(/memoryRequest/);
    });
});

describe("validateConfig — bytecodeCache.size floor (#435 / #433 alignment)", () => {
    it("rejects a zero bytecodeCache.size the operator would reject", () => {
        expect(() =>
            validateConfig({
                name: "app",
                registry: "registry",
                storage: { provider: "gcs", bucket: "bucket" },
                bytecodeCache: { size: "0" },
            } as KnativeNextConfig),
        ).toThrow(/bytecodeCache\.size/);
    });

    it("rejects a zero-valued bytecodeCache.size with a unit", () => {
        expect(() =>
            validateConfig({
                name: "app",
                registry: "registry",
                storage: { provider: "gcs", bucket: "bucket" },
                bytecodeCache: { size: "0Gi" },
            } as KnativeNextConfig),
        ).toThrow(/bytecodeCache\.size/);
    });
});
