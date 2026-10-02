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
 * `scripts/e2e-deploy-vinext.sh` is a THIRD, TEMPORARY exception (added
 * 2026-10-02, #1812): it sits inside `frozenFileSet()`
 * (`scripts/compat-credential-freeze-guard.mjs`) while the v1.0.0-rc.5
 * credential window is open (`.github/compat-credential-ref.json`), so it
 * cannot be bumped off `1.0.0-beta.12` without an `rcBumpMarker` on the pin —
 * out of scope for a template-pin bump. Until the window closes, the deploy
 * script's lane version and the repo's "current" vinext version are allowed
 * to diverge; this file used to derive the "current" version FROM the deploy
 * script, which would have forced either leaving every other site on the
 * beta too, or reproposing the harness bump as a separate, markered PR. The
 * dedicated test below pins the deploy script's own value and goes RED the
 * instant it moves — which is exactly the signal to delete this paragraph and
 * fold `DEPLOY_SCRIPT` back into the single lane source.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = 'scripts/e2e-deploy-vinext.sh';
// #1812: the frozen value scripts/e2e-deploy-vinext.sh must keep reporting
// while the v1.0.0-rc.5 credential window owns it. The moment this drifts
// (the harness is bumped under a marker, or the window closes and someone
// bumps it for real), `it('the frozen deploy script ...')` below reds —
// that is the prompt to delete FROZEN_DEPLOY_SCRIPT_VERSION and this comment.
const FROZEN_DEPLOY_SCRIPT_VERSION = '1.0.0-beta.12';
// The site every OTHER tracked pin is measured against. Not the deploy
// script while it is frozen (see header comment).
const REPO_VINEXT_VERSION_SOURCE = 'packages/kn-next/package.json';
const EXEMPT_PREFIXES = ['examples/bun-exec/', 'docs/wayfinder/'];

/** The compat lane's default vinext version: `VINEXT_VERSION="${KNEXT_VINEXT_VERSION:-<v>}"`. */
export function laneVinextVersion(script: string): string | undefined {
  const hits = [...script.matchAll(/^VINEXT_VERSION="\$\{KNEXT_VINEXT_VERSION:-([^}]+)\}"/gm)];
  return hits.length === 1 ? hits[0][1] : undefined;
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
  it('parses the lane version from the deploy script exactly once', () => {
    const v = laneVinextVersion(readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8'));
    expect(v, `no single VINEXT_VERSION default in ${DEPLOY_SCRIPT}`).toBeDefined();
    expect(v).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it(
    '#1812: the frozen deploy script still pins the credential-window value — ' +
      'delete FROZEN_DEPLOY_SCRIPT_VERSION and the header exception the moment this reds',
    () => {
      const v = laneVinextVersion(readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8'));
      expect(
        v,
        `${DEPLOY_SCRIPT} no longer pins ${FROZEN_DEPLOY_SCRIPT_VERSION} — the frozen-harness ` +
          'exception in this file is stale; fold DEPLOY_SCRIPT back into repoVinextVersion()',
      ).toBe(FROZEN_DEPLOY_SCRIPT_VERSION);
    },
  );

  it('the scanners see what they claim to (self-test)', () => {
    const line = `VINEXT_VERSION="\${KNEXT_VINEXT_VERSION:-1.2.3}"\n`;
    expect(laneVinextVersion(line)).toBe('1.2.3');
    expect(laneVinextVersion(`# ${line}`)).toBeUndefined();
    expect(laneVinextVersion(`${line}${line}`)).toBeUndefined();
    expect(vinextPins('{ "dependencies": { "vinext": "9.9.9", "vite": "8" } }')).toEqual(['9.9.9']);
    expect(vinextPins('{ "dependencies": { "@vinext/types": "1" } }')).toEqual([]);
  });

  it('every tracked manifest that pins vinext pins the repo version exactly', () => {
    const repoVersion = repoVinextVersion();
    const pinned: string[] = [];
    const drift: string[] = [];
    for (const file of trackedManifests()) {
      // The frozen deploy script's own lane pin is covered by the dedicated
      // #1812 test above, not by this repo-wide lockstep check (header
      // comment explains why they're allowed to diverge for now).
      if (file === DEPLOY_SCRIPT) continue;
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
