/**
 * T7 — the CR/CRD compatibility artifacts are GENERATED, and the generation is
 * gated.
 *
 * Three properties, each of which has a way of being silently useless:
 *
 *  1. **Not stale.** The committed artifacts must equal what the generator
 *     produces from the CURRENT `cr-builder.ts`. This is the dirty-tree check:
 *     a field added to the builder without re-running the generator reds here.
 *     (It runs in the ordinary test job, so it is gated by an already-required
 *     check rather than by a new CI step.)
 *  2. **Not hand-edited.** Editing `docs/compat/cr-fields.md` by hand reds for
 *     the same reason — the file is output, not source.
 *  3. **emitted ⊆ CRD schema.** Every field the CLI can emit must exist in the
 *     CRD this repo ships. This is the assertion that would have caught the
 *     `spec.database.roSecretRef` class of skew at authoring time.
 *
 * The generated JSON is a published artifact, so it carries a `schemaVersion`
 * from day one and that number is asserted here — consumers may rely on it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
    crdSchemaFromCrdObject,
    flattenSchemaPaths,
    unknownEmittedFields,
} from "../cli/schema/crd-schema";
import { EMITTED_CR_FIELD_PATHS } from "../cli/schema/emitted-fields.generated";
import { extractEmittedFields } from "../cli/schema/extract-emitted-fields";
import {
    CR_FIELDS_ARTIFACT_VERSION,
    renderCrFieldsJson,
    renderCrFieldsMarkdown,
} from "../cli/schema/gen-artifacts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const CR_BUILDER = join(HERE, "..", "cli", "cr-builder.ts");
const GENERATED_TS = join(
    HERE,
    "..",
    "cli",
    "schema",
    "emitted-fields.generated.ts",
);
const DOC_MD = join(REPO, "docs", "compat", "cr-fields.md");
const DOC_JSON = join(REPO, "docs", "compat", "cr-fields.json");
const CRD_YAML = join(
    REPO,
    "packages",
    "kn-next-operator",
    "config",
    "crd",
    "bases",
    "apps.kn-next.dev_nextapps.yaml",
);

function read(p: string): string {
    return readFileSync(p, "utf-8");
}

function scannedPaths(): string[] {
    return extractEmittedFields(read(CR_BUILDER));
}

function crdSchema(): Record<string, unknown> {
    const crd = YAML.parse(read(CRD_YAML)) as Record<string, unknown>;
    const schema = crdSchemaFromCrdObject(crd, "v1alpha1");
    if (!schema) throw new Error("bundled CRD has no v1alpha1 schema");
    return schema;
}

describe("generated CR-field artifacts are re-derivable (dirty-tree check)", () => {
    it("the committed emitted-fields module equals a fresh generation", () => {
        const paths = scannedPaths();
        expect(
            EMITTED_CR_FIELD_PATHS,
            "emitted-fields.generated.ts is STALE — run `bun scripts/gen-cr-fields.ts` and commit the result",
        ).toEqual(paths);
    });

    it("the committed docs/compat/cr-fields.md equals a fresh generation (hand edits red)", () => {
        const expected = renderCrFieldsMarkdown(scannedPaths(), crdSchema());
        expect(
            read(DOC_MD),
            "docs/compat/cr-fields.md is GENERATED — do not hand-edit it; run `bun scripts/gen-cr-fields.ts`",
        ).toBe(expected);
    });

    it("the committed docs/compat/cr-fields.json equals a fresh generation", () => {
        const expected = renderCrFieldsJson(scannedPaths(), crdSchema());
        expect(read(DOC_JSON)).toBe(expected);
    });

    it("the published JSON carries a schemaVersion consumers can pin", () => {
        const parsed = JSON.parse(read(DOC_JSON)) as {
            schemaVersion?: number;
            emittedFields?: unknown;
        };
        expect(parsed.schemaVersion).toBe(CR_FIELDS_ARTIFACT_VERSION);
        expect(Array.isArray(parsed.emittedFields)).toBe(true);
    });

    it("the generated TS module is marked generated so nobody edits it by hand", () => {
        expect(read(GENERATED_TS)).toMatch(/@generated/);
    });
});

describe("emitted ⊆ CRD schema (the assertion that catches skew at authoring time)", () => {
    it("every field the CLI can emit exists in the CRD this repo ships", () => {
        const known = flattenSchemaPaths(crdSchema());
        const missing = unknownEmittedFields(EMITTED_CR_FIELD_PATHS, known);
        expect(
            missing,
            `the CLI emits ${missing.length} field(s) the bundled NextApp CRD does not define. Either add them to the CRD (operator first, then CLI — docs/adr/0020) or stop emitting them.`,
        ).toEqual([]);
    });

    it("the subset check is not vacuous — a removed CRD field is detected by NAME", () => {
        const schema = crdSchema();
        const spec = (schema as { properties: Record<string, unknown> })
            .properties.spec as {
            properties: Record<string, unknown>;
        };
        const database = spec.properties.database as {
            properties: Record<string, unknown>;
        };
        // Author the removal independently of the generator: delete the field
        // from a real CRD schema and require the checker to name it.
        delete database.properties.roSecretRef;
        const missing = unknownEmittedFields(
            EMITTED_CR_FIELD_PATHS,
            flattenSchemaPaths(schema),
        );
        expect(missing).toContain("spec.database.roSecretRef");
        expect(missing.join(" ")).toMatch(/roSecretRef/);
    });
});
