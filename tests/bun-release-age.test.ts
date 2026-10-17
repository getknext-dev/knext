import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD: bun refuses to resolve a registry version younger than the quarantine.
 *
 * `bunfig.toml` sets `[install] minimumReleaseAge`. A malicious or broken release
 * that the registry pulls within a couple of days never reaches this tree through
 * `bun add`, `bun update` or an unlocked `bun install`. `bun install
 * --frozen-lockfile` is unaffected: it resolves nothing new.
 *
 * What this pins, and why each piece is pinned:
 *   - the AGE is inside a band (3 to 7 days). Below the floor the quarantine stops
 *     covering the usual takedown latency; above the ceiling routine security
 *     fixes wait a week for nothing.
 *   - the EXCLUDE list is exactly the reviewed one, first-party names only. An
 *     exclude is the standing escape hatch from the quarantine for one package, so
 *     adding one is a reviewed change to THIS file, never a quiet edit to bunfig.
 *   - NOTHING in CI or a Dockerfile passes `--minimum-release-age 0` (or any value
 *     under the floor), which would disable the quarantine where it matters.
 *   - the pinned bun actually knows the setting: an unknown bunfig key is
 *     silently ignored, so the test asks the binary.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

const FLOOR_SECONDS = 3 * 86400;
const CEILING_SECONDS = 7 * 86400;

/**
 * The reviewed escape-hatch list: first-party packages only. To exclude anything
 * else, add it here WITH the reason in the map value, and say so in the PR.
 */
const REVIEWED_EXCLUDES: Record<string, string> = {
  '@getknext/core': 'first-party; published by this repository',
  '@getknext/lib': 'first-party; published by this repository',
  '@getknext/db': 'first-party; published by this repository',
};

function bunfig(): { install?: Record<string, unknown> } {
  return Bun.TOML.parse(readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf8')) as {
    install?: Record<string, unknown>;
  };
}

describe('bunfig.toml: install.minimumReleaseAge', () => {
  it('sets a quarantine inside the 3 to 7 day band', () => {
    const age = bunfig().install?.minimumReleaseAge;
    expect(typeof age, 'minimumReleaseAge must be a number of seconds').toBe('number');
    expect(age as number).toBeGreaterThanOrEqual(FLOOR_SECONDS);
    expect(age as number).toBeLessThanOrEqual(CEILING_SECONDS);
  });

  it('excludes exactly the reviewed first-party packages', () => {
    const excludes = bunfig().install?.minimumReleaseAgeExcludes;
    expect(Array.isArray(excludes), 'minimumReleaseAgeExcludes must be an array').toBe(true);
    expect([...(excludes as string[])].sort()).toEqual(Object.keys(REVIEWED_EXCLUDES).sort());
  });

  it('documents the one-off escape hatch next to the setting', () => {
    const text = readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf8');
    expect(text).toMatch(/--minimum-release-age 0/);
    expect(text).toMatch(/minimumReleaseAgeExcludes/);
  });
});

describe('the pinned bun knows the setting', () => {
  it('lists --minimum-release-age in `bun install --help`', () => {
    const out = spawnSync(process.execPath, ['install', '--help'], { encoding: 'utf8' });
    expect(`${out.stdout}${out.stderr}`).toMatch(/minimum-release-age/);
  });
});

describe('nothing disables the quarantine where packages are installed', () => {
  const roots = ['.github/workflows', '.github/actions'];
  function files(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...files(full));
      else if (/\.(ya?ml|sh|mjs)$/.test(entry.name) || entry.name.startsWith('Dockerfile'))
        out.push(full);
    }
    return out;
  }
  it('scans the workflows (non-vacuity)', () => {
    expect(files(resolve(REPO_ROOT, '.github/workflows')).length).toBeGreaterThan(40);
  });
  it('no workflow, action or Dockerfile passes a sub-floor --minimum-release-age', () => {
    const offenders: string[] = [];
    const dockerfiles = ['apps/file-manager/Dockerfile', 'apps/docs/Dockerfile'].map((p) =>
      resolve(REPO_ROOT, p),
    );
    for (const file of [
      ...roots.flatMap((r) => {
        try {
          return files(resolve(REPO_ROOT, r));
        } catch {
          return [];
        }
      }),
      ...dockerfiles,
    ]) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      for (const m of code.matchAll(/--minimum-release-age[ =]+['"]?(\d+)/g)) {
        if (Number(m[1]) < FLOOR_SECONDS) offenders.push(`${file}: --minimum-release-age ${m[1]}`);
      }
      if (/BUN_INSTALL_MINIMUM_RELEASE_AGE\s*[:=]\s*['"]?0/.test(code)) {
        offenders.push(`${file}: BUN_INSTALL_MINIMUM_RELEASE_AGE=0`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
