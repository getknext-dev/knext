/**
 * Every tracked vinext pin moves in lockstep with the compat lane's
 * `VINEXT_VERSION` (`scripts/e2e-deploy-vinext.sh`).
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
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = 'scripts/e2e-deploy-vinext.sh';
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
  const out = execFileSync('git', ['ls-files', '--', '*package.json', '*package.json.hbs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !EXEMPT_PREFIXES.some((p) => f.startsWith(p)));
}

describe('vinext pin lockstep', () => {
  it('parses the lane version from the deploy script exactly once', () => {
    const v = laneVinextVersion(readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8'));
    expect(v, `no single VINEXT_VERSION default in ${DEPLOY_SCRIPT}`).toBeDefined();
    expect(v).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it('the scanners see what they claim to (self-test)', () => {
    const line = `VINEXT_VERSION="\${KNEXT_VINEXT_VERSION:-1.2.3}"\n`;
    expect(laneVinextVersion(line)).toBe('1.2.3');
    expect(laneVinextVersion(`# ${line}`)).toBeUndefined();
    expect(laneVinextVersion(`${line}${line}`)).toBeUndefined();
    expect(vinextPins('{ "dependencies": { "vinext": "9.9.9", "vite": "8" } }')).toEqual(['9.9.9']);
    expect(vinextPins('{ "dependencies": { "@vinext/types": "1" } }')).toEqual([]);
  });

  it('every tracked manifest that pins vinext pins the lane version exactly', () => {
    const lane = laneVinextVersion(readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8'));
    const pinned: string[] = [];
    const drift: string[] = [];
    for (const file of trackedManifests()) {
      const pins = vinextPins(readFileSync(resolve(repoRoot, file), 'utf8'));
      if (pins.length === 0) continue;
      pinned.push(file);
      if (pins.length !== 1 || pins[0] !== lane)
        drift.push(`${file}: ${pins.join(', ')} (lane: ${lane})`);
    }
    // The scan must actually find the pins, or an empty result reads as green.
    expect(pinned).toContain('packages/kn-next/package.json');
    expect(pinned).toContain('packages/kn-next/templates/app/package.json.hbs');
    expect(pinned.length).toBeGreaterThanOrEqual(6);
    expect(drift, 'vinext pins out of lockstep with the compat lane').toEqual([]);
  });

  it('every tracked bun.lock resolves vinext at the lane version (a stale lock installs the old one)', () => {
    const lane = laneVinextVersion(readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8'));
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
      const stale = [...resolved, ...specs].filter((v) => v !== lane);
      if (stale.length > 0) drift.push(`${file}: ${stale.join(', ')} (lane: ${lane})`);
    }
    expect(resolving).toContain('bun.lock');
    expect(resolving).toContain('packages/kn-next/src/__tests__/fixtures/vinext-node-app/bun.lock');
    expect(drift, 'bun.lock files resolving a different vinext than the lane').toEqual([]);
  });
});
