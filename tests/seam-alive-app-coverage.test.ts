import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TEST for #408 item 2 — the generated-app seam-alive guard must not be
 * green-by-skip.
 *
 * The #352/#344 build-artifact guard (`standalone-seam-alive.test.ts`) proves the
 * `@getknext/lib` module-state seams survive the standalone bundle. It hard-fails
 * only under `KNEXT_REQUIRE_STANDALONE=1`; without a standalone build present and
 * without that flag it SKIPS. CI set the flag for exactly ONE hard-coded app
 * (`apps/file-manager`), so every other app — including every app `turbo gen
 * zone` generates — ran its copy build-less and passed by skipping. A guard that
 * silently passes when its precondition is absent is decoration.
 *
 * The fix is a PER-APP CI build job driven by a SCAN
 * (`scripts/seam-alive-apps.mjs`), not by an enumerated list — an enumerated list
 * is how the second app gets missed. This test pins both halves:
 *
 *   1. the scanner really finds every app carrying the guard, and refuses to
 *      emit an empty matrix (an empty matrix is a vacuous gate);
 *   2. `ci.yml` runs the guard ONLY through that scan-driven matrix — every
 *      occurrence of the guard filename in the workflow must be parameterized by
 *      `matrix.app`, so re-hardcoding one app turns this test red.
 *
 * Scans the workflow as text (the repo's convention for workflow guards — no
 * YAML dependency).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CI_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const SCANNER = resolve(REPO_ROOT, 'scripts/seam-alive-apps.mjs');
const GUARD_FILENAME = 'standalone-seam-alive.test.ts';

/** Independent re-derivation of the app set — never imported from the scanner. */
function appsCarryingTheGuard(): string[] {
  const appsDir = join(REPO_ROOT, 'apps');
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(appsDir, name, GUARD_FILENAME)))
    .sort();
}

const workflow = readFileSync(CI_WORKFLOW, 'utf8');

/**
 * Every PATH to a seam guard that ci.yml references, with the app segment
 * captured. Scanning for `apps/<x>/<guard>` (rather than for a known job name)
 * is what makes re-hardcoding an app anywhere in the workflow fail this test.
 */
const GUARD_PATH_RE = new RegExp(`apps/(.+?)/${GUARD_FILENAME.replace(/\./g, '\\.')}`, 'g');
function guardPathApps(): string[] {
  return [...workflow.matchAll(GUARD_PATH_RE)].map((m) => m[1]);
}

describe('#408 — seam-alive gate covers EVERY app, by scanning (not by enumeration)', () => {
  it('the scanner finds exactly the apps that carry the guard', () => {
    expect(existsSync(SCANNER), `${SCANNER} missing`).toBe(true);
    const out = execFileSync('node', [SCANNER], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(appsCarryingTheGuard());
  });

  it('at least one app carries the guard (else the whole gate is vacuous)', () => {
    expect(appsCarryingTheGuard().length).toBeGreaterThan(0);
  });

  it('the scanner FAILS rather than emitting an empty matrix', () => {
    // An empty matrix makes every downstream job "succeed" with zero coverage —
    // the same green-by-absence failure this whole issue is about. Proven by
    // EXECUTION against a tree with no apps/, not by reading the source.
    const empty = mkdtempSync(join(tmpdir(), 'seam-alive-empty-'));
    let exitCode: number | undefined;
    try {
      execFileSync('node', [SCANNER, `--root=${empty}`], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      exitCode = (err as { status?: number }).status;
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(exitCode, 'the scanner emitted an empty matrix instead of failing').toBeGreaterThan(0);
  });

  it('ci.yml has a seam-alive job whose matrix comes from the scanner', () => {
    expect(workflow).toMatch(/seam-alive-discover:/);
    expect(workflow).toMatch(/node scripts\/seam-alive-apps\.mjs/);
    expect(workflow).toMatch(
      /matrix:\s*\n\s*app:\s*\$\{\{\s*fromJSON\(needs\.seam-alive-discover\.outputs\.apps\)\s*\}\}/,
    );
  });

  it('every seam-guard path in ci.yml is parameterized by matrix.app', () => {
    const apps = guardPathApps();
    expect(apps.length, 'ci.yml never runs the seam guard at all').toBeGreaterThan(0);
    for (const app of apps) {
      expect(
        app,
        `ci.yml hardcodes the app "${app}" for the seam guard — the gate must be ` +
          'driven by the scan so a NEW app is covered automatically',
      ).toBe('${{ matrix.app }}');
    }
  });

  it('the matrix job BUILDS the app it gates (a missing build must not be skippable)', () => {
    const job = workflow.slice(workflow.indexOf('\n  seam-alive:'));
    const body = job.slice(0, job.indexOf('\n  no-latest-guard:') + 1 || undefined);
    expect(body).toMatch(/pnpm --filter \$\{\{ matrix\.app \}\} build/);
    expect(body).toMatch(/KNEXT_REQUIRE_STANDALONE: '1'/);
  });
});
