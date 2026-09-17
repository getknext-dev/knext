/**
 * Reuse pin for the doctor decomposition (#1055).
 *
 * The CRD-schema preflight lives in `cli/schema/` (the ADR-0001 path). The
 * decomposition must REUSE it, never fork a second copy: so
 *   1. no `cli/doctor/crd-schema.ts` may exist (it would collide with the
 *      existing `cli/schema/crd-schema.ts` and re-implement its logic), and
 *   2. any CRD-schema symbol a `cli/doctor/**` file imports
 *      (readKnownCRDFields, unknownEmittedFields, EMITTED_CR_FIELD_PATHS,
 *      preflightCRSchema) must be imported FROM `cli/schema/`, never
 *      re-declared locally.
 *
 * Before the decomposition this passes vacuously (the directory does not yet
 * exist); after it, it is load-bearing.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(HERE, "..", "cli");
const DOCTOR_DIR = join(CLI_DIR, "doctor");

const SCHEMA_SYMBOLS = [
    "readKnownCRDFields",
    "unknownEmittedFields",
    "EMITTED_CR_FIELD_PATHS",
    "preflightCRSchema",
];

function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
}

describe("doctor decomposition reuses cli/schema for CRD-schema work", () => {
    it("does NOT create a colliding cli/doctor/crd-schema.ts", () => {
        expect(existsSync(join(DOCTOR_DIR, "crd-schema.ts"))).toBe(false);
    });

    it("imports every CRD-schema symbol only from cli/schema/", () => {
        const files = walk(DOCTOR_DIR);
        for (const file of files) {
            const src = readFileSync(file, "utf-8");
            // Match ESM import statements naming a CRD-schema symbol.
            const importRe =
                /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
            for (const m of src.matchAll(importRe)) {
                const names = (m[1] ?? "")
                    .split(",")
                    .map((s) =>
                        s
                            .trim()
                            .replace(/^type\s+/, "")
                            .split(/\s+as\s+/)[0]
                            ?.trim(),
                    )
                    .filter(Boolean);
                const from = m[2] ?? "";
                const hasSchemaSymbol = names.some((n) =>
                    SCHEMA_SYMBOLS.includes(n ?? ""),
                );
                if (hasSchemaSymbol) {
                    expect(
                        from.includes("schema/"),
                        `${file} imports a CRD-schema symbol from "${from}", not cli/schema/`,
                    ).toBe(true);
                }
            }
            // And it must not re-declare them locally.
            for (const sym of SCHEMA_SYMBOLS) {
                const declRe = new RegExp(
                    `(?:function|const|let|class)\\s+${sym}\\b`,
                );
                expect(
                    declRe.test(src),
                    `${file} re-declares CRD-schema symbol "${sym}" — reuse cli/schema/ instead`,
                ).toBe(false);
            }
        }
    });
});
