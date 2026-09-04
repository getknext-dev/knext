/**
 * A `bun install` must not run under a bun that cannot read its lockfile (#882).
 *
 * ## The failure
 *
 * The root `bun.lock` is `lockfileVersion: 3`. bun 1.3.x cannot parse it — not
 * "finds changes", cannot parse:
 *
 *   bun install v1.3.14
 *   2 |   "lockfileVersion": 3,
 *                           ^
 *   error: Unknown lockfile version at bun.lock:2:22
 *   warn: Ignoring lockfile
 *   error: lockfile had changes, but lockfile is frozen
 *
 * That is a real log from the Vercel docs deployment, not a construction.
 *
 * ## What made it invisible
 *
 * Two jobs — `compat-smoke` and `compile-cache-bun-probe` — set bun up TWICE:
 * 1.4.0, and then 1.3.14 in a step underneath it. The second silently took the
 * first away, so every install in those jobs ran on a bun that could not read
 * the lockfile, while the workflow still contained a correct-looking `1.4.0`.
 *
 * Nothing caught it because `main`'s lockfile is version 1, which 1.3.14 reads
 * fine, and `ci.yml` had never run against the branch — there was no PR. The
 * first run of these jobs against a v3 lockfile would have been on `main`.
 *
 * ## What shipped
 *
 * The platform now runs bun 1.4 everywhere: every `setup-bun` pin is 1.4.0, all
 * three container images are already `oven/bun:1.4.0-alpine`, and the redundant
 * second setup steps are gone. The `<=1.3` branch of the #309 compile-cache
 * diagnostic still exists in the code but is no longer exercised by a CI lane —
 * a deliberate trade, recorded here rather than left to be discovered.
 *
 * ## Why the check keys on the lockfile, not the job
 *
 * A first pass counted five affected jobs by matching pins to jobs. The real
 * number was two: three of the five install with
 * `working-directory: examples/bun-exec`, which has its OWN `bun.lock` at
 * version 1 and reads fine on 1.3.x. What matters is WHICH lockfile the install
 * reads, so that is what this keys on.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The lowest bun that can read a given lockfile version. */
const MIN_BUN_FOR_LOCKFILE: Record<number, [number, number]> = { 3: [1, 4] };

/**
 * `null` when the lockfile is not committed. Some installs target a directory
 * materialised during the build — `docs-site` installs into `./.docs-closure`,
 * which `turbo prune` generates — so the lockfile there is written by the same
 * bun that then reads it and cannot be version-mismatched. Those are reported
 * separately rather than skipped quietly, so a typo in a path cannot exempt a
 * real install by looking like a generated one.
 */
function lockfileVersion(rel: string): number | null {
  let text: string;
  try {
    text = readFileSync(resolve(repoRoot, rel), 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/"lockfileVersion":\s*(\d+)/);
  expect(m, `${rel} has no lockfileVersion`).not.toBeNull();
  return Number(m?.[1]);
}

function parseVersion(raw: string): [number, number] | null {
  const m = raw.match(/(\d+)\.(\d+)\.\d+/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}

function jobs(): Record<string, { steps?: Step[] }> {
  // biome-ignore lint/suspicious/noExplicitAny: the workflow schema is not modelled here
  const doc = (Bun as any).YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8'),
  );
  return doc.jobs;
}

/**
 * For every `bun install` step, the bun version in effect at that point —
 * i.e. the LAST `setup-bun` before it, since a later setup replaces an earlier
 * one. That "last one wins" is exactly what made the original bug invisible:
 * both jobs already set up 1.4.0, and a second setup step underneath silently
 * took it away again.
 */
function installsWithEffectiveBun(): {
  job: string;
  dir: string;
  bun: string;
}[] {
  const out: { job: string; dir: string; bun: string }[] = [];
  for (const [job, def] of Object.entries(jobs())) {
    let effective: string | null = null;
    for (const step of def.steps ?? []) {
      if (typeof step.uses === 'string' && step.uses.includes('setup-bun')) {
        const v = step.with?.['bun-version'];
        if (v != null) effective = String(v);
      }
      if (typeof step.run === 'string' && /\bbun install\b/.test(step.run)) {
        out.push({
          job,
          dir: step['working-directory'] ?? '.',
          bun: effective ?? '(none — setup-bun default)',
        });
      }
    }
  }
  return out;
}

describe('bun install runs under a bun that can read the lockfile (#882)', () => {
  it('finds bun install steps at all — the guard must not pass vacuously', () => {
    expect(installsWithEffectiveBun().length).toBeGreaterThan(5);
  });

  it('the root lockfile still needs a bun this guard knows about', () => {
    // If the lockfile is regenerated at a version with no recorded floor, the
    // check below would quietly accept anything. Fail here instead.
    const v = lockfileVersion('bun.lock');
    expect(v, 'the root bun.lock is committed and must be readable').not.toBeNull();
    expect(
      MIN_BUN_FOR_LOCKFILE[v as number],
      `bun.lock is lockfileVersion ${v} and this guard records no minimum bun for it — ` +
        'add one rather than leaving the check to pass on an unknown format',
    ).toBeDefined();
  });

  it('no install runs under a bun too old for the lockfile it reads', () => {
    // Keyed on the lockfile the step actually reads: a `working-directory`
    // install reads THAT directory's lockfile, and examples/bun-exec's is
    // version 1, which 1.3.x handles.
    const offenders = installsWithEffectiveBun()
      .map((s) => {
        const lock = s.dir === '.' ? 'bun.lock' : `${s.dir}/bun.lock`;
        const version = lockfileVersion(lock);
        if (version === null) return null; // generated at build time; see above
        const floor = MIN_BUN_FOR_LOCKFILE[version];
        if (!floor) return null;
        const got = parseVersion(s.bun);
        // An unparseable version is a dispatch-input fallback; the pin guard
        // owns that shape, so it is not re-judged here.
        if (!got) return null;
        const tooOld = got[0] < floor[0] || (got[0] === floor[0] && got[1] < floor[1]);
        return tooOld ? `${s.job}: installs ${lock} under bun ${s.bun}` : null;
      })
      .filter((x): x is string => x !== null)
      .sort();

    expect(
      offenders,
      'bun 1.3.x cannot PARSE a lockfileVersion 3 lockfile, so the install fails outright. ' +
        'These jobs keep their 1.3 lane deliberately — move the install ABOVE the 1.3 ' +
        'setup-bun step rather than bumping the pin and deleting the lane.',
    ).toEqual([]);
  });

  it('the installs exempted for having no committed lockfile are the expected ones', () => {
    // Without this, a mistyped `working-directory` would point at a path with no
    // lockfile and be exempted for looking generated. Enumerated ON PURPOSE: the
    // set is meant to be small, and growing it should require saying so.
    const generated = installsWithEffectiveBun()
      .filter((s) => lockfileVersion(s.dir === '.' ? 'bun.lock' : `${s.dir}/bun.lock`) === null)
      .map((s) => `${s.job}: ${s.dir}`)
      .sort();
    expect(
      generated,
      'an install targets a directory with no committed lockfile. If that directory is ' +
        'materialised during the build (turbo prune), add it here; if it is a typo, fix ' +
        'the path — otherwise the check above exempts it silently.',
    ).toEqual(['docs-site: ./.docs-closure']);
  });
});
