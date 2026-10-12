import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  CREDENTIALED_NEXT_MINORS,
  NEXT_MATRIX_VERSIONS,
  NEXT_PEER_RANGE,
} from '../packages/kn-next/src/next-compat';

/**
 * #2286 item 1: the cache-handler specs run on every admitted Next minor.
 * The version list lives ONLY in next-compat.ts; the workflow gets it from
 * scripts/next-minor-matrix.mjs, and these tests pin each link of that chain.
 */
const ROOT = resolve(import.meta.dirname, '..');
const WF = resolve(ROOT, '.github/workflows/next-minor-matrix.yml');
const wfText = readFileSync(WF, 'utf8');
type Step = { uses?: string; run?: string; id?: string; env?: Record<string, string> };
type Job = {
  needs?: string;
  steps?: Step[];
  strategy?: Record<string, unknown>;
  outputs?: Record<string, string>;
};
// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
const wf = parse(wfText) as { on: Record<string, any>; jobs: Record<string, Job> };

const SPECS = [
  'cache-handler-next-stale-after-wake',
  'cache-handler-next-cache-controls-missing',
  'cache-handler-ppr-build-scope',
  'cache-handler-isr-staleness',
];

const minorOf = (v: string) => v.split('.').slice(0, 2).join('.');

describe('next-minor matrix (#2286)', () => {
  it('the script prints exactly the versions in next-compat.ts', () => {
    const r = spawnSync('bun', [resolve(ROOT, 'scripts/next-minor-matrix.mjs')], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      include: NEXT_MATRIX_VERSIONS.map((next) => ({ next, minor: minorOf(next) })),
    });
  });

  it('the credential pin is a leg, and equals the kn-next next devDependency', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'packages/kn-next/package.json'), 'utf8'));
    expect(NEXT_MATRIX_VERSIONS[0]).toBe(pkg.devDependencies.next);
    for (const minor of CREDENTIALED_NEXT_MINORS) {
      expect(NEXT_MATRIX_VERSIONS.some((v) => v.startsWith(`${minor}.`))).toBe(true);
    }
  });

  it('covers every admitted minor >= 16.3 exactly once, none outside the peer range', () => {
    const minors = NEXT_MATRIX_VERSIONS.map(minorOf);
    expect(new Set(minors).size).toBe(minors.length);
    const m = /^>=16\.(\d+)\.0 <16\.(\d+)\.0$/.exec(NEXT_PEER_RANGE);
    expect(m).not.toBeNull();
    // 16.0-16.2 share the credential pin's code path (the #1888 seed); the pin
    // leg (16.3) guards the seed, the 16.4+ legs guard scopeWindowToBuild.
    const expected: string[] = [];
    for (let i = Math.max(3, Number(m?.[1])); i < Number(m?.[2]); i++) expected.push(`16.${i}`);
    expect(minors).toEqual(expected);
    for (const v of NEXT_MATRIX_VERSIONS) expect(v).toMatch(/^16\.\d+\.\d+$/);
  });

  it('the workflow derives its matrix from the script, with no literal version list', () => {
    expect(wf.jobs.plan.steps?.some((s) => s.run?.includes('scripts/next-minor-matrix.mjs'))).toBe(
      true,
    );
    const mx = wf.jobs.matrix;
    expect(mx.needs).toBe('plan');
    expect(JSON.stringify(mx.strategy)).toContain('fromJSON(needs.plan.outputs.matrix)');
    expect(mx.strategy?.['fail-fast']).toBe(false);
    for (const v of NEXT_MATRIX_VERSIONS) expect(wfText).not.toContain(v);
  });

  it('each leg installs the matrix next and runs the specs, with no failure softening', () => {
    const steps = wf.jobs.matrix.steps ?? [];
    const install = steps.findIndex(
      (s) =>
        s.run?.includes('bun add') && Object.values(s.env ?? {}).includes('${{ matrix.next }}'),
    );
    const run = steps.findIndex((s) => s.run?.includes('scripts/bun-test.mjs'));
    expect(install).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(install);
    for (const spec of SPECS) expect(steps[run].run).toContain(spec);
    expect(steps.some((s) => s.run?.includes('--frozen-lockfile'))).toBe(true);
    expect(wfText).not.toMatch(/continue-on-error/);
    expect(wfText).not.toMatch(/\|\|\s*true/);
    // The leg must prove it ran against the requested version.
    expect(steps.some((s) => s.run?.includes('next/package.json'))).toBe(true);
  });

  it('triggers on the cache-handler, its specs, next-compat and the package manifest', () => {
    const paths: string[] = wf.on.pull_request.paths;
    for (const p of [
      'packages/kn-next/src/adapters/cache-handler.js',
      'packages/kn-next/src/next-compat.ts',
      'packages/kn-next/package.json',
      'scripts/next-minor-matrix.mjs',
      '.github/workflows/next-minor-matrix.yml',
    ]) {
      expect(paths).toContain(p);
    }
    expect(paths).toContain('packages/kn-next/src/__tests__/cache-handler-*.test.ts');
    expect(wf.on.push.branches).toContain('main');
    expect(wf.on.schedule).toHaveLength(1);
  });
});
