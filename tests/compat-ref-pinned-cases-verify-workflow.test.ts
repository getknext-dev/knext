/**
 * The workflow that runs `compat-ref-pinned-cases-snapshot.mjs --verify` (ADR-0007 amendment, bars
 * 2 and 3). A check nobody runs is decoration: the reviewer forged a case plus a snapshot title and
 * every offline test stayed green, because nothing compared the snapshot with upstream. These
 * assertions hold the wiring that makes that comparison happen, and fail closed.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = '.github/workflows/compat-ref-pinned-cases-verify.yml';
const src = readFileSync(resolve(ROOT, FILE), 'utf8');
const wf = (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(src) as {
  on: {
    pull_request?: { paths?: string[] };
    schedule?: { cron: string }[];
    workflow_dispatch?: unknown;
  };
  jobs: Record<
    string,
    {
      if?: string;
      'continue-on-error'?: unknown;
      steps: { run?: string; env?: Record<string, string> }[];
    }
  >;
};
const code = src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

describe('the --verify workflow', () => {
  it('runs on PRs that touch the ledger, the snapshot or the tooling, nightly, and on dispatch', () => {
    const paths = wf.on.pull_request?.paths ?? [];
    for (const p of [
      'test/deploy-tests-manifest.knext.json',
      'test/compat-ref-pinned-cases.upstream.json',
      'scripts/compat-ref-pinned-cases-snapshot.mjs',
      'scripts/lib/ref-pinned-cases.mjs',
    ]) {
      expect(paths, p).toContain(p);
    }
    expect((wf.on.schedule ?? []).length).toBeGreaterThan(0);
    expect(wf.on).toHaveProperty('workflow_dispatch');
  });

  it('the verify job runs --verify, with the workflow token, and nothing swallows its exit', () => {
    const job = wf.jobs['verify-ref-pinned-cases'];
    const step = job.steps.find((s) => s.run?.includes('--verify'));
    expect(step?.run?.trim()).toBe('node scripts/compat-ref-pinned-cases-snapshot.mjs --verify');
    expect(step?.env?.GITHUB_TOKEN).toBe('${{ github.token }}');
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toMatch(/\|\|\s*true/);
  });

  it('is not a required-check name and holds no write scope outside the alert job', () => {
    expect(src).toMatch(/^permissions:\n {2}contents: read$/m);
    const alert = wf.jobs['nightly-red-alert'];
    expect(alert.if).toContain("github.event_name == 'schedule'");
    expect(alert.if).toContain('always()');
    expect(alert.if).toContain("== 'failure'");
    expect(alert.if).toContain("== 'cancelled'");
  });
});
