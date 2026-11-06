import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// The script guards main() behind an entrypoint check so the pure helpers
// can be imported here without a pack+install+audit run.
import { classifyVulnerabilities } from '../scripts/audit-published.mjs';

/**
 * `npm audit --json` reports a vulnerable TRANSITIVE dependency as a chain of
 * groups: the package that actually carries the advisory (object `via`
 * entries), plus one derived group per dependent up the chain whose `via` is
 * only package-NAME strings (`minio` -> `query-string` -> `decode-uri-component`).
 *
 * The gate used to read advisory ids only from OBJECT `via` entries, so a
 * derived group had zero ids and `ids.length > 0 && ...` could never be true:
 * allowlisting the root advisory suppressed `decode-uri-component` and still
 * failed `minio` + `query-string`. The allowlist was unusable for any
 * transitive advisory, and the gate stayed red with a justified entry present.
 *
 * The fixture is the real `npm audit --omit=dev --json` of minio@8.0.7 (the
 * published @getknext/lib closure), trimmed to the keys the gate reads.
 */
const adv = (source: number, id: string, severity: string, range: string) => ({
  source,
  title: id,
  url: `https://github.com/advisories/${id}`,
  severity,
  range,
});

const FIXTURE = {
  'decode-uri-component': {
    name: 'decode-uri-component',
    severity: 'high',
    via: [
      adv(1147955, 'GHSA-vcc3-ghjq-m6fr', 'moderate', '<=0.4.2'),
      adv(1243857, 'GHSA-qr28-fpjm-wq7f', 'high', '<=0.5.0'),
    ],
  },
  minio: { name: 'minio', severity: 'high', via: ['query-string', 'stream-json'] },
  'query-string': { name: 'query-string', severity: 'high', via: ['decode-uri-component'] },
  'stream-json': {
    name: 'stream-json',
    severity: 'moderate',
    via: [
      adv(1164823, 'GHSA-528h-pc64-c93x', 'moderate', '<=3.4.0'),
      adv(1241262, 'GHSA-hqr4-qq8f-hg3x', 'moderate', '<=3.5.0'),
      adv(1241263, 'GHSA-mjw6-4jj6-33hc', 'moderate', '<3.6.0'),
    ],
  },
};

const names = (r: { failing: { name: string }[] }) => r.failing.map((f) => f.name).sort();

describe('classifyVulnerabilities — derived (name-only via) groups', () => {
  it('fails every group in the chain when nothing is allowlisted', () => {
    const r = classifyVulnerabilities(FIXTURE, new Set());
    expect(names(r)).toEqual(['decode-uri-component', 'minio', 'query-string']);
  });

  it('clears the whole chain once the root advisories are allowlisted', () => {
    const r = classifyVulnerabilities(
      FIXTURE,
      new Set(['GHSA-vcc3-ghjq-m6fr', 'GHSA-qr28-fpjm-wq7f']),
    );
    expect(names(r)).toEqual([]);
    expect(r.suppressed.map((s: { name: string }) => s.name).sort()).toEqual([
      'decode-uri-component',
      'minio',
      'query-string',
    ]);
  });

  it('keeps the root group strict: every advisory on the carrier must be allowlisted', () => {
    const r = classifyVulnerabilities(FIXTURE, new Set(['GHSA-qr28-fpjm-wq7f']));
    expect(names(r)).toContain('decode-uri-component');
  });

  it('does NOT clear a derived group whose HIGH root advisory is not allowlisted', () => {
    const r = classifyVulnerabilities(FIXTURE, new Set(['GHSA-vcc3-ghjq-m6fr']));
    expect(names(r)).toEqual(['decode-uri-component', 'minio', 'query-string']);
  });

  it('fails closed when a derived group names a package the report does not describe', () => {
    const r = classifyVulnerabilities(
      { orphan: { name: 'orphan', severity: 'high', via: ['not-in-report'] } },
      new Set(['GHSA-qr28-fpjm-wq7f']),
    );
    expect(names(r)).toEqual(['orphan']);
  });

  it('terminates on a cyclic via graph and fails closed', () => {
    const r = classifyVulnerabilities(
      {
        a: { name: 'a', severity: 'high', via: ['b'] },
        b: { name: 'b', severity: 'high', via: ['a'] },
      },
      new Set(),
    );
    expect(names(r)).toEqual(['a', 'b']);
  });

  it('fails closed when an unknown name sits beside an allowlisted carrier', () => {
    // Without the fail-closed return, the allowlisted carrier's ids alone
    // would clear this group even though `ghost` is undescribed.
    const r = classifyVulnerabilities(
      {
        ...FIXTURE,
        mixed: { name: 'mixed', severity: 'high', via: ['decode-uri-component', 'ghost'] },
      },
      new Set(['GHSA-vcc3-ghjq-m6fr', 'GHSA-qr28-fpjm-wq7f']),
    );
    expect(names(r)).toEqual(['mixed']);
  });

  it('fails closed when a cycle sits beside an allowlisted carrier', () => {
    const r = classifyVulnerabilities(
      {
        ...FIXTURE,
        a: { name: 'a', severity: 'high', via: ['decode-uri-component', 'b'] },
        b: { name: 'b', severity: 'high', via: ['a'] },
      },
      new Set(['GHSA-vcc3-ghjq-m6fr', 'GHSA-qr28-fpjm-wq7f']),
    );
    expect(names(r)).toEqual(['a', 'b']);
  });

  it('ignores moderate advisories on the way up the chain (gate is HIGH/CRITICAL)', () => {
    // minio also depends on stream-json (3 moderate advisories); those must
    // neither fail nor need allowlisting.
    const r = classifyVulnerabilities(
      FIXTURE,
      new Set(['GHSA-vcc3-ghjq-m6fr', 'GHSA-qr28-fpjm-wq7f']),
    );
    expect(names(r)).not.toContain('stream-json');
  });
});

describe('security/npm-audit-allowlist.json — covers the decode-uri-component advisories', () => {
  const parsed = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../security/npm-audit-allowlist.json'), 'utf8'),
  ) as { allow: { id: string; expires?: string }[] };
  const ids = parsed.allow.map((e) => e.id);

  it.each(['GHSA-vcc3-ghjq-m6fr', 'GHSA-qr28-fpjm-wq7f'])('allowlists %s with an expiry', (id) => {
    const entry = parsed.allow.find((e) => e.id === id);
    expect(ids).toContain(id);
    expect(entry?.expires, `${id} must expire`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the gate clears the real fixture with the committed allowlist', () => {
    const r = classifyVulnerabilities(FIXTURE, new Set(ids));
    expect(names(r)).toEqual([]);
  });
});
