/**
 * ci-typecheck-contract.test.ts — workflow-contract guard from the #274 gates
 * (plan-v2 P6c).
 *
 * The #261 typecheck gate runs per-package `tsc --noEmit` steps in ci.yml —
 * one HAND-LISTED step per package. That list can silently drift: a NEW
 * non-private TS package added to the workspace would ship with no typecheck
 * gate at all (exactly how the original 11-error baseline grew unnoticed).
 *
 * This test pins the contract from BOTH sides:
 *   1. every non-private TS package under packages/* has a `typecheck` script
 *      AND a `pnpm --filter <name> typecheck` step in ci.yml;
 *   2. every typecheck step in ci.yml points at an existing workspace package
 *      (no stale steps after a rename/removal).
 *
 * Deliberately scoped to packages/* (the publishable surface): apps/* are
 * private demo/e2e apps and are not part of the #261 gate.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const ciYml = readFileSync(
    join(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8",
);

interface PkgManifest {
    name?: string;
    private?: boolean;
    scripts?: Record<string, string>;
}

/** All packages/<dir>/package.json manifests in the workspace. */
function packageManifests(): PkgManifest[] {
    const pkgsDir = join(repoRoot, "packages");
    return readdirSync(pkgsDir)
        .map((d) => join(pkgsDir, d, "package.json"))
        .filter((p) => existsSync(p))
        .map((p) => JSON.parse(readFileSync(p, "utf8")) as PkgManifest);
}

/** The `pnpm --filter <name> typecheck` invocations present in ci.yml. */
function ciTypecheckFilters(): string[] {
    return [...ciYml.matchAll(/pnpm --filter (\S+) typecheck/g)].map(
        (m) => m[1],
    );
}

describe("ci.yml typecheck steps ↔ workspace non-private packages (#261 gate contract)", () => {
    const manifests = packageManifests();
    const nonPrivate = manifests.filter((m) => m.private !== true);
    const filters = ciTypecheckFilters();

    it("sanity: the workspace has non-private packages and ci.yml has typecheck steps", () => {
        expect(nonPrivate.length).toBeGreaterThanOrEqual(3);
        expect(filters.length).toBeGreaterThanOrEqual(3);
    });

    it("every non-private package has a typecheck script", () => {
        const missing = nonPrivate
            .filter((m) => !m.scripts?.typecheck)
            .map((m) => m.name);
        expect(missing).toEqual([]);
    });

    it("every non-private package has its own `pnpm --filter <name> typecheck` step in ci.yml", () => {
        const missing = nonPrivate
            .map((m) => m.name ?? "(unnamed)")
            .filter((name) => !filters.includes(name));
        expect(
            missing,
            "add a per-package typecheck step to ci.yml for each of these (the #261 gate is hand-listed and drifts silently otherwise)",
        ).toEqual([]);
    });

    it("every ci.yml typecheck step points at an existing workspace package (no stale steps)", () => {
        const known = new Set(manifests.map((m) => m.name));
        const stale = filters.filter((f) => !known.has(f));
        expect(stale).toEqual([]);
    });

    it("private packages are NOT hand-listed in the gate (scope stays the publishable surface)", () => {
        const privateNames = manifests
            .filter((m) => m.private === true)
            .map((m) => m.name ?? "");
        const listedPrivate = filters.filter((f) => privateNames.includes(f));
        expect(listedPrivate).toEqual([]);
    });
});
