import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
 * (`scripts/seam-alive-apps.mjs`), not by an enumerated list. This test pins the
 * scan, the WIRING that consumes it, and the coverage hole the scan alone cannot
 * see:
 *
 *   1. the scanner finds every app carrying the guard, and refuses to emit an
 *      empty matrix (an empty matrix is a vacuous gate);
 *   2. the WORKFLOW consumes it without swallowing that refusal, filters by a
 *      form that actually resolves an app, and never hard-codes an app;
 *   3. every app EXPOSED to the #352 class (instrumentation layer +
 *      `@getknext/lib`) actually carries the guard — the scan finds guard FILES,
 *      so "covered the moment it exists" would be false without this.
 *
 * Scope, stated rather than implied: every workflow under `.github/workflows` is
 * read (not just `ci.yml`), but nothing outside that directory is — a seam-guard
 * invocation in a Makefile or a shell script is out of this guard's reach. The
 * `appsCarryingTheGuard()` helper below deliberately re-implements the scanner's
 * algorithm, which catches filter divergence but SHARES its blind spots (a guard
 * nested deeper than `apps/<name>/`, or an app root other than `apps/`); the
 * `appsRequiringSeamGuard` assertion is what covers the "app is missing entirely"
 * direction. Workflows are read as text — the repo's convention for workflow
 * guards, no YAML dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
const CI_WORKFLOW = resolve(WORKFLOW_DIR, 'ci.yml');
const SCANNER = resolve(REPO_ROOT, 'scripts/seam-alive-apps.mjs');
const GUARD_FILENAME = 'standalone-seam-alive.test.ts';

/**
 * Re-derivation of the app set. NOT independent of the scanner's algorithm — see
 * the blind-spot note in the header — but independent of its CODE, so a change to
 * the scanner's filter shows up here.
 */
function appsCarryingTheGuard(): string[] {
  const appsDir = join(REPO_ROOT, 'apps');
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(appsDir, name, GUARD_FILENAME)))
    .sort();
}

/** Every workflow file, as `{ name, text }` — the whole directory, not just ci.yml. */
function workflows(): { name: string; text: string }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ name: f, text: readFileSync(join(WORKFLOW_DIR, f), 'utf8') }));
}

const ciWorkflow = readFileSync(CI_WORKFLOW, 'utf8');

/**
 * Every PATH to a seam guard referenced by ANY workflow, with the app segment
 * captured. Scanning for `apps/<x>/<guard>` (rather than for a known job name) is
 * what makes re-hardcoding an app in any workflow fail this test.
 */
function guardPathApps(): { workflow: string; app: string }[] {
  const re = new RegExp(`apps/(.+?)/${GUARD_FILENAME.replace(/\./g, '\\.')}`, 'g');
  return workflows().flatMap(({ name, text }) =>
    [...text.matchAll(re)].map((m) => ({ workflow: name, app: m[1] })),
  );
}

/** Run the scanner against an arbitrary tree; returns its exit code + stdout. */
function runScanner(root: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync('node', [SCANNER, `--root=${root}`], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? -1, stdout: e.stdout ?? '' };
  }
}

/** Materialise a synthetic app tree so the negative cases are EXECUTED, not asserted. */
function synthTree(
  apps: Record<string, { instrumentation?: boolean; lib?: boolean; guard?: boolean }>,
): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'seam-alive-tree-'));
  for (const [name, spec] of Object.entries(apps)) {
    const dir = join(root, 'apps', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        dependencies: spec.lib ? { '@getknext/lib': 'workspace:*' } : {},
      }),
    );
    if (spec.instrumentation) writeFileSync(join(dir, 'src/instrumentation.ts'), 'export {};\n');
    if (spec.guard) writeFileSync(join(dir, GUARD_FILENAME), '// guard\n');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function loadScanner() {
  return (await import(SCANNER)) as {
    discoverSeamAliveApps: (root: string) => string[];
    appsRequiringSeamGuard: (root: string) => string[];
  };
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
    try {
      expect(
        runScanner(empty).code,
        'the scanner emitted an empty matrix instead of failing',
      ).toBeGreaterThan(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('ci.yml has a seam-alive job whose matrix comes from the scanner', () => {
    expect(ciWorkflow).toMatch(/seam-alive-discover:/);
    expect(ciWorkflow).toMatch(/node scripts\/seam-alive-apps\.mjs/);
    expect(ciWorkflow).toMatch(
      /matrix:\s*\n\s*app:\s*\$\{\{\s*fromJSON\(needs\.seam-alive-discover\.outputs\.apps\)\s*\}\}/,
    );
  });

  it('the workflow does NOT swallow the scanner exit code in a command substitution', () => {
    // `echo "apps=$(node scripts/seam-alive-apps.mjs)" >> "$GITHUB_OUTPUT"` exits 0
    // even when the scanner exits 1: a command substitution's status is DISCARDED
    // and `echo` succeeds. That silently re-opens the vacuous-matrix hole in the
    // deployed wiring while the script-level test above stays green — a guard that
    // does not guard the thing that ships. Verified in a real `bash -eo pipefail`:
    // the swallowing form exits 0, `apps=$(…)` exits 1.
    for (const { name, text } of workflows()) {
      for (const line of text.split('\n')) {
        if (!line.includes('seam-alive-apps.mjs')) continue;
        expect(
          /\$\(.*seam-alive-apps\.mjs.*\)/.test(line) && /\becho\b/.test(line),
          `${name} wraps the scanner in a command substitution inside \`echo\` — ` +
            `its non-zero exit is discarded there. Assign first ` +
            `(\`apps=$(node scripts/seam-alive-apps.mjs)\`), then echo. Line: ${line.trim()}`,
        ).toBe(false);
      }
    }
  });

  it('every seam-guard path in any workflow is parameterized by matrix.app', () => {
    const hits = guardPathApps();
    expect(hits.length, 'no workflow runs the seam guard at all').toBeGreaterThan(0);
    for (const { workflow, app } of hits) {
      expect(
        app,
        `${workflow} hardcodes the app "${app}" for the seam guard — the gate must be ` +
          'driven by the scan so a new app is covered automatically',
      ).toBe('${{ matrix.app }}');
    }
  });

  it('the matrix job BUILDS the app it gates, filtering by PATH (a name filter matches nothing)', () => {
    const job = ciWorkflow.slice(ciWorkflow.indexOf('\n  seam-alive:'));
    const body = job.slice(0, job.indexOf('\n  no-latest-guard:') + 1 || undefined);
    // `pnpm --filter <x>` matches on PACKAGE NAME, but the matrix carries DIRECTORY
    // names — and they already differ (apps/docs is package "knext-docs"). Verified:
    // `pnpm --filter docs exec pwd` prints "No projects matched the filters" and
    // exits 0, i.e. builds NOTHING while looking fine; `--filter ./apps/docs` works.
    expect(
      body,
      'the per-app build must filter by PATH (./apps/${{ matrix.app }}) — a name ' +
        'filter silently matches nothing whenever a package name differs from its dir',
    ).toMatch(/pnpm --filter \.\/apps\/\$\{\{ matrix\.app \}\} build/);
    expect(body).toMatch(/KNEXT_REQUIRE_STANDALONE: '1'/);
  });

  it('every app EXPOSED to the #352 class carries the guard', async () => {
    // The scan finds guard FILES, so an app that NEEDS the guard and has none is
    // invisible to it. Exposure = an instrumentation layer + a @getknext/lib
    // dependency (the two preconditions for the module-state split).
    const { appsRequiringSeamGuard } = await loadScanner();
    const required = appsRequiringSeamGuard(REPO_ROOT);
    const covered = new Set(appsCarryingTheGuard());
    const missing = required.filter((app) => !covered.has(app));
    expect(
      missing,
      `these apps have an instrumentation layer AND depend on @getknext/lib, so the ` +
        `#352 seam split applies to them, but they carry no ${GUARD_FILENAME}: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the exposure rule has teeth: it flags an app with instrumentation + lib and no guard', async () => {
    // Executed against a synthetic tree, so this case is proven rather than argued.
    const { appsRequiringSeamGuard, discoverSeamAliveApps } = await loadScanner();
    const { root, cleanup } = synthTree({
      exposed: { instrumentation: true, lib: true, guard: false },
      guarded: { instrumentation: true, lib: true, guard: true },
      'no-instrumentation': { instrumentation: false, lib: true, guard: false },
      'no-lib': { instrumentation: true, lib: false, guard: false },
    });
    try {
      expect(appsRequiringSeamGuard(root)).toEqual(['exposed', 'guarded']);
      expect(discoverSeamAliveApps(root)).toEqual(['guarded']);
    } finally {
      cleanup();
    }
  });
});
