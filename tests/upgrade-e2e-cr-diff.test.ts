import { describe, expect, it } from 'bun:test';
import { specUnchanged } from '../scripts/upgrade-e2e/cr-diff.mjs';

/**
 * Unit tests for the operator upgrade-under-load e2e's "CRs reconcile
 * unchanged" assertion (#1668) — the NextApp `spec` must be byte-identical
 * before and after an operator/CRD upgrade. Pure — no cluster, no fs.
 */
describe('specUnchanged', () => {
  it('passes for an identical spec', () => {
    const spec = { name: 'app', registry: 'r.example.com/app', env: { A: '1' } };
    const result = specUnchanged(spec, structuredClone(spec));
    expect(result.ok).toBe(true);
    expect(result.diffPaths).toEqual([]);
  });

  it('catches a top-level field change', () => {
    const before = { name: 'app', replicas: 1 };
    const after = { name: 'app', replicas: 2 };
    const result = specUnchanged(before, after);
    expect(result.ok).toBe(false);
    expect(result.diffPaths).toContain('$.replicas');
  });

  it('catches a nested field change', () => {
    const before = { env: { A: '1', B: '2' } };
    const after = { env: { A: '1', B: '3' } };
    const result = specUnchanged(before, after);
    expect(result.ok).toBe(false);
    expect(result.diffPaths).toContain('$.env.B');
  });

  it('catches an added or removed field', () => {
    const before = { name: 'app' };
    const after = { name: 'app', newField: 'unexpected' };
    const result = specUnchanged(before, after);
    expect(result.ok).toBe(false);
    expect(result.diffPaths).toContain('$.newField');
  });

  it('catches an array element change', () => {
    const before = { traffic: [{ revisionName: 'rev1', percent: 100 }] };
    const after = { traffic: [{ revisionName: 'rev1', percent: 90 }] };
    const result = specUnchanged(before, after);
    expect(result.ok).toBe(false);
    expect(result.diffPaths).toContain('$.traffic[0].percent');
  });
});
