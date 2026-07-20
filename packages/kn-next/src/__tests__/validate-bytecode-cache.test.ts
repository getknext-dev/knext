import { describe, expect, it } from "vitest";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * #431 — accept/reject boundary for `bytecodeCache.size`.
 *
 * This knob is the ONLY user-supplied string the operator turns into a
 * Kubernetes quantity for the bytecode-cache PVC, so the boundary this file
 * pins is a real safety property, not a style check: every value accepted
 * here MUST be one `resource.ParseQuantity` accepts on the operator side
 * (internal/validation/validate.go), and every value it rejects must be
 * caught here too. The `512K` case is the load-bearing one — a decimal `K`
 * does not exist in the Kubernetes quantity grammar (decimal kilo is
 * lowercase `k`), so it must be rejected, not passed through to the operator.
 */

function baseConfig(size?: string): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        ...(size === undefined ? {} : { bytecodeCache: { size } }),
    } as KnativeNextConfig;
}

describe("validateConfig — bytecodeCache.size (#431)", () => {
    it("accepts a config with no bytecodeCache block at all (default-off)", () => {
        expect(() => validateConfig(baseConfig())).not.toThrow();
    });

    it("accepts a bytecodeCache block with no explicit size", () => {
        const config = {
            name: "app",
            registry: "registry",
            storage: { provider: "gcs", bucket: "bucket" },
            bytecodeCache: { enabled: true },
        } as KnativeNextConfig;
        expect(() => validateConfig(config)).not.toThrow();
    });

    // Binary SI — the documented Kubernetes suffixes Ki|Mi|Gi|Ti|Pi|Ei.
    it.each([
        "512Mi",
        "1Gi",
        "1Pi",
        "64Ki",
        "2Ti",
        "1Ei",
        "1.5Gi",
    ])("accepts the valid binary quantity %s", (size) => {
        expect(() => validateConfig(baseConfig(size))).not.toThrow();
    });

    // Decimal SI — lowercase k is kilo; m is milli (valid grammar, absurd
    // size, but the operator is the authority on semantics, not us).
    it.each([
        "500k",
        "1M",
        "2G",
        "1T",
        "1P",
        "1E",
        "100m",
        "1e3",
        "1E3",
    ])("accepts the valid decimal quantity %s", (size) => {
        expect(() => validateConfig(baseConfig(size))).not.toThrow();
    });

    it("accepts a bare unsuffixed integer (bytes)", () => {
        expect(() => validateConfig(baseConfig("536870912"))).not.toThrow();
    });

    it("rejects 512K — uppercase K is NOT a Kubernetes decimal suffix", () => {
        expect(() => validateConfig(baseConfig("512K"))).toThrow(
            /'bytecodeCache\.size' \("512K"\) is not a valid Kubernetes quantity/,
        );
    });

    it.each([
        "abc",
        "12MB",
        "",
        "512 Mi",
        "Mi",
        "1Gi1",
        "12mb",
        "1Ki2",
    ])("rejects the malformed quantity %j", (size) => {
        expect(() => validateConfig(baseConfig(size))).toThrow(
            /is not a valid Kubernetes quantity/,
        );
    });

    it("produces the documented, actionable error message shape", () => {
        expect(() => validateConfig(baseConfig("12MB"))).toThrow(
            `'bytecodeCache.size' ("12MB") is not a valid Kubernetes quantity ` +
                `(e.g. "512Mi", "1Gi"). Omit it to use the operator default of 512Mi.`,
        );
    });
});
