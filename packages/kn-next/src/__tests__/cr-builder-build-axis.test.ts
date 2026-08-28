import { describe, expect, it } from "vitest";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * Track B2 — `spec.build` on the emitted NextApp CR.
 *
 * The load-bearing assertion here is the OMISSION one. `build` is additive at
 * `v1alpha1`, and absence is the wire spelling of "turbopack". If the builder
 * ever emitted an explicit `build: "turbopack"` for a config that simply did
 * not set it, then a CR meaning exactly today's behaviour would be rejected by
 * an older CRD whose schema has no such enum — the #548 upgrade-order hazard,
 * paid for nothing. Upgrade order is operator/CRD first, then CLI, and this
 * test is what keeps a default from quietly violating it.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(
    overrides: Partial<KnativeNextConfig> = {},
): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://example.com",
        },
        ...overrides,
    };
}

const NS = "default";

const specOf = (config: KnativeNextConfig): Record<string, unknown> =>
    (buildNextAppCRObject(config, IMG, NS) as { spec: Record<string, unknown> })
        .spec;

describe("#B2 spec.build on the emitted CR", () => {
    it("is ABSENT when the config does not set it", () => {
        const spec = specOf(baseConfig());

        // Absent, not present-as-undefined: `"build" in spec` is what an older
        // apiserver's strict decoding actually sees.
        expect("build" in spec).toBe(false);
    });

    it("is absent even when runtime IS set — the axes do not imply each other", () => {
        // Both halves of the independence claim, on the wire this time. A
        // builder that derived `build` from `runtime` would pass the previous
        // test and fail here.
        for (const runtime of ["node", "bun"] as const) {
            const spec = specOf(baseConfig({ runtime }));
            expect(spec.runtime).toBe(runtime);
            expect("build" in spec).toBe(false);
        }
    });

    it("carries an explicit turbopack when the user asked for it", () => {
        // Explicit is preserved rather than normalised away: the user said it,
        // and round-tripping their config faithfully is what makes `--dry-run`
        // output trustworthy.
        expect(specOf(baseConfig({ build: "turbopack" })).build).toBe(
            "turbopack",
        );
    });

    it("carries vinext through when set, without inventing a runtime", () => {
        // The CR builder is not the gate — `validateConfig` rejects an
        // unavailable builder before this runs. What matters here is that the
        // builder does not silently rewrite the value or couple it to runtime.
        const spec = specOf(baseConfig({ build: "vinext" }));

        expect(spec.build).toBe("vinext");
        expect("runtime" in spec).toBe(false);
    });

    it("leaves the rest of the spec unchanged when build is absent", () => {
        // Byte-identical to today for every config that predates this field.
        const before = specOf(baseConfig({ runtime: "node" }));
        const after = specOf(baseConfig({ runtime: "node" }));

        expect(after).toEqual(before);
        expect(Object.keys(after)).not.toContain("build");
    });
});
