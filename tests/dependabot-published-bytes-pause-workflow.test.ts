import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Wiring tests for `.github/workflows/dependabot-published-bytes-pause.yml`
 * (#1663).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/dependabot-published-bytes-pause.yml');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on?: { pull_request?: { types?: string[]; branches?: string[] } };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

function load(): { text: string; wf: Workflow } {
  const text = readFileSync(WORKFLOW_PATH, 'utf8');
  return { text, wf: parse(text) as Workflow };
}

const JOB = 'pause-if-published-bytes-frozen';

describe('dependabot-published-bytes-pause.yml is valid and gated on the bot actor', () => {
  it('parses as YAML', () => {
    expect(() => load()).not.toThrow();
  });

  it('the job runs only when github.actor is dependabot[bot]', () => {
    const { wf } = load();
    expect(wf.jobs[JOB].if).toContain("github.actor == 'dependabot[bot]'");
  });

  it('top-level permissions are read-only; the job itself scopes pull-requests: write', () => {
    const { wf } = load();
    expect(wf.permissions?.contents).toBe('read');
    expect(Object.keys(wf.permissions ?? {})).toEqual(['contents']);
    const job = wf.jobs[JOB];
    expect(job.permissions?.['pull-requests']).toBe('write');
    expect(job.permissions?.contents).toBe('read');
  });
});

describe('the close step is gated on the decision script output, never re-derived inline', () => {
  it("the close step runs only if steps.decide.outputs.should_close == 'true'", () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) => /Close the PR/.test(s.name ?? ''));
    expect(step, 'close step not found').toBeTruthy();
    expect(step?.if).toContain("steps.decide.outputs.should_close == 'true'");
  });

  it("the decide step has id: decide (what the close step's if: reads)", () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) => /Decide whether to close/.test(s.name ?? ''));
    expect(step?.id).toBe('decide');
  });

  it('the decide step invokes dependabot-published-bytes-pause.mjs with --changed-files-file', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) => /Decide whether to close/.test(s.name ?? ''));
    expect(String(step?.run)).toContain('dependabot-published-bytes-pause.mjs');
    expect(String(step?.run)).toContain('--changed-files-file changed-files.txt');
  });
});

describe('injection safety: PR-controlled/derived values flow through env:, never inline in run:', () => {
  it('the close step reads CLOSE_REASON/PR_NUMBER from env, never ${{ }} inline in run:', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) => /Close the PR/.test(s.name ?? ''));
    expect(step?.env?.CLOSE_REASON).toContain('steps.decide.outputs.reason');
    expect(String(step?.run)).toContain('${CLOSE_REASON}"');
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

describe('the diff step precedes the decide step, which precedes the close step', () => {
  it('ordering: checkout -> diff -> decide -> close', () => {
    const { wf } = load();
    const steps = wf.jobs[JOB].steps;
    const diffIdx = steps.findIndex((s) => /Compute the files/.test(s.name ?? ''));
    const decideIdx = steps.findIndex((s) => /Decide whether to close/.test(s.name ?? ''));
    const closeIdx = steps.findIndex((s) => /Close the PR/.test(s.name ?? ''));
    expect(diffIdx).toBeGreaterThanOrEqual(0);
    expect(decideIdx).toBeGreaterThan(diffIdx);
    expect(closeIdx).toBeGreaterThan(decideIdx);
  });
});

describe('actionlint has no complaints about this workflow', () => {
  it('actionlint exits 0 on this file (skips gracefully if actionlint is not on PATH)', () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const probe = spawnSync('actionlint', ['--version'], { encoding: 'utf8' });
    if (probe.error) return;
    const result = spawnSync('actionlint', [WORKFLOW_PATH], { encoding: 'utf8' });
    expect(result.stdout + result.stderr, 'actionlint findings').toBe('');
    expect(result.status).toBe(0);
  });
});
