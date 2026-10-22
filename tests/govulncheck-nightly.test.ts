/**
 * The govulncheck nightly is what makes a dated exception stop passing ON its
 * expiry date. GitHub reads `schedule:` only from the default branch's copy of a
 * workflow, so this file exists identically on main and integration/v2: main's
 * copy is the one that fires, and it proves BOTH refs by checking each out.
 *
 * The integration/v2 leg must FAIL, not skip, when the Go template or the gate
 * is missing there: a silent green would hide a broken checkout, and the lane
 * would look healthy while proving nothing.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/govulncheck-nightly.yml'), 'utf8');
const wf = parse(text);

type Step = {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
};
const job = Object.values(wf.jobs)[0] as {
  strategy: { matrix: { ref: string[] }; 'fail-fast': boolean };
  steps: Step[];
};

describe('govulncheck-nightly.yml', () => {
  it('is scheduled daily and can be dispatched', () => {
    expect(wf.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(wf.on).toHaveProperty('workflow_dispatch');
  });

  it('proves BOTH main and integration/v2, one failing leg not cancelling the other', () => {
    expect(job.strategy.matrix.ref).toEqual(['main', 'integration/v2']);
    expect(job.strategy['fail-fast']).toBe(false);
  });

  it('checks the matrix ref out explicitly', () => {
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('${{ matrix.ref }}');
  });

  it('runs the gate under pipefail', () => {
    const gate = job.steps.find((s) => s.run?.includes('govulncheck@'));
    expect(gate?.run).toContain('set -euo pipefail');
    expect(gate?.run).toMatch(
      /govulncheck@v\d+\.\d+\.\d+ -format json \.\/\.\.\. \| node [^\n]*govulncheck-gate\.mjs/,
    );
  });

  it('every action is pinned by full SHA with a version comment', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });

  it('scans EVERY Go module, on every ref', () => {
    expect(job.strategy.matrix.module).toEqual([
      'templates/go',
      'packages/kn-next-operator',
      'packages/scale-zero-pg/gateway',
    ]);
  });

  it('the cron is unchanged', () => {
    expect(wf.on.schedule).toEqual([{ cron: '13 2 * * *' }]);
  });

  it('passes the module to the gate', () => {
    const gate = job.steps.find((s) => s.run?.includes('govulncheck@'));
    expect(gate?.run).toMatch(/govulncheck-gate\.mjs" "\$\{\{ matrix\.module \}\}"/);
    expect(gate?.['working-directory']).toBe('${{ matrix.module }}');
  });

  it('FAILS on every leg but main/templates/go when the module, gate or exceptions are missing', () => {
    const idx = job.steps.findIndex((s) => s.run?.includes('fail()'));
    expect(idx, 'a require step').toBeGreaterThan(-1);
    const step = job.steps[idx];
    // Only the main/templates/go leg is exempt: the operator and gateway exist on
    // main, so a hashFiles skip there would be a silent pass.
    expect(step.if).toContain("matrix.ref == 'main' && matrix.module == 'templates/go'");
    expect(step.if).toMatch(/!\(/);
    expect(step.run).toContain('set -euo pipefail');
    for (const f of [
      '"$MODULE/go.mod"',
      'scripts/govulncheck-gate.mjs',
      'security/govulncheck-exceptions.json',
    ]) {
      expect(step.run, f).toContain(`test -f ${f} || fail`);
    }
    expect(step.run).toMatch(/fail\(\) \{[^}]*exit 1/);
    // It runs before any step that is skipped by file presence.
    const firstSkippable = job.steps.findIndex((s) => s.if?.includes('hashFiles'));
    expect(idx).toBeLessThan(firstSkippable);
  });

  it('skips by file presence only on the module being scanned, and only after the require step', () => {
    const skippable = job.steps.filter((s) => s.if?.includes('hashFiles'));
    expect(skippable.length).toBeGreaterThanOrEqual(3);
    for (const s of skippable) {
      expect(s.if).toContain("hashFiles(format('{0}/go.mod', matrix.module)) != ''");
    }
  });
});
