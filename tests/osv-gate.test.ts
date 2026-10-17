import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  evaluate,
  HIGH_SEVERITY,
  isMalicious,
  LOCKFILE_NAMES,
  loadAllowlist,
  parseOsv,
  pickBase,
  selectLockfiles,
} from '../scripts/lib/osv-gate.mjs';

/**
 * GUARD: a malicious dependency, or a NEW high-severity vulnerability, cannot
 * enter through bun.lock, Cargo.lock or go.mod without a red check.
 *
 * OSV-Scanner reads the lockfiles and asks the OSV database. OSV carries the
 * OpenSSF malicious-packages feed (ids `MAL-…`) next to the usual GHSA/CVE/GO
 * advisories, so one scan answers "is this package malware" and "is this version
 * vulnerable".
 *
 * POLICY, and why it is not "fail on everything":
 *   - A `MAL-` advisory on ANY locked package fails, always, whatever the base was.
 *   - A vulnerability fails only when it is HIGH or CRITICAL (CVSS >= 7.0) AND is
 *     NEW relative to the PR's merge base. The tree already carries advisories
 *     (measured: ~10 HIGH in bun.lock when this gate landed, all in tooling
 *     transitives), so failing on the full tree would red every unrelated PR and
 *     train people to ignore the check. Pre-existing ones are reported, and the
 *     nightly re-scan owns them.
 *   - Unknown severity is reported, not failed.
 *   - The only suppression is `security/osv-allowlist.json`: dated, justified,
 *     optionally expiring, mirroring `npm-audit-allowlist.json`.
 *   - Fail-closed: an unreadable allowlist, an unparseable scan, or a scanner that
 *     could not reach OSV is a failure, never a pass.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

type Pkg = {
  package: { name: string; version: string; ecosystem: string };
  vulnerabilities: Array<{ id: string; aliases?: string[] }>;
  groups: Array<{ ids: string[]; aliases?: string[]; max_severity: string }>;
};
const scan = (results: Array<{ path: string; packages: Pkg[] }>) =>
  JSON.stringify({
    results: results.map((r) => ({
      source: { path: `/work/${r.path}`, type: 'lockfile' },
      packages: r.packages,
    })),
  });
const pkg = (
  name: string,
  version: string,
  vulns: Array<{ id: string; severity?: string; aliases?: string[] }>,
  ecosystem = 'npm',
): Pkg => ({
  package: { name, version, ecosystem },
  vulnerabilities: vulns.map((v) => ({ id: v.id, aliases: v.aliases ?? [] })),
  groups: vulns
    .filter((v) => v.severity !== undefined)
    .map((v) => ({ ids: [v.id], aliases: v.aliases ?? [], max_severity: v.severity as string })),
});

const TODAY = '2026-10-17';
const NO_ALLOW = loadAllowlist({ allow: [] }, TODAY);

/** A fully scoped allowlist entry; override one field to break it. */
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'MAL-2026-1234',
  package: 'evil-pkg',
  version: '1.0.0',
  lockfile: 'bun.lock',
  justification: 'false positive: confirmed with the maintainer',
  added: '2026-10-01',
  expires: '2026-12-01',
  ...over,
});

describe('parseOsv', () => {
  it('reads packages, advisories and the group severity, with repo-relative paths', () => {
    const findings = parseOsv(
      scan([
        {
          path: 'bun.lock',
          packages: [pkg('braces', '3.0.3', [{ id: 'GHSA-vfj7-8cjw-p6xm', severity: '8.7' }])],
        },
      ]),
      '/work',
    );
    expect(findings).toEqual([
      {
        lockfile: 'bun.lock',
        ecosystem: 'npm',
        name: 'braces',
        version: '3.0.3',
        id: 'GHSA-vfj7-8cjw-p6xm',
        aliases: [],
        severity: 8.7,
        malicious: false,
      },
    ]);
  });
  it('an advisory with no group severity has severity null', () => {
    const [f] = parseOsv(
      scan([
        {
          path: 'a/go.mod',
          packages: [pkg('golang.org/x/net', '0.58.0', [{ id: 'GO-2026-6603' }], 'Go')],
        },
      ]),
      '/work',
    );
    expect(f.severity).toBeNull();
  });
  it('an empty severity string is null, not 0', () => {
    const [f] = parseOsv(
      scan([{ path: 'go.mod', packages: [pkg('x', '1', [{ id: 'GO-1', severity: '' }], 'Go')] }]),
      '/work',
    );
    expect(f.severity).toBeNull();
  });
  it('fails closed on a document that is not an OSV scan', () => {
    expect(() => parseOsv('not json', '/work')).toThrow();
    expect(() => parseOsv('{}', '/work')).toThrow();
    expect(() => parseOsv('{"results": 3}', '/work')).toThrow();
  });
  it('an empty results array is a clean scan', () => {
    expect(parseOsv('{"results": []}', '/work')).toEqual([]);
  });
});

describe('isMalicious', () => {
  it('is true for a MAL- id or a MAL- alias, false otherwise', () => {
    expect(isMalicious({ id: 'MAL-2026-1234', aliases: [] })).toBe(true);
    expect(isMalicious({ id: 'GHSA-aaaa-bbbb-cccc', aliases: ['MAL-2026-1234'] })).toBe(true);
    expect(isMalicious({ id: 'GHSA-aaaa-bbbb-cccc', aliases: ['CVE-2026-1'] })).toBe(false);
    expect(isMalicious({ id: 'MALICIOUS-lookalike', aliases: [] })).toBe(false);
  });
});

describe('evaluate', () => {
  const mal = parseOsv(
    scan([{ path: 'bun.lock', packages: [pkg('evil-pkg', '1.0.0', [{ id: 'MAL-2026-1234' }])] }]),
    '/work',
  );
  const high = parseOsv(
    scan([
      { path: 'bun.lock', packages: [pkg('braces', '3.0.3', [{ id: 'GHSA-1', severity: '8.7' }])] },
    ]),
    '/work',
  );
  const medium = parseOsv(
    scan([
      { path: 'bun.lock', packages: [pkg('ws', '8.19.0', [{ id: 'GHSA-2', severity: '4.4' }])] },
    ]),
    '/work',
  );
  const unknown = parseOsv(
    scan([{ path: 'go.mod', packages: [pkg('x/net', '1', [{ id: 'GO-3' }], 'Go')] }]),
    '/work',
  );

  it('the HIGH threshold is CVSS 7.0', () => {
    expect(HIGH_SEVERITY).toBe(7);
  });

  it('a malicious package fails even when the base already had it', () => {
    const r = evaluate({ head: mal, base: mal, allowlist: NO_ALLOW, today: TODAY });
    expect(r.failures.map((f: { id: string }) => f.id)).toEqual(['MAL-2026-1234']);
  });

  it('a malicious package fails with no base at all (a push to a branch)', () => {
    expect(
      evaluate({ head: mal, base: null, allowlist: NO_ALLOW, today: TODAY }).failures,
    ).toHaveLength(1);
  });

  it('a NEW high vulnerability fails', () => {
    const r = evaluate({ head: high, base: [], allowlist: NO_ALLOW, today: TODAY });
    expect(r.failures.map((f: { id: string }) => f.id)).toEqual(['GHSA-1']);
  });

  it('a PRE-EXISTING high vulnerability is reported but does not fail', () => {
    const r = evaluate({ head: high, base: high, allowlist: NO_ALLOW, today: TODAY });
    expect(r.failures).toEqual([]);
    expect(r.preexisting.map((f: { id: string }) => f.id)).toEqual(['GHSA-1']);
  });

  it('the same advisory on a bumped version is still pre-existing only if the version is unchanged', () => {
    const bumped = parseOsv(
      scan([
        {
          path: 'bun.lock',
          packages: [pkg('braces', '3.0.4', [{ id: 'GHSA-1', severity: '8.7' }])],
        },
      ]),
      '/work',
    );
    // A bump to another still-vulnerable version introduces that version: it fails.
    expect(
      evaluate({ head: bumped, base: high, allowlist: NO_ALLOW, today: TODAY }).failures,
    ).toHaveLength(1);
  });

  it('a medium vulnerability never fails', () => {
    expect(
      evaluate({ head: medium, base: [], allowlist: NO_ALLOW, today: TODAY }).failures,
    ).toEqual([]);
  });

  it('a NEW vulnerability with no severity score FAILS (it cannot be shown to be below HIGH)', () => {
    const r = evaluate({ head: unknown, base: [], allowlist: NO_ALLOW, today: TODAY });
    expect(r.failures.map((f: { id: string }) => f.id)).toEqual(['GO-3']);
  });

  it('a PRE-EXISTING unscored vulnerability is reported, not failed', () => {
    const r = evaluate({ head: unknown, base: unknown, allowlist: NO_ALLOW, today: TODAY });
    expect(r.failures).toEqual([]);
    expect(r.unknownSeverity).toHaveLength(1);
  });

  it('with no base, an unscored vulnerability is reported, and fails only in full mode', () => {
    const r = evaluate({ head: unknown, base: null, allowlist: NO_ALLOW, today: TODAY });
    expect(r.failures).toEqual([]);
    expect(r.unknownSeverity).toHaveLength(1);
    expect(
      evaluate({ head: unknown, base: null, allowlist: NO_ALLOW, today: TODAY, full: true })
        .failures,
    ).toHaveLength(1);
  });

  it('a new unscored vulnerability can be suppressed by a scoped entry', () => {
    const allow = loadAllowlist(
      {
        allow: [entry({ id: 'GO-3', package: 'x/net', version: '1', lockfile: 'go.mod' })],
      },
      TODAY,
    );
    const r = evaluate({ head: unknown, base: [], allowlist: allow, today: TODAY });
    expect(r.failures).toEqual([]);
    expect(r.suppressed).toHaveLength(1);
  });

  it('a HIGH already in ANOTHER lockfile at the base is NEW when it moves into this one', () => {
    const inFixture = parseOsv(
      scan([
        {
          path: 'fixtures/app/bun.lock',
          packages: [pkg('braces', '3.0.3', [{ id: 'GHSA-1', severity: '8.7' }])],
        },
      ]),
      '/work',
    );
    // Same package, version and advisory, now in the root lockfile.
    const r = evaluate({ head: high, base: inFixture, allowlist: NO_ALLOW, today: TODAY });
    expect(r.failures.map((f: { lockfile: string }) => f.lockfile)).toEqual(['bun.lock']);
    // And the same finding in the same lockfile stays pre-existing.
    expect(
      evaluate({ head: high, base: high, allowlist: NO_ALLOW, today: TODAY }).failures,
    ).toEqual([]);
  });

  it('without a base, a vulnerability fails only in full mode', () => {
    expect(
      evaluate({ head: high, base: null, allowlist: NO_ALLOW, today: TODAY }).failures,
    ).toEqual([]);
    expect(
      evaluate({ head: high, base: null, allowlist: NO_ALLOW, today: TODAY, full: true }).failures,
    ).toHaveLength(1);
  });

  it('a scoped allowlist entry suppresses by id or alias', () => {
    const allow = loadAllowlist({ allow: [entry()] }, TODAY);
    const r = evaluate({ head: mal, base: null, allowlist: allow, today: TODAY });
    expect(r.failures).toEqual([]);
    expect(r.suppressed).toHaveLength(1);
    const viaAlias = loadAllowlist({ allow: [entry({ id: 'GHSA-alias-0001' })] }, TODAY);
    const withAlias = [{ ...mal[0], aliases: ['GHSA-alias-0001'] }];
    expect(
      evaluate({ head: withAlias, base: null, allowlist: viaAlias, today: TODAY }).failures,
    ).toEqual([]);
  });

  it('an entry is scoped: another package, version or lockfile is NOT suppressed', () => {
    for (const over of [
      { package: 'other-pkg' },
      { version: '1.0.1' },
      { lockfile: 'examples/app/bun.lock' },
    ]) {
      const allow = loadAllowlist({ allow: [entry(over)] }, TODAY);
      expect(
        evaluate({ head: mal, base: null, allowlist: allow, today: TODAY }).failures,
        JSON.stringify(over),
      ).toHaveLength(1);
    }
  });

  it('an EXPIRED allowlist entry stops suppressing', () => {
    const allow = loadAllowlist(
      { allow: [entry({ added: '2026-09-01', expires: '2026-10-01' })] },
      TODAY,
    );
    expect(
      evaluate({ head: mal, base: null, allowlist: allow, today: TODAY }).failures,
    ).toHaveLength(1);
  });
});

describe('loadAllowlist', () => {
  const bad = (over: Record<string, unknown>) => () =>
    loadAllowlist({ allow: [entry(over)] }, TODAY);
  it('accepts a fully scoped entry', () => {
    expect(() => loadAllowlist({ allow: [entry()] }, TODAY)).not.toThrow();
  });
  it('rejects a justification that is only a token word', () => {
    expect(bad({ justification: 'fine' })).toThrow(/justification/);
  });
  it('rejects a missing id, justification or a bad added date', () => {
    expect(bad({ id: undefined })).toThrow(/id/);
    expect(bad({ justification: undefined })).toThrow(/justification/);
    expect(bad({ added: undefined })).toThrow(/added/);
    expect(bad({ added: 'yesterday' })).toThrow(/added/);
  });
  it('REQUIRES package, version and lockfile (no id-only entries)', () => {
    expect(bad({ package: undefined })).toThrow(/package/);
    expect(bad({ version: undefined })).toThrow(/version/);
    expect(bad({ lockfile: undefined })).toThrow(/lockfile/);
  });
  it('rejects wildcards and ranges in the scope', () => {
    expect(bad({ package: '*' })).toThrow(/package/);
    expect(bad({ package: 'ev*l' })).toThrow(/package/);
    expect(bad({ version: '^1.0.0' })).toThrow(/version/);
    expect(bad({ version: '>=1.0.0' })).toThrow(/version/);
    expect(bad({ lockfile: '**/bun.lock' })).toThrow(/lockfile/);
  });
  it('REQUIRES expires, well formed, after added and within 180 days of it', () => {
    expect(bad({ expires: undefined })).toThrow(/expires/);
    expect(bad({ expires: 'soon' })).toThrow(/expires/);
    expect(bad({ added: '2026-10-01', expires: '2026-09-30' })).toThrow(/expires/);
    expect(bad({ added: '2026-01-01', expires: '2026-12-31' })).toThrow(/180/);
    expect(bad({ added: '2026-10-01', expires: '2027-03-30' })).not.toThrow();
  });
  it('rejects an added date in the future (it would push the expiry cap out with it)', () => {
    expect(bad({ added: '2026-10-25', expires: '2026-12-01' })).toThrow(/future/);
  });
  it('rejects unknown keys (a typo must not silently widen or drop a scope)', () => {
    expect(bad({ packages: 'x' })).toThrow(/unknown/);
  });
  it('rejects a document that is not an allowlist', () => {
    expect(() => loadAllowlist({}, TODAY)).toThrow();
    expect(() => loadAllowlist(null, TODAY)).toThrow();
  });
});

describe('the committed allowlist', () => {
  it('parses and is dated and justified', () => {
    const json = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'security/osv-allowlist.json'), 'utf8'),
    );
    expect(() => loadAllowlist(json, TODAY)).not.toThrow();
  });
});

describe('lockfile discovery', () => {
  it('covers every tracked bun.lock, Cargo.lock, go.mod and package-lock.json', () => {
    const tracked = execFileSync(
      'git',
      [
        'ls-files',
        '--',
        'bun.lock',
        '**/bun.lock',
        'Cargo.lock',
        '**/Cargo.lock',
        'go.mod',
        '**/go.mod',
        'package-lock.json',
        '**/package-lock.json',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter(Boolean)
      .sort();
    const everything = execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
    expect(selectLockfiles(everything).sort()).toEqual(tracked);
    // A lockfile named like one but with a different basename is not selected.
    expect(selectLockfiles(['a/bun.lockb', 'a/my-go.mod', 'x/go.mod'])).toEqual(['x/go.mod']);
    expect(tracked.length).toBeGreaterThan(10);
    expect(LOCKFILE_NAMES).toEqual(['bun.lock', 'Cargo.lock', 'go.mod', 'package-lock.json']);
  });
});

describe('pickBase: which commit to compare against', () => {
  const exists = (refs: string[]) => (r: string) => refs.includes(r);
  it('uses the supplied base when it resolves', () => {
    expect(pickBase({ supplied: 'abc123', resolves: exists(['abc123']), currentRef: 'x' })).toBe(
      'abc123',
    );
  });
  it('falls back to origin/integration/v2, then origin/main, for an empty or all-zero base', () => {
    for (const supplied of [undefined, '', '0000000000000000000000000000000000000000']) {
      expect(
        pickBase({
          supplied,
          resolves: exists(['origin/integration/v2', 'origin/main']),
          currentRef: 'feature',
        }),
      ).toBe('origin/integration/v2');
      expect(pickBase({ supplied, resolves: exists(['origin/main']), currentRef: 'feature' })).toBe(
        'origin/main',
      );
    }
  });
  it('never trusts an all-zero base, even if the resolver would accept it', () => {
    expect(
      pickBase({
        supplied: '0000000000000000000000000000000000000000',
        resolves: () => true,
        currentRef: 'feature',
      }),
    ).toBe('origin/integration/v2');
  });
  it('falls back when the supplied base is not in the clone', () => {
    expect(
      pickBase({ supplied: 'deadbeef', resolves: exists(['origin/main']), currentRef: 'f' }),
    ).toBe('origin/main');
  });
  it('never compares a branch with itself: on integration/v2 the fallback is main', () => {
    expect(
      pickBase({
        supplied: undefined,
        resolves: exists(['origin/integration/v2', 'origin/main']),
        currentRef: 'integration/v2',
      }),
    ).toBe('origin/main');
  });
  it('returns null when nothing resolves (the caller then fails closed)', () => {
    expect(pickBase({ supplied: undefined, resolves: exists([]), currentRef: 'f' })).toBeNull();
  });
});

describe('scripts/osv-gate.mjs: what it cannot scan', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/osv-gate.mjs'), 'utf8');
  it('OSV matches by name and version, so the report lists git, tarball and other-registry sources it did not cover', () => {
    expect(src).toContain('renderUnscannable(');
    expect(src).toContain("from './lib/release-age.mjs'");
  });
});

describe('scripts/osv-gate.mjs: base handling', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/osv-gate.mjs'), 'utf8');
  it('picks its base with pickBase and FAILS CLOSED when none resolves', () => {
    expect(src).toContain('pickBase(');
    expect(src).toMatch(/picked === null\) \{\s*throw new Error/);
  });
  it('does not skip the base comparison on a first push or a dispatch', () => {
    // The old code compared only when a non-zero base was supplied, so "no base"
    // silently meant "nothing can be new". The comparison is now gated on the mode only.
    expect(src).toMatch(/if \(!flag\('full'\) && !flag\('malicious-only'\)\)/);
    expect(src).not.toMatch(/\^0\+\$/);
  });
});

describe('.github/workflows/osv-scan.yml', () => {
  const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/osv-scan.yml'), 'utf8');
  const doc = parse(text) as {
    on: Record<string, unknown>;
    permissions: unknown;
    jobs: Record<string, { steps: Array<Record<string, unknown>>; permissions?: unknown }>;
  };
  const job = Object.values(doc.jobs)[0];
  const code = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  it('runs on every pull request and on pushes to the long-lived lines', () => {
    expect(Object.keys(doc.on)).toContain('pull_request');
    expect(Object.keys(doc.on)).toContain('push');
  });
  it('is read-only', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
  });
  it('installs a version-pinned osv-scanner and verifies its sha256 before running it', () => {
    expect(code).toMatch(/OSV_SCANNER_VERSION:\s*v\d+\.\d+\.\d+\b/);
    const sha = code.match(/OSV_SCANNER_SHA256:\s*([0-9a-f]{64})\b/);
    expect(sha, 'a 64-hex sha256 pin').not.toBeNull();
    expect(code).toMatch(/sha256sum -c/);
    const verify = code.indexOf('sha256sum -c');
    const run = code.indexOf('scripts/osv-gate.mjs');
    expect(verify).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(verify);
  });
  it('runs the gate and cannot be softened', () => {
    expect(code).toContain('node scripts/osv-gate.mjs');
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toMatch(/\|\|\s*true/);
  });
  it('scans from a full-depth checkout so the merge base exists', () => {
    expect(code).toMatch(/fetch-depth:\s*0/);
  });
});
