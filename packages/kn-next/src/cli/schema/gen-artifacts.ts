/**
 * gen-artifacts.ts — pure renderers for the generated CR/CRD compatibility
 * artifacts (T7). BUILD-TIME ONLY; `scripts/gen-cr-fields.ts` is the thin I/O
 * wrapper and `cr-fields-generated.test.ts` re-derives from here, so "the
 * generator" and "the check" are literally the same code and cannot drift.
 *
 * Deliberately deterministic and byte-stable: no timestamps, no source hash, no
 * host paths. A dirty-tree check whose output changes on every run teaches
 * people to regenerate blindly, which is the opposite of a gate.
 */

import {
    flattenSchemaPaths,
    isFieldKnown,
    unknownEmittedFields,
} from "./crd-schema";

/**
 * Schema version of the PUBLISHED artifact (`docs/compat/cr-fields.json`).
 * Consumers may rely on: `schemaVersion`, `apiVersion`, `kind`, and
 * `emittedFields[]` (dotted paths, `*` = dynamic key / array index). Anything
 * else is informational. Bump on a breaking change to that shape.
 */
export const CR_FIELDS_ARTIFACT_VERSION = 1;

const GENERATED_BANNER =
    "GENERATED FILE — do not edit by hand.\n" +
    "Source of truth: packages/kn-next/src/cli/cr-builder.ts (scanned).\n" +
    "Regenerate: bun scripts/gen-cr-fields.ts";

export function renderEmittedFieldsModule(paths: readonly string[]): string {
    const body = paths.map((p) => `    ${JSON.stringify(p)},`).join("\n");
    return `/**
 * @generated ${GENERATED_BANNER.split("\n").join("\n * ")}
 *
 * Every NextApp CR field path \`buildNextAppCRObject\` can emit. Derived by
 * SCANNING the builder (never enumerated) so it cannot silently go stale; the
 * scan lives in extract-emitted-fields.ts and the staleness gate in
 * cr-fields-generated.test.ts.
 *
 * \`*\` = a dynamic map key or an array index.
 */

export const EMITTED_CR_FIELD_PATHS: readonly string[] = [
${body}
];
`;
}

interface Coverage {
    path: string;
    covered: boolean;
}

function coverage(
    paths: readonly string[],
    crdSchema: unknown,
): { rows: Coverage[]; missing: string[] } {
    const known = flattenSchemaPaths(crdSchema);
    const missing = unknownEmittedFields(paths, known);
    return {
        rows: paths.map((p) => ({ path: p, covered: isFieldKnown(p, known) })),
        missing,
    };
}

export function renderCrFieldsJson(
    paths: readonly string[],
    crdSchema: unknown,
): string {
    const { rows, missing } = coverage(paths, crdSchema);
    return `${JSON.stringify(
        {
            schemaVersion: CR_FIELDS_ARTIFACT_VERSION,
            generatedBy: "scripts/gen-cr-fields.ts",
            apiVersion: "apps.kn-next.dev/v1alpha1",
            kind: "NextApp",
            emittedFields: rows.map((r) => r.path),
            notInBundledCRD: missing,
            fieldCount: rows.length,
        },
        null,
        // 2 spaces because that is what `biome format` produces for JSON. If
        // the generator and the formatter disagree, `biome check --write` makes
        // the tree dirty and the staleness gate reds for a reason that has
        // nothing to do with skew — which is how a gate gets weakened.
        2,
    )}\n`;
}

export function renderCrFieldsMarkdown(
    paths: readonly string[],
    crdSchema: unknown,
): string {
    const { rows, missing } = coverage(paths, crdSchema);
    const table = rows
        .map((r) => `| \`${r.path}\` | ${r.covered ? "yes" : "**NO**"} |`)
        .join("\n");
    const verdict =
        missing.length === 0
            ? "Every field the CLI can emit is defined by the bundled CRD."
            : `**${missing.length} emitted field(s) are NOT defined by the bundled CRD:** ${missing
                  .map((m) => `\`${m}\``)
                  .join(", ")}`;
    return `<!-- ${GENERATED_BANNER.split("\n").join("\n     ")} -->

# NextApp CR fields the \`kn-next\` CLI emits

This table is **derived by scanning \`cr-builder.ts\`**, not maintained by hand —
a field added to the builder shows up here on the next generation, and CI reds
if the committed copy is stale.

Read it alongside the machine-readable \`cr-fields.json\` (schema version
${CR_FIELDS_ARTIFACT_VERSION}), which is the artifact other tools should consume.

**What "in bundled CRD" means:** the field is defined by the NextApp CRD in
*this repository* (\`packages/kn-next-operator/config/crd/bases\`). It says
nothing about the CRD installed on *your* cluster — that is what \`kn-next
deploy\`'s preflight and \`kn-next doctor\`'s schema-coverage check answer, live.
Upgrade order matters: **operator/CRD first, then CLI.**

\`*\` in a path is a dynamic map key or an array index.

${verdict}

| field | in bundled CRD |
|---|---|
${table}
`;
}
