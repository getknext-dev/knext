/**
 * #1183 follow-up (PR review finding #1, jev 0.93) — every in-repo
 * `kn-next.config*.ts` whose owning app's build script is `vite build` must
 * pin `build: 'vinext'` EXPLICITLY.
 *
 * DEFAULT_BUILDER_ID flipped from "vinext" to "turbopack" in this PR
 * (artifact-contract.ts). A config that omits `build` now resolves to the
 * standalone (`next build`) shape — but any app whose OWN build script still
 * runs `vite build` and ships a vinext single-exec Dockerfile does not
 * produce a `.next/standalone` tree at all, so the new default would break it
 * silently: `kn-next build`/`deploy` would look for an artifact the app's
 * build script never produces.
 *
 * SCANNED, not enumerated (workflow.md: "prefer scanning to enumerating; an
 * enumerated list of call sites is how the second one gets missed"). This
 * walks the whole repo for `kn-next.config*.ts` files (excluding
 * node_modules/.claude/templates/__tests__/dist — none of those are a real,
 * deployed app config), resolves each one's nearest ancestor `package.json`,
 * and — only when that package's `build` script is `vite build` — asserts the
 * config's source text pins `build: 'vinext'`.
 *
 * A config with no owning `package.json` (should not happen for a real app)
 * or a `package.json` with no `build` script is left alone: this guard is
 * scoped to the exact failure mode above, not a general config linter.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const EXCLUDED_DIR_NAMES = new Set([
    "node_modules",
    ".git",
    ".claude",
    "dist",
    "__tests__",
    "templates",
    ".turbo",
    ".next",
    "coverage",
]);

/** Depth-first walk for every `kn-next.config*.ts` under `root`, scanning not enumerating. */
function findKnextConfigs(root: string): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            if (EXCLUDED_DIR_NAMES.has(entry)) continue;
            const full = join(dir, entry);
            const st = statSync(full);
            if (st.isDirectory()) {
                walk(full);
            } else if (/^kn-next\.config.*\.ts$/.test(entry)) {
                found.push(full);
            }
        }
    };
    walk(root);
    return found;
}

/** Walk UP from `startDir` to the nearest ancestor `package.json`, or null. */
function nearestPackageJson(startDir: string): string | null {
    let dir = startDir;
    for (;;) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

interface Finding {
    configPath: string;
    packageJsonPath: string;
    buildScript: string;
}

/** Every config whose owning package's `build` script is exactly `vite build`. */
function vinextBuildConfigs(): Finding[] {
    const configs = findKnextConfigs(REPO_ROOT);
    const findings: Finding[] = [];
    for (const configPath of configs) {
        const packageJsonPath = nearestPackageJson(dirname(configPath));
        if (!packageJsonPath) continue;
        let pkg: { scripts?: Record<string, string> };
        try {
            pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        } catch {
            continue;
        }
        const buildScript = pkg.scripts?.build;
        if (buildScript === "vite build") {
            findings.push({ configPath, packageJsonPath, buildScript });
        }
    }
    return findings;
}

describe("#1183 every vite-build in-repo app config pins build: 'vinext'", () => {
    it("finds at least one vite-build config — otherwise this guard is checking nothing", () => {
        // Mutation-proof half 1: if nobody in the repo builds with vite
        // anymore, this suite would pass vacuously and stop meaning anything.
        expect(vinextBuildConfigs().length).toBeGreaterThan(0);
    });

    it("every vite-build config pins build: 'vinext' explicitly", () => {
        const findings = vinextBuildConfigs();
        const unpinned = findings.filter((f) => {
            const source = readFileSync(f.configPath, "utf8");
            return !/build\s*:\s*['"]vinext['"]/.test(source);
        });
        expect(
            unpinned.map((f) => relative(REPO_ROOT, f.configPath)),
            "these configs build with `vite build` but do not pin `build: 'vinext'` — " +
                "an absent `build` now resolves to the standalone (turbopack) default " +
                "(#1183), which this app's build script does not produce",
        ).toEqual([]);
    });
});
