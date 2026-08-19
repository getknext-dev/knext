import { describe, expect, it } from "vitest";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * #415 — cheap, single-field range assertions for the 6 new scaling knobs.
 *
 * These deliberately do NOT re-implement the operator's cross-field
 * `maxScale × poolMax ≤ 80` wall (internal/validation/validate.go) — that
 * stays the operator's job. Only bounds that are true regardless of any
 * other field are checked here, mirroring the operator's single-field
 * rules (containerConcurrency >= 0, poolMax >= 0) and the CRD's
 * `+kubebuilder:validation` markers (targetBurstCapacity >= -1,
 * panicWindowPercentage 1-100, panicThresholdPercentage >= 110).
 */

function baseConfig(scaling?: KnativeNextConfig["scaling"]): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        scaling,
    } as KnativeNextConfig;
}

describe("validateConfig — scaling knobs (#415)", () => {
    it("accepts all 6 knobs at valid values", () => {
        expect(() =>
            validateConfig(
                baseConfig({
                    containerConcurrency: 20,
                    poolMax: 5,
                    targetBurstCapacity: -1,
                    panicWindowPercentage: 10,
                    panicThresholdPercentage: 200,
                    warmSchedule: [
                        {
                            start: "0 8 * * 1-5",
                            end: "0 20 * * 1-5",
                            replicas: 2,
                        },
                    ],
                }),
            ),
        ).not.toThrow();
    });

    it("accepts a config with none of the 6 knobs set", () => {
        expect(() =>
            validateConfig(baseConfig({ minScale: 0, maxScale: 10 })),
        ).not.toThrow();
    });

    it("rejects a negative containerConcurrency", () => {
        expect(() =>
            validateConfig(baseConfig({ containerConcurrency: -1 })),
        ).toThrow(ConfigValidationError);
        expect(() =>
            validateConfig(baseConfig({ containerConcurrency: -1 })),
        ).toThrow(/containerConcurrency/);
    });

    it("rejects a negative poolMax", () => {
        expect(() => validateConfig(baseConfig({ poolMax: -1 }))).toThrow(
            ConfigValidationError,
        );
        expect(() => validateConfig(baseConfig({ poolMax: -1 }))).toThrow(
            /poolMax/,
        );
    });

    it("rejects targetBurstCapacity below -1", () => {
        expect(() =>
            validateConfig(baseConfig({ targetBurstCapacity: -2 })),
        ).toThrow(ConfigValidationError);
        expect(() =>
            validateConfig(baseConfig({ targetBurstCapacity: -2 })),
        ).toThrow(/targetBurstCapacity/);
    });

    it("accepts targetBurstCapacity of -1 and of 0", () => {
        expect(() =>
            validateConfig(baseConfig({ targetBurstCapacity: -1 })),
        ).not.toThrow();
        expect(() =>
            validateConfig(baseConfig({ targetBurstCapacity: 0 })),
        ).not.toThrow();
    });

    it("rejects panicWindowPercentage outside 1-100", () => {
        expect(() =>
            validateConfig(baseConfig({ panicWindowPercentage: 0 })),
        ).toThrow(/panicWindowPercentage/);
        expect(() =>
            validateConfig(baseConfig({ panicWindowPercentage: 101 })),
        ).toThrow(/panicWindowPercentage/);
    });

    it("rejects panicThresholdPercentage below 110", () => {
        expect(() =>
            validateConfig(baseConfig({ panicThresholdPercentage: 109 })),
        ).toThrow(/panicThresholdPercentage/);
        expect(() =>
            validateConfig(baseConfig({ panicThresholdPercentage: 110 })),
        ).not.toThrow();
    });

    it("does NOT re-implement the maxScale x poolMax <= 80 cross-field wall (operator's job)", () => {
        // 100 * 20 = 2000 >> 80, but this is a single-field-valid config; the
        // CLI must NOT reject it — that invariant is the operator's alone.
        expect(() =>
            validateConfig(baseConfig({ maxScale: 100, poolMax: 20 })),
        ).not.toThrow();
    });
});

/**
 * ADR-0045 — `scaling.scaleDownDelay` is checked SYNTACTICALLY only.
 *
 * The operator's `ValidateNextAppSpec` delegates the range/precision rules to
 * Knative's own `autoscaling.ValidateAnnotations` precisely so the two cannot
 * diverge; re-deriving "0s–1h, second precision" here would reintroduce that
 * divergence one layer up, in a language that never sees the installed
 * cluster. So: shape only, and the server-side dry-run in `preflightCRSchema`
 * carries the semantics.
 */
describe("validateConfig — scaleDownDelay (ADR-0045)", () => {
    it("accepts a well-formed Go duration", () => {
        for (const value of ["5m", "0s", "1h", "90s", "1h30m", "1500ms"]) {
            expect(() =>
                validateConfig(baseConfig({ scaleDownDelay: value })),
            ).not.toThrow();
        }
    });

    it("accepts a config with scaleDownDelay unset", () => {
        expect(() =>
            validateConfig(baseConfig({ minScale: 0, maxScale: 10 })),
        ).not.toThrow();
    });

    it("rejects a value that is not a Go duration", () => {
        for (const value of ["5min", "banana", "5", "", "m5"]) {
            expect(() =>
                validateConfig(baseConfig({ scaleDownDelay: value })),
            ).toThrow(ConfigValidationError);
            expect(() =>
                validateConfig(baseConfig({ scaleDownDelay: value })),
            ).toThrow(/scaleDownDelay/);
        }
    });

    it("names the expected format in the error (a bare 'invalid' teaches nothing)", () => {
        expect(() =>
            validateConfig(baseConfig({ scaleDownDelay: "5min" })),
        ).toThrow(/Go duration|e\.g\. "5m"/);
    });

    it("does NOT range-check — the operator webhook owns Knative's 0s-1h rule", () => {
        // Out of Knative's accepted range, but syntactically a duration: the CLI
        // must pass it through so the ONE authority rejects it (with the bound
        // named), rather than two layers disagreeing about what the bound is.
        expect(() =>
            validateConfig(baseConfig({ scaleDownDelay: "24h" })),
        ).not.toThrow();
        expect(() =>
            validateConfig(baseConfig({ scaleDownDelay: "1500ms" })),
        ).not.toThrow();
    });
});
