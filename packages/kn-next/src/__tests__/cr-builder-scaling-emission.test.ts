import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * The CLI emits `spec.scaling.minScale` / `maxScale` only when the user set them
 * (platform layer: a value the CLI always writes is a value the cluster's
 * KnextPlatform can never default, because the app "set" it).
 *
 * The wrinkle that makes this more than "drop two keys": the operator reads a
 * PRESENT `spec.scaling` block's `maxScale` literally, and `maxScale: 0` is
 * Knative's "unbounded". So a non-empty scaling block without a `maxScale` would
 * silently remove the app's cap. The rule is therefore:
 *
 *   - nothing scaling-related set      -> no `spec.scaling` at all (the operator's
 *                                         own min 0 / max 10 defaults apply);
 *   - a scaling block is needed anyway -> `maxScale` is always present in it
 *                                         (the user's, else the CLI default 10);
 *   - `minScale` is emitted only when the user set it (0 is the wire's unset).
 *
 * The invariant that matters, asserted over a matrix below: the app's EFFECTIVE
 * min/max scale, as the operator computes it, is exactly what it was before.
 */

const IMG = "registry/app:tag@sha256:deadbeef";
const OPERATOR_DEFAULT_MAX_SCALE = 10;

function cfg(scaling?: KnativeNextConfig["scaling"]): KnativeNextConfig {
    return { name: "app", registry: "registry", scaling };
}

function specOf(config: KnativeNextConfig): Record<string, unknown> {
    return buildNextAppCRObject(config, IMG, "ns").spec as Record<
        string,
        unknown
    >;
}

type EmittedScaling = { minScale?: number; maxScale?: number } | undefined;

/** What the operator stamps (nextapp_controller.go buildDesiredKsvc). */
function operatorEffective(scaling: EmittedScaling) {
    return {
        minScale: scaling?.minScale ?? 0,
        // A present block's maxScale is read literally: unset is 0 = unbounded.
        maxScale: scaling
            ? (scaling.maxScale ?? 0)
            : OPERATOR_DEFAULT_MAX_SCALE,
    };
}

/** What the CLI + operator produced BEFORE this change (always-emitted pair). */
function previousEffective(config: KnativeNextConfig) {
    return {
        minScale: config.scaling?.minScale ?? 0,
        maxScale: config.scaling?.maxScale ?? OPERATOR_DEFAULT_MAX_SCALE,
    };
}

describe("buildNextAppCRObject — scaling pair is emitted only when set", () => {
    it("emits no spec.scaling at all when the config sets nothing scaling-related", () => {
        expect("scaling" in specOf(cfg(undefined))).toBe(false);
        expect("scaling" in specOf(cfg({}))).toBe(false);
    });

    it("does not emit spec.scaling for resource-only legacy keys (they map to spec.resources)", () => {
        const spec = specOf(cfg({ cpuRequest: "500m" }));
        expect("scaling" in spec).toBe(false);
        expect(spec.resources).toBeDefined();
    });

    it("emits only maxScale when only maxScale is set", () => {
        expect(specOf(cfg({ maxScale: 5 })).scaling).toEqual({ maxScale: 5 });
    });

    it("keeps an explicit minScale of 0 out of the CR (0 is the wire's unset)", () => {
        const scaling = specOf(cfg({ minScale: 0, maxScale: 5 }))
            .scaling as Record<string, unknown>;
        expect("minScale" in scaling).toBe(false);
        expect(scaling.maxScale).toBe(5);
    });

    it("emits a non-zero minScale together with a maxScale (the CLI default when unset)", () => {
        expect(specOf(cfg({ minScale: 2 })).scaling).toEqual({
            minScale: 2,
            maxScale: OPERATOR_DEFAULT_MAX_SCALE,
        });
    });

    it("never leaves a non-empty scaling block without a maxScale (that would read as unbounded)", () => {
        for (const knob of [
            { containerConcurrency: 30 },
            { poolMax: 4 },
            { scaleDownDelay: "5m" },
            { targetBurstCapacity: 0 },
            { panicWindowPercentage: 10 },
            { panicThresholdPercentage: 200 },
            { imagePrewarm: true },
            {
                warmSchedule: [
                    { start: "0 8 * * *", end: "0 20 * * *", replicas: 1 },
                ],
            },
        ] as NonNullable<KnativeNextConfig["scaling"]>[]) {
            const scaling = specOf(cfg(knob)).scaling as Record<
                string,
                unknown
            >;
            expect(scaling.maxScale).toBe(OPERATOR_DEFAULT_MAX_SCALE);
            expect("minScale" in scaling).toBe(false);
        }
    });

    it("preserves an explicit maxScale of 0 (unbounded is the user's call)", () => {
        expect(specOf(cfg({ maxScale: 0 })).scaling).toEqual({ maxScale: 0 });
    });

    it("the app's EFFECTIVE min/max scale is unchanged for every config shape", () => {
        const mins = [undefined, 0, 1, 3];
        const maxes = [undefined, 0, 5, 10, 20];
        const others: NonNullable<KnativeNextConfig["scaling"]>[] = [
            {},
            { containerConcurrency: 50 },
            { poolMax: 4 },
            { imagePrewarm: true },
            { cpuRequest: "500m" },
            { scaleDownDelay: "30s", targetBurstCapacity: 100 },
        ];
        let checked = 0;
        for (const minScale of mins) {
            for (const maxScale of maxes) {
                for (const other of others) {
                    const scaling = {
                        ...other,
                        ...(minScale !== undefined ? { minScale } : {}),
                        ...(maxScale !== undefined ? { maxScale } : {}),
                    };
                    const config = cfg(scaling);
                    const got = operatorEffective(
                        specOf(config).scaling as EmittedScaling,
                    );
                    expect(got).toEqual(previousEffective(config));
                    checked++;
                }
            }
        }
        // A matrix that silently shrinks to nothing proves nothing.
        expect(checked).toBe(mins.length * maxes.length * others.length);
    });
});
