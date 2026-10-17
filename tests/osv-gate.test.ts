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

  it('an unknown-severity vulnerability is reported, not failed', () => {
    const r = evaluate({ head: unknown, base: [], allowlist: NO_ALLOW, today: TODAY });
    expect(r.failures).toEqual([]);
    expect(r.unknownSeverity).toHaveLength(1);
  });

  it('without a base, a vulnerability fails only in full mode', () => {
    expect(
      evaluate({ head: high, base: null, allowlist: NO_ALLOW, today: TODAY }).failures,
    ).toEqual([]);
    expect(
      evaluate({ head: high, base: null, allowlist: NO_ALLOW, today: TODAY, full: true }).failures,
    ).toHaveLength(1);
  });

  it('an allowlist entry suppresses by id or alias', () => {
    const allow = loadAllowlist(
      {
        allow: [
          {
            id: 'MAL-2026-1234',
            justification: 'false positive: confirmed with the maintainer',
            added: '2026-10-01',
          },
        ],
      },
      TODAY,
    );
    const r = evaluate({ head: mal, base: null, allowlist: allow, today: TODAY });
    expect(r.failures).toEqual([]);
    expect(r.suppressed).toHaveLength(1);
  });

  it('an EXPIRED allowlist entry stops suppressing', () => {
    const allow = loadAllowlist(
      {
        allow: [
          {
            id: 'MAL-2026-1234',
            justification: 'false positive: confirmed with the maintainer',
            added: '2026-09-01',
            expires: '2026-10-01',
          },
        ],
      },
      TODAY,
    );
    expect(
      evaluate({ head: mal, base: null, allowlist: allow, today: TODAY }).failures,
    ).toHaveLength(1);
  });
});

describe('loadAllowlist', () => {
  it('rejects a justification that is only a token word', () => {
    expect(() =>
      loadAllowlist({ allow: [{ id: 'X', justification: 'fine', added: '2026-10-01' }] }, TODAY),
    ).toThrow(/justification/);
  });
  it('rejects an entry with no justification, no date or a bad date', () => {
    expect(() => loadAllowlist({ allow: [{ id: 'X', added: '2026-10-01' }] }, TODAY)).toThrow(
      /justification/,
    );
    expect(() =>
      loadAllowlist({ allow: [{ id: 'X', justification: 'long enough reason here' }] }, TODAY),
    ).toThrow(/added/);
    expect(() =>
      loadAllowlist(
        { allow: [{ id: 'X', justification: 'long enough reason here', added: 'yesterday' }] },
        TODAY,
      ),
    ).toThrow(/added/);
    expect(() =>
      loadAllowlist(
        { allow: [{ justification: 'long enough reason here', added: '2026-10-01' }] },
        TODAY,
      ),
    ).toThrow(/id/);
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
  it('covers every tracked bun.lock, Cargo.lock and go.mod', () => {
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
    expect(LOCKFILE_NAMES).toEqual(['bun.lock', 'Cargo.lock', 'go.mod']);
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
