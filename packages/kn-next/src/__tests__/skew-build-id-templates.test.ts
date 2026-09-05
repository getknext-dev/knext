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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/**
 * Every scaffold template that ships a Next config.
 *
 * DISCOVERED by `git ls-files`, never listed — the same fix the in-repo apps
 * half of this file already carries (#920 review round 2). An enumerated array
 * is how the THIRD template ships unchecked while the suite stays green (the
 * #892 root cause reappearing in a new scaffold). A glob that matches nothing
 * is asserted to FAIL below, so discovery cannot pass vacuously.
 */
const NEXT_CONFIG_TEMPLATES = execFileSync(
    "git",
    ["ls-files", "**/templates/**/next.config.ts.hbs"],
    { cwd: REPO_ROOT, encoding: "utf8" },
)
    .split("\n")
    .filter((p) => p.length > 0)
    .map((rel) => join(REPO_ROOT, rel));

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

    it("the glob found the templates (a glob matching nothing proves nothing)", () => {
        // Non-vacuity on the discovery itself: a glob that matched nothing
        // would make the `it.each` below run zero cases and pass silently.
        // The two known scaffold templates are the floor, not the ceiling — a
        // third one added later is discovered and checked without editing here.
        expect(NEXT_CONFIG_TEMPLATES.length).toBeGreaterThanOrEqual(2);
        expect(
            NEXT_CONFIG_TEMPLATES.some((p) =>
                p.endsWith(
                    join(
                        "packages",
                        "kn-next",
                        "templates",
                        "app",
                        "next.config.ts.hbs",
                    ),
                ),
            ),
        ).toBe(true);
        expect(
            NEXT_CONFIG_TEMPLATES.some((p) =>
                p.endsWith(
                    join(
                        "turbo",
                        "generators",
                        "templates",
                        "zone",
                        "next.config.ts.hbs",
                    ),
                ),
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
    /** Every tracked Next config under `apps/` and `examples/`, any extension. */
    const tracked = execFileSync("git", ["ls-files", "apps", "examples"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
    })
        .split("\n")
        .filter((p) => /(^|\/)next\.config\.(ts|mts|cts|js|mjs|cjs)$/.test(p));

    /**
     * An app is in scope iff knext can BUILD or DEPLOY it — that is, it has a
     * `kn-next.config.ts` (deployable) or a `vite.config.ts` (the vinext build
     * entry, which is how `examples/bun-exec` qualifies without the former).
     *
     * Derived rather than a hand-written skip list, and the excluded set is
     * ASSERTED below rather than silently dropped. Round 2's version globbed
     * `apps/*` + `.ts` only, which silently missed
     * `apps/spike-bun-bytecode/next.config.mjs` — a bare bytecode benchmark
     * with neither config, so out of scope, but nothing said so.
     */
    const isKnextApp = (rel: string): boolean => {
        const dir = join(REPO_ROOT, rel, "..");
        return (
            existsSync(join(dir, "kn-next.config.ts")) ||
            existsSync(join(dir, "vite.config.ts"))
        );
    };

    const inScope = tracked.filter(isKnextApp);
    const outOfScope = tracked.filter((p) => !isKnextApp(p));

    it("the scan found the apps (a glob matching nothing proves nothing)", () => {
        // It must see MORE than the in-scope set, or the exclusion below is
        // vacuous — a filter that filters nothing is not a filter.
        expect(tracked.length).toBeGreaterThan(inScope.length);
        expect(inScope.length).toBeGreaterThanOrEqual(4);
        // And it must reach past one directory level and past `.ts`.
        expect(tracked.some((p) => p.endsWith(".mjs"))).toBe(true);
    });

    it("everything excluded is excluded for a stated reason", () => {
        // Not an allowlist of names: the assertion is that each excluded app
        // genuinely has neither config, so knext never builds or deploys it.
        for (const rel of outOfScope) {
            expect(isKnextApp(rel)).toBe(false);
        }
        // Named so the exclusion is visible in the test output rather than
        // being a silent gap, and so adding a knext config to one of these
        // moves it into scope loudly.
        expect(outOfScope).toEqual(["apps/spike-bun-bytecode/next.config.mjs"]);
    });

    it.each(inScope)("%s mints its build id from the deploy id", (rel) => {
        const source = readFileSync(join(REPO_ROOT, rel), "utf8");
        expect(mintsBuildIdFromDeploymentId(source)).toBe(true);
    });
});
