/**
 * ci-typecheck-contract.test.ts — workflow-contract guard from the #274 gates
 * (plan-v2 P6c) and the P6c typecheck-coverage completion.
 *
 * The #261 typecheck gate runs per-package `tsc --noEmit` steps in ci.yml —
 * one HAND-LISTED step per package. That list can silently drift: a NEW
 * TS package added to the workspace would ship with no typecheck gate at all
 * (exactly how the original 11-error baseline grew unnoticed).
 *
 * This test pins the contract from BOTH sides:
 *   1. every non-private TS package under packages/* has a `typecheck` script
 *      AND a `pnpm --filter <name> typecheck` step in ci.yml;
 *   2. every typecheck step in ci.yml points at an existing workspace package
 *      (no stale steps after a rename/removal).
 *
 * P6c completion: the coverage is extended to EVERY TS package/app in the
 * workspace (packages/* AND apps/*). Each must be in exactly one of two
 * buckets — (a) COVERED (has a `typecheck` script wired into ci.yml), or
 * (b) a DOCUMENTED EXCLUSION in the allowlist below (with a stated reason).
 * A new TS package added with neither fails this test. No silent gaps.
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

/**
 * Documented typecheck-gate exclusions (P6c). A TS workspace member is allowed
 * to sit OUT of the CI `tsc --noEmit` gate only if it is listed here WITH a
 * reason. Removing a package from CI without a reason here — or adding a new TS
 * package that is neither gated nor listed — fails the coverage test below.
 *
 * Keyed by package `name`.
 */
const DOCUMENTED_EXCLUSIONS: Record<string, string> = {
    // Reference/e2e Next.js app. Its next-adapter.test.ts fixtures carry real
    // type debt against Next's evolving NextAdapter output types (7 TS2345
    // shape mismatches as of P6c) — a genuine debt signal, not a config gap.
    // Excluded until the fixtures are re-typed against the current adapter API;
    // tracked as follow-up. Do NOT suppress the errors to force it green.
    "file-manager":
        "reference e2e app; real type debt in next-adapter.test.ts fixtures (TS2345 vs current NextAdapter output types) — re-type fixtures before gating",
    // Throwaway cold-start spike: no TypeScript source and no tsconfig.json
    // (only next.config-less scaffolding). Nothing for `tsc --noEmit` to check.
    "spike-bun-bytecode":
        "throwaway cold-start spike — no TS source and no tsconfig, nothing to typecheck",
};

interface PkgManifest {
    name?: string;
    private?: boolean;
    scripts?: Record<string, string>;
    _dir?: string;
}

/** Read every <root>/<glob>/package.json under the given workspace dir. */
function manifestsUnder(rootDir: string): PkgManifest[] {
    const base = join(repoRoot, rootDir);
    if (!existsSync(base)) return [];
    return readdirSync(base)
        .map((d) => ({ dir: d, p: join(base, d, "package.json") }))
        .filter(({ p }) => existsSync(p))
        .map(({ dir, p }) => ({
            ...(JSON.parse(readFileSync(p, "utf8")) as PkgManifest),
            _dir: `${rootDir}/${dir}`,
        }));
}

/** packages/<dir>/package.json manifests (the publishable surface). */
function packageManifests(): PkgManifest[] {
    return manifestsUnder("packages");
}

/** Every TS workspace member: packages/* AND apps/*. */
function allWorkspaceManifests(): PkgManifest[] {
    return [...manifestsUnder("packages"), ...manifestsUnder("apps")];
}

/** A manifest with a `typecheck` script we can actually run. */
function hasTypecheckScript(m: PkgManifest): boolean {
    return typeof m.scripts?.typecheck === "string";
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

    it("every ci.yml typecheck step points at an existing workspace member (no stale steps)", () => {
        const known = new Set(allWorkspaceManifests().map((m) => m.name));
        const stale = filters.filter((f) => !known.has(f));
        expect(stale).toEqual([]);
    });

    it("a private package is gated only when it intentionally ships a typecheck script", () => {
        // The gate is no longer scoped to the publishable surface only (P6c): a
        // private package MAY be gated, but only if it deliberately provides a
        // `typecheck` script. Gating a private package with no such script is a
        // drift signal (a hand-listed step pointing at nothing runnable).
        const scriptByName = new Map(
            manifests.map((m) => [m.name, hasTypecheckScript(m)]),
        );
        const privateNames = new Set(
            manifests
                .filter((m) => m.private === true)
                .map((m) => m.name ?? ""),
        );
        const gatedPrivateWithoutScript = filters.filter(
            (f) => privateNames.has(f) && scriptByName.get(f) !== true,
        );
        expect(gatedPrivateWithoutScript).toEqual([]);
    });
});

/**
 * P6c coverage completion: EVERY TS workspace member (packages/* AND apps/*)
 * must be either COVERED by the CI typecheck gate or a DOCUMENTED EXCLUSION.
 * This is the durable guard — a new TS package with neither fails here.
 */
describe("every TS workspace member is typecheck-covered or documented-excluded (P6c)", () => {
    const all = allWorkspaceManifests();
    const filters = ciTypecheckFilters();
    const filterSet = new Set(filters);

    it("sanity: the workspace enumerates both packages/* and apps/*", () => {
        const dirs = all.map((m) => m._dir ?? "");
        expect(dirs.some((d) => d.startsWith("packages/"))).toBe(true);
        expect(dirs.some((d) => d.startsWith("apps/"))).toBe(true);
    });

    it("a member is COVERED (typecheck script + ci.yml step) or DOCUMENTED-EXCLUDED — never a silent gap", () => {
        const gaps = all
            .filter((m) => {
                const name = m.name ?? "";
                const covered = hasTypecheckScript(m) && filterSet.has(name);
                const excluded = name in DOCUMENTED_EXCLUSIONS;
                return !covered && !excluded;
            })
            .map((m) => m._dir ?? m.name);
        expect(
            gaps,
            "each of these TS members needs EITHER a `typecheck` script wired into ci.yml (a `pnpm --filter <name> typecheck` step) OR an entry in DOCUMENTED_EXCLUSIONS with a reason",
        ).toEqual([]);
    });

    it("every COVERED member has both a runnable script and a ci.yml step (no half-wiring)", () => {
        const halfWired = all
            .filter((m) => {
                const name = m.name ?? "";
                if (name in DOCUMENTED_EXCLUSIONS) return false;
                const scripted = hasTypecheckScript(m);
                const gated = filterSet.has(name);
                // covered means both; half-wired means exactly one
                return scripted !== gated;
            })
            .map(
                (m) =>
                    `${m._dir}: script=${hasTypecheckScript(m)} ci=${filterSet.has(m.name ?? "")}`,
            );
        expect(halfWired).toEqual([]);
    });

    it("every DOCUMENTED_EXCLUSIONS entry names a real workspace member and states a reason", () => {
        const names = new Set(all.map((m) => m.name));
        for (const [name, reason] of Object.entries(DOCUMENTED_EXCLUSIONS)) {
            expect(
                names.has(name),
                `exclusion "${name}" is not a workspace member (stale?)`,
            ).toBe(true);
            expect(
                reason.length,
                `exclusion "${name}" needs a real reason`,
            ).toBeGreaterThan(20);
        }
    });

    it("no member is BOTH gated and documented-excluded (buckets are exclusive)", () => {
        const both = all
            .map((m) => m.name ?? "")
            .filter(
                (name) => name in DOCUMENTED_EXCLUSIONS && filterSet.has(name),
            );
        expect(both).toEqual([]);
    });
});
