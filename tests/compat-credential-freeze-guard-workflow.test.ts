import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Wiring tests for `.github/workflows/compat-credential-freeze-guard.yml`
 * (#1302) — the shape of the workflow itself, mirroring
 * `tests/actionlint-workflow.test.ts`'s pattern for the same injection-safety
 * and permissions concerns.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/compat-credential-freeze-guard.yml');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on?: { pull_request?: { branches?: string[] } };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

function load(): { text: string; wf: Workflow } {
  const text = readFileSync(WORKFLOW_PATH, 'utf8');
  return { text, wf: parse(text) as Workflow };
}

describe('compat-credential-freeze-guard.yml is valid and triggers on every PR (#1302)', () => {
  it('parses as YAML', () => {
    expect(() => load()).not.toThrow();
  });

  it('triggers on pull_request against any branch (stacked PRs included, no paths: scope)', () => {
    const { wf } = load();
    expect(wf.on?.pull_request?.branches).toEqual(['**']);
    // Deliberately NOT paths:-scoped to .github/workflows/** (unlike
    // actionlint.yml) — the frozen set spans scripts/, test/, and
    // .github/workflows/, so narrowing the trigger would blind the gate to
    // a scripts/e2e-*.sh-only PR.
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    const onBlock = raw.slice(raw.indexOf('\non:'), raw.indexOf('\npermissions:'));
    expect(onBlock).not.toMatch(/paths:/);
  });

  it('both top-level and job-level permissions are read-only', () => {
    const { wf } = load();
    expect(wf.permissions?.contents).toBe('read');
    const job = wf.jobs['freeze-guard'];
    expect(job.permissions?.contents).toBe('read');
    // No other permission scope granted anywhere in the job.
    expect(Object.keys(job.permissions ?? {})).toEqual(['contents']);
  });
});

describe('injection safety: PR-controlled values flow through env:, never inline in run: (#1302)', () => {
  it('the diff step reads BASE_SHA/HEAD_SHA via env:, and the script reads them as shell vars', () => {
    const { wf } = load();
    const step = wf.jobs['freeze-guard'].steps.find((s) => /Compute the files/.test(s.name ?? ''));
    expect(step, 'diff step not found').toBeTruthy();
    expect(step?.env?.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');
    expect(step?.env?.HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}');
    expect(String(step?.run)).toContain('"${BASE_SHA}"');
    expect(String(step?.run)).toContain('"${HEAD_SHA}"');
    // Never a raw ${{ }} substitution inside the script body itself.
    expect(String(step?.run)).not.toMatch(/\$\{\{/);
  });

  it('the pin-read step reads BASE_SHA via env:, never inline', () => {
    const { wf } = load();
    const step = wf.jobs['freeze-guard'].steps.find((s) => /Read the pin file/.test(s.name ?? ''));
    expect(step, 'pin-read step not found').toBeTruthy();
    expect(step?.env?.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');
    expect(String(step?.run)).toContain('"${BASE_SHA}:.github/compat-credential-ref.json"');
    expect(String(step?.run)).not.toMatch(/\$\{\{/);
  });

  it('no step anywhere in the job interpolates ${{ }} directly into its run: script', () => {
    const { wf } = load();
    for (const step of wf.jobs['freeze-guard'].steps) {
      if (!step.run) continue;
      expect(step.run, `step "${step.name}" interpolates \${{ }} inline in run:`).not.toMatch(
        /\$\{\{/,
      );
    }
  });
});

describe('the pin is read at the BASE commit, not head (#1302)', () => {
  it('git show targets ${BASE_SHA}, never a bare checkout-relative read of the pin path', () => {
    const { text } = load();
    expect(text).toMatch(/git show "\$\{BASE_SHA\}:\.github\/compat-credential-ref\.json"/);
  });

  it('a missing historical pin degrades to the unfrozen shape, not a job failure', () => {
    const { text } = load();
    expect(text).toMatch(/\{"rcTag":\s*null\}/);
  });
});

describe('the guard script runs with no hardcoded frozen-file list in the workflow itself (#1302)', () => {
  it('the "Run the freeze guard" step passes no --files/--frozen-set flag — derivation lives in the script', () => {
    const { wf } = load();
    const step = wf.jobs['freeze-guard'].steps.find((s) =>
      /Run the freeze guard/.test(s.name ?? ''),
    );
    expect(step, 'guard-invocation step not found').toBeTruthy();
    expect(String(step?.run)).toContain('compat-credential-freeze-guard.mjs');
    expect(String(step?.run)).not.toMatch(/--files|--frozen-set|--protected/);
  });
});

describe('the checkout has full history — required for both the diff and the base-commit pin read (#1302)', () => {
  it('fetch-depth: 0 is set on the checkout step', () => {
    const { wf } = load();
    const checkout = wf.jobs['freeze-guard'].steps.find((s) =>
      s.uses?.startsWith('actions/checkout'),
    );
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });
});
