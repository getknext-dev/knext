/**
 * Every tracked vinext pin moves in lockstep with the REPO's current vinext
 * version (sourced from `packages/kn-next/package.json`, the published
 * core's own pin).
 *
 * A vinext bump touches seven places (the core package, the reference app, the
 * docs app, the node-app test fixture, the app scaffold template, the zone
 * generator template and the compat install script). Bumps have been done by
 * grep-and-edit, and one miss means the compat lane measures a different vinext
 * from the one users scaffold. This guard SCANS every tracked `package.json` /
 * `package.json.hbs` rather than enumerating them, so a new manifest that pins
 * vinext is covered the day it lands.
 * It also scans every tracked `bun.lock`: a lock left resolving an older vinext
 * installs that version wherever it is used with a frozen or re-used lockfile.
 *
 * Deliberate exceptions, both frozen historical artifacts rather than shipped
 * code: `examples/bun-exec`, the ADR-0042 A1 benchmark recipe pinned at vinext
 * beta.4 (see the self-expiring exemption in
 * `packages/kn-next/src/__tests__/vinext-isr-redis-wiring.test.ts`), and the
 * spike fixtures under `docs/wayfinder/`, which record what a spike measured.
 *
 * #1780 (FOLDED BACK, as the pre-existing header here anticipated):
 * `scripts/e2e-deploy-vinext.sh` used to be a THIRD, hardcoded exception —
 * frozen on `1.0.0-beta.12` behind the v1.0.0-rc.5 credential window
 * (`frozenFileSet()`, `.github/compat-credential-ref.json`) while every other
 * site had already moved to `1.0.1`. That drift was never load-bearing on the
 * freeze guard: the finding was that the lane's `VINEXT_VERSION` default was a
 * bare literal that nobody had re-bumped, and worse, the harness never even
 * applied knext's bundled vinext patches, so every patch in
 * `packages/kn-next/templates/vinext-patches/` measured "not working" in a
 * compat run for a reason that had nothing to do with the patch.
 *
 * The fix is not "bump the literal" (which would still be the credential-frozen
 * literal bump the header above refused, out of scope for a template-pin PR). It
 * is to stop the script from carrying a literal AT ALL: `VINEXT_VERSION`'s
 * default is now a runtime read of `packages/kn-next/package.json` (see the
 * `# BEGIN/END vinext-version-resolution` block in the script), so the script
 * can never again drift from the repo pin — there is nothing left to
 * re-bump by hand, credential window or not. The tests below prove that by
 * actually RUNNING the block, not by parsing a version out of the text.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = 'scripts/e2e-deploy-vinext.sh';
const REPO_VINEXT_VERSION_SOURCE = 'packages/kn-next/package.json';
const EXEMPT_PREFIXES = ['examples/bun-exec/', 'docs/wayfinder/'];
const VERSION_BLOCK_BEGIN = '# BEGIN vinext-version-resolution';
const VERSION_BLOCK_END = '# END vinext-version-resolution';

/**
 * The deploy script's own vinext-version-resolution lines, delimited by
 * sentinel comments in `scripts/e2e-deploy-vinext.sh` — a SCAN for the
 * markers rather than an enumeration of line numbers, so moving the block
 * within the script does not break this test; only deleting or duplicating a
 * marker does, which is exactly the signal wanted (#1780).
 */
export function vinextVersionResolutionBlock(script: string): string {
  const beginCount = script.split(VERSION_BLOCK_BEGIN).length - 1;
  const endCount = script.split(VERSION_BLOCK_END).length - 1;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(
      `expected exactly one ${VERSION_BLOCK_BEGIN} / ${VERSION_BLOCK_END} marker pair in ` +
        `${DEPLOY_SCRIPT}, found ${beginCount}/${endCount}`,
    );
  }
  const startIdx = script.indexOf(VERSION_BLOCK_BEGIN);
  const endIdx = script.indexOf(VERSION_BLOCK_END, startIdx);
  if (endIdx === -1 || endIdx < startIdx) {
    throw new Error(`${VERSION_BLOCK_END} precedes ${VERSION_BLOCK_BEGIN} in ${DEPLOY_SCRIPT}`);
  }
  return script.slice(startIdx, endIdx);
}

/**
 * ACTUALLY RUNS the harness's own version-resolution block — extracted
 * verbatim from the live script, never re-derived in JS — in a throwaway
 * bash subprocess, and returns the resulting `VINEXT_VERSION`. This proves
 * the REAL runtime value a script edit produces (per the task: "read it at
 * runtime"), not a regex's guess at a literal — which is exactly the mode
 * that went stale under #1780, since the old guard parsed a bare
 * `VINEXT_VERSION="${KNEXT_VINEXT_VERSION:-<v>}"` default out of the script
 * text, and that default is now a `$(node …)` read of package.json with
 * nothing literal left to parse.
 *
 * `REPO_ROOT` is injected directly (bypassing the script's own
 * `SCRIPT_DIR`-relative computation) because only the resolution block, not
 * the whole script, runs here — the block depends on `REPO_ROOT` being set,
 * which the full script computes earlier from `BASH_SOURCE`.
 */
function resolveHarnessVinextVersion(override?: string): string {
  const script = readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8');
  const block = vinextVersionResolutionBlock(script);
  const wrapper = [
    'set -euo pipefail',
    // The block calls `log` on a read failure; stubbed so that path cannot
    // crash on "command not found" instead of reporting the real problem.
    'log() { printf "%s\\n" "$*" >&2; }',
    block,
    'printf \'%s\' "$VINEXT_VERSION"',
  ].join('\n');
  const env: Record<string, string | undefined> = { ...process.env, REPO_ROOT: repoRoot };
  if (override === undefined) {
    delete env.KNEXT_VINEXT_VERSION;
  } else {
    env.KNEXT_VINEXT_VERSION = override;
  }
  return execFileSync('bash', ['-c', wrapper], { cwd: repoRoot, encoding: 'utf8', env });
}

/**
 * The `vinext` pin in a manifest's dependency blocks. Handlebars templates are
 * not valid JSON, so this matches the `"vinext": "<v>"` entry textually; a
 * template with more than one entry returns every hit so the caller can red.
 */
export function vinextPins(manifest: string): string[] {
  return [...manifest.matchAll(/"vinext"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
}

function trackedManifests(): string[] {
  // #1342/ADR-0058: the app scaffold's vinext pin moved from
  // `templates/app/package.json.hbs` (now the DEFAULT/standalone target,
  // which pins no vinext) to `templates/app/package.json.vinext.hbs` (the
  // `--builder vinext` content override) — scan both suffixes so the pin is
  // still covered wherever it actually lives.
  const out = execFileSync(
    'git',
    ['ls-files', '--', '*package.json', '*package.json.hbs', '*package.json.vinext.hbs'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !EXEMPT_PREFIXES.some((p) => f.startsWith(p)));
}

/** The repo's "current" vinext version, sourced from the published core's own pin. */
function repoVinextVersion(): string {
  const pins = vinextPins(readFileSync(resolve(repoRoot, REPO_VINEXT_VERSION_SOURCE), 'utf8'));
  if (pins.length !== 1) {
    throw new Error(
      `expected exactly one "vinext" pin in ${REPO_VINEXT_VERSION_SOURCE}, found ${pins.length}`,
    );
  }
  return pins[0];
}

describe('vinext pin lockstep', () => {
  it('the deploy script carries exactly one version-resolution block (#1780)', () => {
    const script = readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8');
    expect(() => vinextVersionResolutionBlock(script)).not.toThrow();
  });

  it(
    'the deploy script resolves VINEXT_VERSION, AT RUNTIME, to the repo pin — no override, ' +
      'no drift possible (#1780 fold-back)',
    () => {
      expect(resolveHarnessVinextVersion()).toBe(repoVinextVersion());
    },
  );

  it('an explicit KNEXT_VINEXT_VERSION override still wins over the package.json default', () => {
    // The override exists precisely so a diagnostic run can test a DIFFERENT
    // vinext without editing the pin — proving the default does not clobber it.
    expect(resolveHarnessVinextVersion('9.9.9-override-probe')).toBe('9.9.9-override-probe');
  });

  it('the scanners see what they claim to (self-test)', () => {
    const ok = `${VERSION_BLOCK_BEGIN}\nVINEXT_VERSION=x\n${VERSION_BLOCK_END}\n`;
    expect(() => vinextVersionResolutionBlock(ok)).not.toThrow();
    expect(() => vinextVersionResolutionBlock('no markers here at all')).toThrow();
    expect(() => vinextVersionResolutionBlock(`${ok}${ok}`)).toThrow();
    expect(() =>
      vinextVersionResolutionBlock(`${VERSION_BLOCK_END}\n${VERSION_BLOCK_BEGIN}\n`),
    ).toThrow();
    expect(vinextPins('{ "dependencies": { "vinext": "9.9.9", "vite": "8" } }')).toEqual(['9.9.9']);
    expect(vinextPins('{ "dependencies": { "@vinext/types": "1" } }')).toEqual([]);
  });

  it('every tracked manifest that pins vinext pins the repo version exactly', () => {
    const repoVersion = repoVinextVersion();
    const pinned: string[] = [];
    const drift: string[] = [];
    for (const file of trackedManifests()) {
      const pins = vinextPins(readFileSync(resolve(repoRoot, file), 'utf8'));
      if (pins.length === 0) continue;
      pinned.push(file);
      if (pins.length !== 1 || pins[0] !== repoVersion)
        drift.push(`${file}: ${pins.join(', ')} (repo version: ${repoVersion})`);
    }
    // The scan must actually find the pins, or an empty result reads as green.
    expect(pinned).toContain('packages/kn-next/package.json');
    expect(pinned).toContain('packages/kn-next/templates/app/package.json.vinext.hbs');
    expect(pinned.length).toBeGreaterThanOrEqual(6);
    expect(drift, 'vinext pins out of lockstep with the repo version').toEqual([]);
  });

  it('every tracked bun.lock resolves vinext at the repo version (a stale lock installs the old one)', () => {
    const repoVersion = repoVinextVersion();
    const out = execFileSync('git', ['ls-files', '--', '*bun.lock'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const locks = out
      .split('\n')
      .filter(Boolean)
      .filter((f) => !EXEMPT_PREFIXES.some((p) => f.startsWith(p)));
    const resolving: string[] = [];
    const drift: string[] = [];
    for (const file of locks) {
      const text = readFileSync(resolve(repoRoot, file), 'utf8');
      // `"vinext": ["vinext@<v>", …` is the lock's resolution entry.
      const resolved = [...text.matchAll(/"vinext": \["vinext@([^"]+)"/g)].map((m) => m[1]);
      if (resolved.length === 0) continue;
      resolving.push(file);
      // Workspace dependency specs only: the lock's `bin` map also has a
      // `"vinext": "dist/cli.js"` entry, which is not a version.
      const specs = vinextPins(text).filter((v) => /^[~^]?\d/.test(v));
      const stale = [...resolved, ...specs].filter((v) => v !== repoVersion);
      if (stale.length > 0)
        drift.push(`${file}: ${stale.join(', ')} (repo version: ${repoVersion})`);
    }
    expect(resolving).toContain('bun.lock');
    expect(resolving).toContain('packages/kn-next/src/__tests__/fixtures/vinext-node-app/bun.lock');
    expect(drift, 'bun.lock files resolving a different vinext than the repo version').toEqual([]);
  });
});
