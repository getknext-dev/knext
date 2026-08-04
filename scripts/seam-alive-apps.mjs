#!/usr/bin/env node
/**
 * #408 item 2 — DISCOVER every app that carries the `#352/#344` seam-alive
 * build-artifact guard, so CI can build and gate each one.
 *
 * Why a scanner and not a list: `standalone-seam-alive.test.ts` only hard-fails
 * under `KNEXT_REQUIRE_STANDALONE=1`, and CI used to set that for ONE
 * hard-coded app (file-manager). Every other app — including every app
 * `turbo gen zone` generates — ran its copy build-less and passed by SKIPPING,
 * so chunk-level seam drift could never fail the app that introduced it. An
 * enumerated list is how the second app gets missed; this scans instead, so a
 * new app is covered the moment it CARRIES the guard.
 *
 * That last word is load-bearing and was over-claimed at first: this scan finds
 * GUARD FILES, not apps, so an app that needs the guard and does not have one is
 * invisible to it. `appsRequiringSeamGuard()` below closes that half — it derives
 * which apps are exposed to the #352 bug class (an `instrumentation.ts` layer AND
 * a `@getknext/lib` dependency: the two preconditions for the module-state split)
 * so `tests/seam-alive-app-coverage.test.ts` can fail when one lacks the guard.
 *
 * Output: a JSON array of app directory names (a GitHub Actions matrix input),
 * e.g. `["file-manager"]`. Exits non-zero when it finds NOTHING — an empty
 * matrix is a silently-zero gate, which is the exact failure mode this fixes.
 *
 * Guarded by `tests/seam-alive-app-coverage.test.ts`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SEAM_GUARD_FILENAME = 'standalone-seam-alive.test.ts';

/** @param {string} repoRoot @returns {string[]} every directory under apps/ */
function appDirs(repoRoot) {
  const appsDir = join(repoRoot, 'apps');
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** @param {string} repoRoot @returns {string[]} app dir names, sorted */
export function discoverSeamAliveApps(repoRoot) {
  const appsDir = join(repoRoot, 'apps');
  return appDirs(repoRoot).filter((name) => existsSync(join(appsDir, name, SEAM_GUARD_FILENAME)));
}

/**
 * Apps EXPOSED to the #352 bug class, whether or not they carry the guard.
 *
 * #352 needs both preconditions: an `instrumentation.ts` (Next compiles it in a
 * SEPARATE webpack layer from the app-server bundles) and a `@getknext/lib`
 * dependency (the module whose state gets duplicated across those layers). An app
 * with neither cannot exhibit it, so requiring the guard there would be noise.
 *
 * `discoverSeamAliveApps` answers "who has a guard"; this answers "who NEEDS one",
 * and the difference between the two sets is a coverage hole. Kept next to the
 * scanner (not in the test) so the empty/negative cases can be EXECUTED against a
 * synthetic tree rather than asserted from a re-implementation.
 *
 * @param {string} repoRoot @returns {string[]} app dir names, sorted
 */
export function appsRequiringSeamGuard(repoRoot) {
  const appsDir = join(repoRoot, 'apps');
  return appDirs(repoRoot).filter((name) => {
    const dir = join(appsDir, name);
    const hasInstrumentation =
      existsSync(join(dir, 'src/instrumentation.ts')) ||
      existsSync(join(dir, 'instrumentation.ts'));
    if (!hasInstrumentation) return false;
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return false;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      // An unparseable manifest must not silently exempt an app from the gate.
      return true;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.hasOwn(deps, '@getknext/lib');
  });
}

const REPO_ROOT = resolve(import.meta.dirname, '..');

if (import.meta.url === `file://${process.argv[1]}`) {
  // `--root=<dir>` exists so the guard test can EXECUTE the empty-tree case and
  // observe a non-zero exit, rather than reading the source and believing it.
  const rootArg = process.argv.slice(2).find((a) => a.startsWith('--root='));
  const apps = discoverSeamAliveApps(
    rootArg ? resolve(rootArg.slice('--root='.length)) : REPO_ROOT,
  );
  if (apps.length === 0) {
    console.error(
      `[seam-alive-apps] found no app carrying ${SEAM_GUARD_FILENAME} under apps/ — ` +
        'refusing to emit an empty matrix, which would make the seam gate silently vacuous.',
    );
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(apps)}\n`);
}
