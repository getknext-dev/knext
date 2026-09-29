import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Wiring tests for `.github/workflows/published-bytes-freeze-guard.yml`
 * (#1663) — mirrors `tests/compat-credential-freeze-guard-workflow.test.ts`'s
 * shape/injection-safety pattern for the sibling guard.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/published-bytes-freeze-guard.yml');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}
interface Job {
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on?: { pull_request?: { branches?: string[] }; merge_group?: unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

function load(): { text: string; wf: Workflow } {
  const text = readFileSync(WORKFLOW_PATH, 'utf8');
  return { text, wf: parse(text) as Workflow };
}

const JOB = 'published-bytes-freeze';

describe('published-bytes-freeze-guard.yml is valid and triggers on every PR (#1663)', () => {
  it('parses as YAML', () => {
    expect(() => load()).not.toThrow();
  });

  it('triggers on pull_request against any branch (stacked PRs included, no paths: scope)', () => {
    const { wf, text } = load();
    expect(wf.on?.pull_request?.branches).toEqual(['**']);
    const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));
    expect(onBlock).not.toMatch(/paths:/);
  });

  it('also triggers on merge_group — a future required check must not stall the queue', () => {
    const { wf } = load();
    expect('merge_group' in (wf.on ?? {})).toBe(true);
  });

  it('both top-level and job-level permissions are read-only', () => {
    const { wf } = load();
    expect(wf.permissions?.contents).toBe('read');
    const job = wf.jobs[JOB];
    expect(job.permissions?.contents).toBe('read');
    expect(Object.keys(job.permissions ?? {})).toEqual(['contents']);
  });
});

describe('queue-safe base/head SHAs', () => {
  it('job-level env computes BASE_SHA/HEAD_SHA from merge_group OR pull_request', () => {
    const { wf } = load();
    const job = wf.jobs[JOB];
    expect(job.env?.BASE_SHA).toContain('github.event.merge_group.base_sha');
    expect(job.env?.BASE_SHA).toContain('github.event.pull_request.base.sha');
    expect(job.env?.HEAD_SHA).toContain('github.event.merge_group.head_sha');
    expect(job.env?.HEAD_SHA).toContain('github.event.pull_request.head.sha');
  });
});

describe('injection safety: PR-controlled values flow through env:, never inline in run:', () => {
  it('the diff step uses BASE_SHA/HEAD_SHA as shell vars, never ${{ }} inline', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) => /Compute the files/.test(s.name ?? ''));
    expect(step, 'diff step not found').toBeTruthy();
    expect(String(step?.run)).toContain('"${BASE_SHA}');
    expect(String(step?.run)).toContain('${HEAD_SHA}"');
    expect(String(step?.run)).not.toMatch(/\$\{\{/);
  });

  it('no step anywhere in the job interpolates ${{ }} directly into its run: script', () => {
    const { wf } = load();
    for (const step of wf.jobs[JOB].steps) {
      if (!step.run) continue;
      expect(step.run, `step "${step.name}" interpolates \${{ }} inline in run:`).not.toMatch(
        /\$\{\{/,
      );
    }
  });
});

describe('the base-commit diff uses three-dot notation AND --no-renames', () => {
  it('git diff --no-renames --name-only uses BASE_SHA...HEAD_SHA, not a two-dot range', () => {
    const { text } = load();
    expect(text).toMatch(/git diff --no-renames --name-only "\$\{BASE_SHA\}\.\.\.\$\{HEAD_SHA\}"/);
  });
});

describe('checkout resolves the credentialed rc tag', () => {
  it('fetch-depth: 0 AND fetch-tags: true are both set (a tag-diff needs both)', () => {
    const { wf } = load();
    const checkout = wf.jobs[JOB].steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(checkout?.with?.['fetch-tags']).toBe(true);
  });
});

describe('dependency install precedes the check invocation (the #1615-class defect, guarded here too)', () => {
  it('bun install runs before the published-bytes freeze check step', () => {
    const { wf } = load();
    const steps = wf.jobs[JOB].steps;
    const installIdx = steps.findIndex(
      (s) => typeof s.run === 'string' && /\bbun install --frozen-lockfile\b/.test(s.run),
    );
    const checkIdx = steps.findIndex(
      (s) => typeof s.run === 'string' && /published-bytes-freeze-check\.mjs/.test(s.run),
    );
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBeGreaterThan(installIdx);
  });
});

describe('the check is invoked with a changed-files file, no hardcoded scope flag', () => {
  it('the invocation passes --changed-files-file and nothing resembling a hand-listed scope', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find(
      (s) => typeof s.run === 'string' && /published-bytes-freeze-check\.mjs/.test(s.run),
    );
    expect(step, 'check-invocation step not found').toBeTruthy();
    expect(String(step?.run)).toContain('--changed-files-file changed-files.txt');
    expect(String(step?.run)).not.toMatch(/--packages|--scope|--dirs/);
  });
});

describe('actionlint has no complaints about this workflow', () => {
  it('actionlint exits 0 on this file (skips gracefully if actionlint is not on PATH)', () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const probe = spawnSync('actionlint', ['--version'], { encoding: 'utf8' });
    if (probe.error) {
      // actionlint not installed in this environment — the real CI job
      // (`.github/workflows/actionlint.yml`) covers every workflow file by
      // directory scan regardless, so this is a local convenience check only.
      return;
    }
    const result = spawnSync('actionlint', [WORKFLOW_PATH], { encoding: 'utf8' });
    expect(result.stdout + result.stderr, 'actionlint findings').toBe('');
    expect(result.status).toBe(0);
  });
});
