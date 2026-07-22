import { describe, expect, it } from "vitest";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * #415 — surface the 6 app-scaling knobs the NextApp CRD already supports
 * (ADR-0028/0029/0030/0032/0033) in `kn-next.config.ts` → `spec.scaling`.
 *
 * Round-trip contract (issue acceptance criteria):
 *  - a config with all 6 fields set produces a NextApp CR whose spec.scaling
 *    carries them with correct values/shape (incl. warmSchedule array).
 *  - a config with none set produces a CR byte-identical to today's (the
 *    fields are simply ABSENT, not present-as-undefined/null).
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(scaling?: KnativeNextConfig["scaling"]): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://example.com",
        },
        scaling,
    };
}

function scalingOf(config: KnativeNextConfig) {
    const cr = buildNextAppCRObject(config, IMG, "ns");
    return (cr.spec as Record<string, unknown>).scaling as Record<
        string,
        unknown
    >;
}

describe("buildNextAppCRObject — scaling knobs (#415)", () => {
    it("omits all 6 new knobs when unset (back-compat, byte-identical shape)", () => {
        const scaling = scalingOf(baseConfig({ minScale: 0, maxScale: 10 }));
        expect(scaling).toEqual({ minScale: 0, maxScale: 10 });
        expect(scaling.containerConcurrency).toBeUndefined();
        expect(scaling.poolMax).toBeUndefined();
        expect(scaling.warmSchedule).toBeUndefined();
        expect(scaling.targetBurstCapacity).toBeUndefined();
        expect(scaling.panicWindowPercentage).toBeUndefined();
        expect(scaling.panicThresholdPercentage).toBeUndefined();
        expect(Object.keys(scaling).sort()).toEqual(["maxScale", "minScale"]);
    });

    it("omits all 6 new knobs when scaling is entirely absent from config", () => {
        const scaling = scalingOf(baseConfig(undefined));
        expect(Object.keys(scaling).sort()).toEqual(["maxScale", "minScale"]);
    });

    it("maps containerConcurrency into spec.scaling when set (ADR-0028)", () => {
        const scaling = scalingOf(baseConfig({ containerConcurrency: 20 }));
        expect(scaling.containerConcurrency).toBe(20);
    });

    it("maps poolMax into spec.scaling when set (ADR-0028/0029)", () => {
        const scaling = scalingOf(baseConfig({ poolMax: 5 }));
        expect(scaling.poolMax).toBe(5);
    });

    it("maps targetBurstCapacity into spec.scaling when set, including -1 (ADR-0032)", () => {
        expect(
            scalingOf(baseConfig({ targetBurstCapacity: -1 }))
                .targetBurstCapacity,
        ).toBe(-1);
        expect(
            scalingOf(baseConfig({ targetBurstCapacity: 200 }))
                .targetBurstCapacity,
        ).toBe(200);
    });

    it("maps panicWindowPercentage and panicThresholdPercentage when set (ADR-0033)", () => {
        const scaling = scalingOf(
            baseConfig({
                panicWindowPercentage: 10,
                panicThresholdPercentage: 200,
            }),
        );
        expect(scaling.panicWindowPercentage).toBe(10);
        expect(scaling.panicThresholdPercentage).toBe(200);
    });

    it("maps warmSchedule array preserving window shape (ADR-0030)", () => {
        const scaling = scalingOf(
            baseConfig({
                warmSchedule: [
                    {
                        start: "0 8 * * 1-5",
                        end: "0 20 * * 1-5",
                        replicas: 2,
                        timezone: "America/New_York",
                    },
                ],
            }),
        );
        expect(scaling.warmSchedule).toEqual([
            {
                start: "0 8 * * 1-5",
                end: "0 20 * * 1-5",
                replicas: 2,
                timezone: "America/New_York",
            },
        ]);
    });

    it("maps warmSchedule window without timezone (optional field)", () => {
        const scaling = scalingOf(
            baseConfig({
                warmSchedule: [
                    { start: "0 8 * * 1-5", end: "0 20 * * 1-5", replicas: 1 },
                ],
            }),
        );
        expect(scaling.warmSchedule).toEqual([
            { start: "0 8 * * 1-5", end: "0 20 * * 1-5", replicas: 1 },
        ]);
    });

    it("maps imagePrewarm:true into spec.scaling when set (ADR-0037)", () => {
        const scaling = scalingOf(baseConfig({ imagePrewarm: true }));
        expect(scaling.imagePrewarm).toBe(true);
    });

    it("omits imagePrewarm when unset or false (opt-in, byte-identical shape)", () => {
        expect(
            scalingOf(baseConfig({ minScale: 0, maxScale: 10 })).imagePrewarm,
        ).toBeUndefined();
        expect(
            scalingOf(baseConfig({ imagePrewarm: false })).imagePrewarm,
        ).toBeUndefined();
    });

    it("round-trips all 6 knobs together with correct values/shape", () => {
        const scaling = scalingOf(
            baseConfig({
                minScale: 1,
                maxScale: 10,
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
                        timezone: "UTC",
                    },
                ],
            }),
        );
        expect(scaling).toEqual({
            minScale: 1,
            maxScale: 10,
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
                    timezone: "UTC",
                },
            ],
        });
    });
});
