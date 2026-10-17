import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  ageFailed,
  changedEntries,
  evaluateAges,
  loadExceptions,
  parseLockfile,
  publishTime,
  readBunfig,
  registryUrl,
  renderAgeReport,
} from '../scripts/lib/release-age.mjs';

/**
 * GUARD: a change cannot land a lockfile entry younger than the quarantine.
 *
 * `bunfig.toml` keeps bun from RESOLVING a fresh release. That protects the machine
 * running `bun add` and nothing else: a Dependabot branch, a hand-edited lockfile,
 * a Cargo or Go bump, or an install with `--minimum-release-age 0` reach the tree
 * unchecked. This gate checks the RESULT, per added or altered lockfile entry, from
 * the registry's own publish time, and fails closed when the registry cannot answer.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-17T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 3 * 86400;
const NO_EXC = { active: [], expired: [] };
const TODAY = '2026-10-17';

const entry = (over: Record<string, unknown> = {}): any => ({
  lockfile: 'bun.lock',
  ecosystem: 'npm',
  name: 'left-pad',
  version: '1.3.0',
  ...over,
});

const run = (
  entries: any[],
  lookup: (e: any) => Promise<number>,
  over: Record<string, unknown> = {},
) =>
  evaluateAges({
    entries,
    lookup,
    now: NOW,
    minSeconds: MIN,
    excludes: [],
    exceptions: NO_EXC,
    ...over,
  });

describe('readBunfig: the same number the install-time quarantine uses', () => {
  it('reads the repo bunfig', () => {
    const { seconds, excludes } = readBunfig(
      readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf8'),
    );
    expect(seconds).toBeGreaterThanOrEqual(3 * 86400);
    expect(excludes).toContain('@getknext/core');
  });
  it('throws when no quarantine is set (never a silent zero)', () => {
    expect(() => readBunfig('[install]\n')).toThrow(/minimumReleaseAge/);
  });
});

describe('parseLockfile', () => {
  it('bun.lock: registry versions only, aliases resolved, workspace/file/git skipped', () => {
    const text = `{
      "packages": {
        "a": ["a@1.0.0", "", {}, "sha"],
        "scoped": ["@s/pkg@2.1.3-rc.1", "", {}, "sha"],
        "alias": ["old@npm:real@3.0.0", "", {}, "sha"],
        "ws": ["pkg@workspace:packages/pkg"],
        "file": ["f@file:../f"],
        "gh": ["g@github:o/r#abc"],
      }
    }`;
    expect(parseLockfile('bun.lock', text, (t: string) => Bun.JSONC.parse(t) as any)).toEqual([
      { ecosystem: 'npm', name: 'a', version: '1.0.0' },
      { ecosystem: 'npm', name: '@s/pkg', version: '2.1.3-rc.1' },
      { ecosystem: 'npm', name: 'real', version: '3.0.0' },
    ]);
  });
  it('package-lock.json: registry-resolved packages, nested names, links skipped', () => {
    const text = JSON.stringify({
      packages: {
        '': { name: 'root' },
        'node_modules/a': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
        },
        'node_modules/a/node_modules/@s/b': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/@s/b/-/b-2.0.0.tgz',
        },
        'node_modules/l': { link: true },
        'node_modules/g': { version: '1.0.0', resolved: 'git+ssh://x/y.git' },
      },
    });
    expect(parseLockfile('x/package-lock.json', text)).toEqual([
      { ecosystem: 'npm', name: 'a', version: '1.0.0' },
      { ecosystem: 'npm', name: '@s/b', version: '2.0.0' },
    ]);
  });
  it('Cargo.lock: crates.io only', () => {
    const text = `[[package]]
name = "serde"
version = "1.0.200"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "local"
version = "0.1.0"

[[package]]
name = "gitdep"
version = "0.2.0"
source = "git+https://github.com/o/r#abc"
`;
    expect(parseLockfile('Cargo.lock', text)).toEqual([
      { ecosystem: 'crates', name: 'serde', version: '1.0.200' },
    ]);
  });
  it('go.mod: required modules, blocks and single lines, replace/exclude ignored', () => {
    const text = `module m

go 1.25

require github.com/a/b v1.2.3
require (
	github.com/c/d v0.4.0 // indirect
	golang.org/x/net v0.58.0
)
replace github.com/c/d => ../d
exclude (
	github.com/e/f v1.0.0
)
`;
    expect(parseLockfile('go.mod', text)).toEqual([
      { ecosystem: 'go', name: 'github.com/a/b', version: 'v1.2.3' },
      { ecosystem: 'go', name: 'github.com/c/d', version: 'v0.4.0' },
      { ecosystem: 'go', name: 'golang.org/x/net', version: 'v0.58.0' },
    ]);
  });
  it('throws on a lockfile it has no parser for', () => {
    expect(() => parseLockfile('yarn.lock', '')).toThrow();
  });
});

describe('changedEntries', () => {
  it('returns what head adds or alters, per lockfile, never removals', () => {
    const base = [entry(), entry({ name: 'gone' })];
    const head = [entry(), entry({ name: 'new' }), entry({ version: '1.4.0' })];
    expect(changedEntries(head, base).map((e) => `${e.name}@${e.version}`)).toEqual([
      'new@1.3.0',
      'left-pad@1.4.0',
    ]);
  });
  it('the same package in a DIFFERENT lockfile is a change', () => {
    expect(changedEntries([entry({ lockfile: 'a/bun.lock' })], [entry()])).toHaveLength(1);
  });
});

describe('registry lookups', () => {
  it('builds the right URL for each ecosystem', () => {
    expect(registryUrl({ ecosystem: 'npm', name: 'left-pad', version: '1' } as any)).toBe(
      'https://registry.npmjs.org/left-pad',
    );
    expect(registryUrl({ ecosystem: 'npm', name: '@s/pkg', version: '1' } as any)).toBe(
      'https://registry.npmjs.org/@s%2Fpkg',
    );
    expect(registryUrl({ ecosystem: 'crates', name: 'serde', version: '1.0.1' } as any)).toBe(
      'https://crates.io/api/v1/crates/serde/1.0.1',
    );
    expect(
      registryUrl({ ecosystem: 'go', name: 'github.com/Azure/x', version: 'v1.0.0' } as any),
    ).toBe('https://proxy.golang.org/github.com/!azure/x/@v/v1.0.0.info');
  });
  it('reads the publish time from each registry shape, and THROWS when it is absent', () => {
    expect(
      publishTime({ ecosystem: 'npm', name: 'a', version: '1.0.0' } as any, {
        time: { '1.0.0': '2026-10-01T00:00:00Z' },
      }),
    ).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(
      publishTime({ ecosystem: 'crates', name: 'a', version: '1' } as any, {
        version: { created_at: '2026-10-01T00:00:00Z' },
      }),
    ).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(
      publishTime({ ecosystem: 'go', name: 'a', version: 'v1' } as any, {
        Time: '2026-10-01T00:00:00Z',
      }),
    ).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(() =>
      publishTime({ ecosystem: 'npm', name: 'a', version: '9.9.9' } as any, { time: {} }),
    ).toThrow(/no publish time/);
    expect(() =>
      publishTime({ ecosystem: 'go', name: 'a', version: 'v1' } as any, { Time: 'garbage' }),
    ).toThrow();
    expect(() =>
      publishTime({ ecosystem: 'npm', name: 'a', version: '1.0.0' } as any, null),
    ).toThrow();
  });
});

describe('evaluateAges', () => {
  it('passes an entry at least as old as the quarantine, including exactly at the boundary', async () => {
    const r = await run([entry()], async () => NOW - 3 * DAY);
    expect(r.tooNew).toEqual([]);
    expect(ageFailed(r)).toBe(false);
  });
  it('fails an entry one second short of the quarantine', async () => {
    const r = await run([entry()], async () => NOW - 3 * DAY + 1000);
    expect(r.tooNew).toHaveLength(1);
    expect(ageFailed(r)).toBe(true);
  });
  it('fails a release published an hour ago and reports its age', async () => {
    const r = await run([entry()], async () => NOW - HOUR);
    expect(r.tooNew[0].ageHours).toBe(1);
    expect(renderAgeReport(r, MIN)).toMatch(/less than 3 days ago/);
  });
  it('FAILS CLOSED when the registry cannot answer', async () => {
    const r = await run([entry()], async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(r.errors).toHaveLength(1);
    expect(ageFailed(r)).toBe(true);
    expect(renderAgeReport(r, MIN)).toMatch(/could not be checked/);
  });
  it('fails closed on a lookup that returns a non-time', async () => {
    const r = await run([entry()], async () => Number.NaN);
    expect(r.errors).toHaveLength(1);
  });
  it('does not check first-party packages named in bunfig excludes', async () => {
    let calls = 0;
    const r = await run(
      [entry({ name: '@getknext/core' })],
      async () => {
        calls += 1;
        return NOW;
      },
      { excludes: ['@getknext/core'] },
    );
    expect(calls).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(ageFailed(r)).toBe(false);
  });
  it('checks everything else, and counts it', async () => {
    const r = await run(
      [entry(), entry({ name: 'b' }), entry({ name: 'c' })],
      async () => NOW - 10 * DAY,
    );
    expect(r.checked).toBe(3);
  });
  it('an exception allows exactly one ecosystem, package and version', async () => {
    const exc = loadExceptions(
      {
        allow: [
          {
            ecosystem: 'npm',
            package: 'left-pad',
            version: '1.3.0',
            justification: 'security fix for CVE needed today, reviewed the diff',
            added: '2026-10-16',
            expires: '2026-10-20',
          },
        ],
      },
      TODAY,
    );
    const fresh = async () => NOW - HOUR;
    expect((await run([entry()], fresh, { exceptions: exc })).tooNew).toEqual([]);
    expect(
      (await run([entry({ version: '1.3.1' })], fresh, { exceptions: exc })).tooNew,
    ).toHaveLength(1);
    expect((await run([entry({ name: 'other' })], fresh, { exceptions: exc })).tooNew).toHaveLength(
      1,
    );
    expect(
      (await run([entry({ ecosystem: 'crates' })], fresh, { exceptions: exc })).tooNew,
    ).toHaveLength(1);
  });
  it('an expired exception stops allowing', async () => {
    const exc = loadExceptions(
      {
        allow: [
          {
            ecosystem: 'npm',
            package: 'left-pad',
            version: '1.3.0',
            justification: 'security fix for CVE needed today, reviewed the diff',
            added: '2026-10-01',
            expires: '2026-10-05',
          },
        ],
      },
      TODAY,
    );
    expect((await run([entry()], async () => NOW - HOUR, { exceptions: exc })).tooNew).toHaveLength(
      1,
    );
  });
});

describe('loadExceptions', () => {
  const ok = {
    ecosystem: 'npm',
    package: 'left-pad',
    version: '1.3.0',
    justification: 'security fix for CVE needed today, reviewed the diff',
    added: '2026-10-16',
    expires: '2026-10-20',
  };
  const bad = (over: Record<string, unknown>) => () =>
    loadExceptions({ allow: [{ ...ok, ...over }] }, TODAY);
  it('accepts a scoped entry and an empty list', () => {
    expect(bad({})).not.toThrow();
    expect(() => loadExceptions({ allow: [] }, TODAY)).not.toThrow();
  });
  it('rejects wildcards, ranges, a missing expiry, a long expiry, and unknown keys', () => {
    expect(bad({ package: '*' })).toThrow(/package/);
    expect(bad({ version: '^1.0.0' })).toThrow(/version/);
    expect(bad({ ecosystem: 'pypi' })).toThrow(/ecosystem/);
    expect(bad({ expires: undefined })).toThrow(/expires/);
    expect(bad({ added: '2026-10-01', expires: '2026-10-30' })).toThrow(/14/);
    expect(bad({ justification: 'ok' })).toThrow(/justification/);
    expect(bad({ extra: 1 })).toThrow(/unknown/);
  });
  it('the committed file parses', () => {
    const json = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'security/release-age-exceptions.json'), 'utf8'),
    );
    expect(() => loadExceptions(json, TODAY)).not.toThrow();
  });
});

describe('.github/workflows/release-age.yml', () => {
  const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/release-age.yml'), 'utf8');
  const code = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const doc = parse(text) as { on: Record<string, unknown>; permissions: unknown };
  it('runs on every pull request and on pushes to the long-lived lines', () => {
    expect(Object.keys(doc.on)).toContain('pull_request');
    expect(Object.keys(doc.on)).toContain('push');
  });
  it('is read-only', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
  });
  it('runs the gate from a full-depth checkout and cannot be softened', () => {
    expect(code).toContain('node scripts/release-age-gate.mjs');
    expect(code).toMatch(/fetch-depth:\s*0/);
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toMatch(/\|\|\s*true/);
  });
});
