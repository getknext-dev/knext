import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { buildNextAppCRObject } from "../cli/cr-builder";
import {
    crdSchemaFromCrdObject,
    flattenSchemaPaths,
    unknownEmittedFields,
} from "../cli/schema/crd-schema";
import type { KnativeNextConfig } from "../config";

/**
 * #1522 (N2 follow-up #1457) — `spec.selfContained` on the emitted NextApp CR.
 *
 * The operator's `containerCommand` branch already leaves `Command` nil for
 * `build: "vinext"` (the image is one compiled executable, no `server.js` to
 * force). The self-contained standalone shape has the exact same property,
 * reached by a different axis: `build` absent/"turbopack"/"webpack" +
 * `selfContained: true` + `runtime: "bun"`. This CR builder is what tells the
 * operator which axis it is looking at.
 */

const IMG = "registry/app:tag@sha256:deadbeef";
const NS = "default";

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

const specOf = (config: KnativeNextConfig): Record<string, unknown> =>
    (buildNextAppCRObject(config, IMG, NS) as { spec: Record<string, unknown> })
        .spec;

describe("#1522 spec.selfContained on the emitted CR", () => {
    it("emits selfContained:true on the standalone-bun cell when the config opts in", () => {
        const spec = specOf(
            baseConfig({
                build: "turbopack",
                runtime: "bun",
                selfContained: true,
            }),
        );
        expect(spec.selfContained).toBe(true);
    });

    it("emits selfContained:true on the default (unset build) shape too — build defaults to turbopack", () => {
        const spec = specOf(
            baseConfig({ runtime: "bun", selfContained: true }),
        );
        expect(spec.build).toBe("turbopack");
        expect(spec.selfContained).toBe(true);
    });

    it("emits selfContained:true on the webpack cell — same shape as turbopack (#1219)", () => {
        const spec = specOf(
            baseConfig({
                build: "webpack",
                runtime: "bun",
                selfContained: true,
            }),
        );
        expect(spec.selfContained).toBe(true);
    });

    it("OMITS selfContained (does not emit false) when the config leaves it unset", () => {
        // Backward compat direction: an old CLI / a config that predates this
        // field renders byte-identical output — the field is absent, not
        // `false`, matching the CRD default and every other opt-in flag here.
        const spec = specOf(baseConfig({ build: "turbopack", runtime: "bun" }));
        expect("selfContained" in spec).toBe(false);
    });

    it("OMITS selfContained when the config explicitly sets it to false", () => {
        const spec = specOf(
            baseConfig({
                build: "turbopack",
                runtime: "bun",
                selfContained: false,
            }),
        );
        expect("selfContained" in spec).toBe(false);
    });

    it("OMITS selfContained on the vinext shape even when the config opts in — the field is a no-op there", () => {
        // vinext is already always a single executable regardless of this
        // field (the operator's `Build != "vinext"` check already covers
        // it); emitting the field there would be a vacuous no-op that
        // invites confusion about which axis controls the decision.
        const spec = specOf(
            baseConfig({ build: "vinext", selfContained: true }),
        );
        expect(spec.build).toBe("vinext");
        expect("selfContained" in spec).toBe(false);
    });

    it("OMITS selfContained when the resolved runtime is node — the field cannot change anything on that cell", () => {
        // Mirrors runtime-image.ts's own N2 gating: selfContained only
        // changes anything on the bun cell. The operator's containerCommand
        // branch already requires Runtime=="bun" before it would force a
        // command at all, so the field is inert on "node" either way.
        const spec = specOf(
            baseConfig({
                build: "turbopack",
                runtime: "node",
                selfContained: true,
            }),
        );
        expect("selfContained" in spec).toBe(false);
    });

    it("resolves an UNSET runtime to the standalone default (bun) and still emits selfContained", () => {
        // cr-builder resolves an unset runtime to DEFAULT_RUNTIME_ID ("bun")
        // for the standalone shape (see the build-axis suite) — selfContained
        // must follow that SAME resolved value, not the raw config.runtime.
        const spec = specOf(
            baseConfig({ build: "turbopack", selfContained: true }),
        );
        expect(spec.runtime).toBe("bun");
        expect(spec.selfContained).toBe(true);
    });

    it("leaves the rest of the spec unchanged for a config that predates the field", () => {
        const before = specOf(
            baseConfig({ build: "turbopack", runtime: "bun" }),
        );
        const after = specOf(
            baseConfig({ build: "turbopack", runtime: "bun" }),
        );
        expect(after).toEqual(before);
        expect("selfContained" in after).toBe(false);
    });
});

/**
 * #548 upgrade order, both directions, named by field (mirrors the
 * `roSecretRef` "not vacuous" case in cr-fields-generated.test.ts, scoped to
 * `spec.selfContained` — the generic mechanism this exercises is already
 * covered end-to-end for ANY field by cr-prune-preflight.test.ts and
 * cr-fields-generated.test.ts; this asserts it by NAME for this field).
 */
describe("#1522 / #548 upgrade order — operator/CRD first, then CLI", () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const CRD_YAML = join(
        HERE,
        "..",
        "..",
        "..",
        "..",
        "packages",
        "kn-next-operator",
        "config",
        "crd",
        "bases",
        "apps.kn-next.dev_nextapps.yaml",
    );

    function bundledCrdSchema(): Record<string, unknown> {
        const crd = YAML.parse(readFileSync(CRD_YAML, "utf-8")) as Record<
            string,
            unknown
        >;
        const schema = crdSchemaFromCrdObject(crd, "v1alpha1");
        if (!schema) throw new Error("bundled CRD has no v1alpha1 schema");
        return schema;
    }

    /** The bundled CRD schema with `spec.selfContained` removed, authored
     * independently of the CR builder — simulates an OLD operator/CRD that
     * predates this field. */
    function withoutSelfContained(): Record<string, unknown> {
        const schema = bundledCrdSchema();
        const spec = (
            schema.properties as Record<
                string,
                { properties: Record<string, unknown> }
            >
        ).spec;
        delete spec.properties.selfContained;
        return schema;
    }

    it("direction A — a NEW CLI's CR fails loudly against an OLD CRD that predates the field", () => {
        const spec = specOf(
            baseConfig({
                build: "turbopack",
                runtime: "bun",
                selfContained: true,
            }),
        );
        expect(spec.selfContained).toBe(true);

        const missing = unknownEmittedFields(
            ["spec.selfContained"],
            flattenSchemaPaths(withoutSelfContained()),
        );
        expect(missing).toContain("spec.selfContained");
    });

    it("direction B — an OLD CLI's CR (field never emitted) validates cleanly against the NEW CRD", () => {
        // An old CLI predates the config key entirely, so its CR simply never
        // has the key — the same shape as any config that leaves it unset.
        const spec = specOf(baseConfig({ build: "turbopack", runtime: "bun" }));
        expect("selfContained" in spec).toBe(false);

        const missing = unknownEmittedFields(
            Object.keys(spec).map((k) => `spec.${k}`),
            flattenSchemaPaths(bundledCrdSchema()),
        );
        expect(missing).toEqual([]);
    });

    it("selfContained is optional on the wire — a CR omitting it is not rejected as missing-required", () => {
        const schema = bundledCrdSchema();
        const spec = (
            schema.properties as Record<string, { required?: string[] }>
        ).spec;
        expect(spec.required ?? []).not.toContain("selfContained");
    });
});
