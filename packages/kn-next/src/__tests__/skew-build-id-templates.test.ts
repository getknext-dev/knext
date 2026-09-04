/**
 * T2a (ADR-0011 skew chain) — the scaffold templates must MINT the static
 * namespace from the deploy id.
 *
 * The measurement this pins (sprint-2 system design, T2): vinext's
 * `resolveBuildId(generate)` returns `safeUUID()` when the Next config sets no
 * `generateBuildId`, and vinext reads `NEXT_DEPLOYMENT_ID` from the environment
 * for `?dpl=` all by itself. So the ONLY reason a scaffolded app's chunks live
 * under `_next/static/<uuid>/` instead of `_next/static/<deploy-tag>/` is that
 * neither template ever set `generateBuildId`. That one absence is the root
 * cause of the whole #892 chain: the marker cannot be staged, the GC cannot
 * protect, the reclaim targets a prefix that was never written.
 *
 * Both templates are scanned by the SAME predicate, and the predicate is proved
 * non-vacuous against controls (a template with no line at all, and one that
 * mints from the wrong source) before it is trusted on the real files.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** Every scaffold template that ships a Next config. */
const NEXT_CONFIG_TEMPLATES = [
    join(
        REPO_ROOT,
        "packages",
        "kn-next",
        "templates",
        "app",
        "next.config.ts.hbs",
    ),
    join(
        REPO_ROOT,
        "turbo",
        "generators",
        "templates",
        "zone",
        "next.config.ts.hbs",
    ),
];

/**
 * True when the source mints the build id from `NEXT_DEPLOYMENT_ID` via
 * `generateBuildId`, with an explicit `|| null` fallback (null ⇒ vinext's own
 * UUID, so a plain `vite build` outside `kn-next deploy` is unchanged).
 *
 * **`||`, not `??`, and the difference is behavioural.** With `??` an
 * `NEXT_DEPLOYMENT_ID` exported as the EMPTY STRING yields `""` — which is not
 * null, so vinext takes it as the build id and then rejects it as empty. `||`
 * treats empty as absent and falls back, which is the safe reading and is what
 * `apps/file-manager` and `apps/docs` already ship. Round 1 used `??` and would
 * have put the scaffold a step out of line with both.
 *
 * Comment-insensitive: the prose in these templates mentions both identifiers
 * for good reasons, and a predicate that matched prose would go green on a
 * template that only TALKS about the id.
 */
function mintsBuildIdFromDeploymentId(source: string): boolean {
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    return /generateBuildId\s*:\s*\(\s*\)\s*=>\s*process\.env\.NEXT_DEPLOYMENT_ID\s*\|\|\s*null/.test(
        code,
    );
}

describe("T2a — scaffold templates mint the static namespace from the deploy id", () => {
    it("the predicate is non-vacuous: it rejects the shapes that caused #892", () => {
        // (a) The pre-T2a template shape — no generateBuildId at all.
        expect(
            mintsBuildIdFromDeploymentId(
                `const nextConfig = { assetPrefix: process.env.ASSET_PREFIX || "" };`,
            ),
        ).toBe(false);
        // (b) Minted, but from the wrong source — still a namespace nothing
        // can resolve against a revision label.
        expect(
            mintsBuildIdFromDeploymentId(
                `const nextConfig = { generateBuildId: () => process.env.GIT_SHA || null };`,
            ),
        ).toBe(false);
        // (b2) `??` instead of `||`: an empty NEXT_DEPLOYMENT_ID becomes the
        // build id `""`, which vinext rejects as empty rather than falling
        // back. Rejected so the scaffold cannot drift from the in-repo apps.
        expect(
            mintsBuildIdFromDeploymentId(
                `const nextConfig = { generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID ?? null };`,
            ),
        ).toBe(false);
        // (c) Named only in prose. A comment mints nothing.
        expect(
            mintsBuildIdFromDeploymentId(
                `/* generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID ?? null */\nconst c = {};`,
            ),
        ).toBe(false);
        // (d) The shape T2a lands — the predicate must accept it.
        expect(
            mintsBuildIdFromDeploymentId(
                `const nextConfig = { generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null };`,
            ),
        ).toBe(true);
    });

    it.each(
        NEXT_CONFIG_TEMPLATES,
    )("%s sets generateBuildId from NEXT_DEPLOYMENT_ID", (template) => {
        const source = readFileSync(template, "utf8");
        // Non-vacuity on the file itself: an empty/missing read would pass
        // nothing, so pin that we are scanning a real Next config.
        expect(source).toContain("NextConfig");
        expect(mintsBuildIdFromDeploymentId(source)).toBe(true);
    });
});

/**
 * The same rule over the apps this repo actually deploys.
 *
 * Fixing the templates does nothing for an app that already exists, and two of
 * ours were in exactly that state: `apps/db-demo` and `examples/bun-exec` set
 * no `generateBuildId`, and neither sets `build` in its knext config, so both
 * resolve to vinext and both would have been aborted by the deploy guard the
 * templates' fix makes load-bearing. That is the migration hazard every
 * existing user faces, sitting in our own tree.
 *
 * DISCOVERED by `git ls-files`, never listed: an app added next month is
 * checked tonight, and "we forgot the fourth one" is how this shipped.
 */
describe("in-repo apps carry the same generateBuildId", () => {
    const configs = execFileSync(
        "git",
        ["ls-files", "apps/*/next.config.ts", "examples/*/next.config.ts"],
        { cwd: REPO_ROOT, encoding: "utf8" },
    )
        .split("\n")
        .filter(Boolean);

    it("the scan found the apps (a glob matching nothing proves nothing)", () => {
        expect(configs.length).toBeGreaterThanOrEqual(4);
    });

    it.each(configs)("%s mints its build id from the deploy id", (rel) => {
        const source = readFileSync(join(REPO_ROOT, rel), "utf8");
        expect(source).toContain("NextConfig");
        expect(mintsBuildIdFromDeploymentId(source)).toBe(true);
    });
});
