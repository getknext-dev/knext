/**
 * build-id-label-lockstep — the Kubernetes label the CLI reads MUST equal the
 * one the operator stamps (rev-1380 review, found live: a global text
 * substitution during the #1369 `kn-next` → `knext` rename silently rewrote
 * TWO jsonpath string literals in gc.ts from the real Kubernetes label
 * `apps.kn-next.dev/build-id` to a label that does not exist,
 * `apps.knext.dev/build-id` — the escaped-dot form (`apps\.kn-next\.dev`)
 * was not caught by the rename's exclusion list because the literal text
 * after `kn-next` was `\\.dev` (two backslashes, a JS string escape for one
 * literal backslash) rather than a bare `.dev`. The effect was silent, not a
 * crash: `kubectl get revision ... -o jsonpath=...` against a label that is
 * never set just returns empty, which this CLI already treats as
 * "unresolvable — skip the GC, fail-safe" (see gc.ts's own header) — so
 * `knext gc` (and the GC that runs after every deploy) stopped pruning
 * anything, forever, with no error. gc-cli.test.ts's own literal was renamed
 * in lockstep with the source, so that suite stayed green throughout.
 *
 * This guard reads the SOURCE OF TRUTH — the Go operator's `BuildIDLabel`
 * constant — and asserts every jsonpath literal in the CLI that reads it
 * matches, byte for byte. A future rename (of either side) that drifts them
 * apart fails here instead of silently no-opping the GC.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

const OPERATOR_TYPES_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next-operator",
    "api",
    "v1alpha1",
    "nextapp_types.go",
);

const GC_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next",
    "src",
    "cli",
    "gc.ts",
);

/** The Go `const BuildIDLabel = "..."` value — the label the operator stamps. */
function readOperatorBuildIDLabel(): string {
    const src = readFileSync(OPERATOR_TYPES_FILE, "utf8");
    const m = src.match(/const\s+BuildIDLabel\s*=\s*"([^"]+)"/);
    if (!m) {
        throw new Error(
            `could not find "const BuildIDLabel = \"...\"" in ${OPERATOR_TYPES_FILE} — ` +
                "has it moved or been renamed? Update this guard's regex, don't delete it.",
        );
    }
    return m[1] as string;
}

/**
 * Every `jsonpath={.metadata.labels.<escaped-label>/build-id}` literal in
 * gc.ts, with the jsonpath-dot-escaping (`\.`) undone so it is directly
 * comparable to the plain label string the Go side declares.
 */
function readGcJsonpathLabels(): string[] {
    const src = readFileSync(GC_FILE, "utf8");
    const out: string[] = [];
    // jsonpath escapes each literal `.` in the label as `\.`; in the TS
    // source that is a doubled backslash (`\\.`) inside a double-quoted
    // string. Match the whole `{.metadata.labels....../build-id}` span.
    const re = /jsonpath=\{\.metadata\.labels\.((?:[^{}]|\\.)+?)\/build-id\}/g;
    for (const m of src.matchAll(re)) {
        const escaped = m[1] as string;
        // Undo the jsonpath dot-escape as it appears in the RAW FILE TEXT:
        // `readFileSync` returns literal bytes, not a JS-evaluated string, so
        // a doubled backslash typed in the source (`\\.`) reads back as TWO
        // literal backslash characters followed by a dot, not one.
        out.push(`${escaped.replace(/\\\\\./g, ".")}/build-id`);
    }
    return out;
}

describe("the CLI's build-id label jsonpath matches the operator's BuildIDLabel", () => {
    it("finds the operator's BuildIDLabel constant", () => {
        expect(readOperatorBuildIDLabel()).toMatch(/^apps\.[\w.-]+\/build-id$/);
    });

    it("finds a non-trivial set of jsonpath label reads in gc.ts (a guard that scans zero proves nothing)", () => {
        expect(readGcJsonpathLabels().length).toBeGreaterThanOrEqual(2);
    });

    it("every jsonpath label read in gc.ts equals the operator's BuildIDLabel", () => {
        const expected = readOperatorBuildIDLabel();
        const found = readGcJsonpathLabels();
        for (const label of found) {
            expect(label, `gc.ts reads label "${label}"`).toBe(expected);
        }
    });
});
