import { describe, expect, it } from "vitest";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * #635 — the CLI half of the absurd-exponent guard.
 *
 * `resource.ParseQuantity("1e2147483648")` does not return (MEASURED: still
 * running after 45 s, while "1e999999" returns in 27 µs — the exponent is what
 * matters, not the length). The operator's validator runs inside `Reconcile`,
 * so a stored NextApp carrying such a value wedges a workqueue worker.
 *
 * The CLI's regex mirror accepted the whole class (`[eE][+-]?\d+`), so
 * `kn-next deploy` would happily push the value to the cluster. This test pins
 * the mirror to the operator's bound: an exponent beyond ±9999, or a quantity
 * string longer than the bound, is rejected here too — before an image is even
 * built.
 */

function configWithCpuRequest(value: string): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "bucket",
            publicUrl: "https://storage.example.invalid/bucket",
        },
        scaling: { cpuRequest: value },
    } satisfies KnativeNextConfig;
}

function configWithBytecodeCacheSize(value: string): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "bucket",
            publicUrl: "https://storage.example.invalid/bucket",
        },
        // `enabled` is required by BytecodeCacheConfig — set, not cast. The
        // operator validates the size whether or not the cache is switched on
        // (a dormant typo must not become a reconcile failure the moment
        // someone flips the flag), so `true` here keeps the fixture the shape
        // the product actually accepts.
        bytecodeCache: { enabled: true, size: value },
    } satisfies KnativeNextConfig;
}

/** The class the operator's parser cannot bound. */
const pathological = [
    "1e2147483648",
    "1E2147483648",
    "1e+2147483648",
    "-1e2147483648",
    "1e-2147483648",
    "1e00000002147483648",
    "1e4000000000",
];

/** Accepted by apimachinery, but far beyond any container: knext rejects it. */
const beyondBound = ["1e10000", "1e999999", "1e123456"];

describe("quantity exponent bound (#635)", () => {
    it.each(
        pathological,
    )("rejects scaling.cpuRequest %j — the value the operator's parser never finishes", (value) => {
        expect(() => validateConfig(configWithCpuRequest(value))).toThrowError(
            /quantity/i,
        );
    });

    it.each(
        beyondBound,
    )("rejects scaling.cpuRequest %j — exponent beyond the mirrored bound", (value) => {
        expect(() => validateConfig(configWithCpuRequest(value))).toThrowError(
            /quantity/i,
        );
    });

    it.each([
        ...pathological,
        ...beyondBound,
    ])("rejects bytecodeCache.size %j through the same shared check", (value) => {
        expect(() =>
            validateConfig(configWithBytecodeCacheSize(value)),
        ).toThrowError(/quantity/i);
    });

    it("rejects a quantity string longer than any real quantity", () => {
        // A 1,000,000-digit mantissa needs no exponent at all: MEASURED, the
        // operator's parser takes ~1.2 s on it. The length bound is the second
        // half of the guard, and the CLI mirrors it.
        const huge = "9".repeat(1_000_000);
        expect(() => validateConfig(configWithCpuRequest(huge))).toThrowError(
            /quantity/i,
        );
    });

    it.each([
        "1",
        "250m",
        "0.5",
        "512Mi",
        "1Gi",
        "1e3",
        "1E3",
        "1e+3",
        "1.5e3",
        "+1e3",
        "1e9999",
        "1e0000009",
    ])("still accepts the legitimate quantity %j", (value) => {
        expect(() => validateConfig(configWithCpuRequest(value))).not.toThrow();
    });

    it("answers promptly — the whole point is that no input costs real time", () => {
        const started = performance.now();
        for (const value of [...pathological, ...beyondBound, "250m", "1Gi"]) {
            try {
                validateConfig(configWithCpuRequest(value));
            } catch {
                // verdict asserted above; here we only care about the clock
            }
        }
        // Generous by three orders of magnitude over the observed cost; a regex
        // that backtracks catastrophically on these inputs is what this catches.
        expect(performance.now() - started).toBeLessThan(1000);
    });
});
