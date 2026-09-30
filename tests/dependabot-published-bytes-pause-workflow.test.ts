import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Wiring tests for `.github/workflows/dependabot-published-bytes-pause.yml`
 * (#1663).
 *
 * Round 2 (PR #1680 review): the job was dead on arrival on plain
 * `pull_request` — GitHub forces GITHUB_TOKEN to READ-ONLY for a
 * `dependabot[bot]`-authored `pull_request` event regardless of this file's
 * own `permissions:` block, so `gh pr close` always 403'd the one time the
 * decision said to close. Fixed by switching to `pull_request_target`
 * (which gets this job's declared `permissions:` for real) WITHOUT ever
 * checking out or executing the PR's own head content — see the workflow's
 * own header for the full safety argument. The tests below assert both
 * halves: the trigger change, and that no step ever checks out
 * `github.event.pull_request.head`.
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
  on?: {
    pull_request?: { types?: string[]; branches?: string[] };
    pull_request_target?: { types?: string[]; branches?: string[] };
  };
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

describe('triggers on pull_request_target, not plain pull_request (round 2, PR #1680)', () => {
  it('the workflow-level trigger is pull_request_target', () => {
    const { wf } = load();
    expect('pull_request_target' in (wf.on ?? {})).toBe(true);
    expect('pull_request' in (wf.on ?? {})).toBe(false);
  });

  it('still scoped to opened/synchronize/reopened against any branch', () => {
    const { wf } = load();
    expect(wf.on?.pull_request_target?.types).toEqual(['opened', 'synchronize', 'reopened']);
    expect(wf.on?.pull_request_target?.branches).toEqual(['**']);
  });
});

describe('SAFETY: this job never checks out or executes the PR head (pull_request_target caveat)', () => {
  it('the checkout step carries no `ref:` at all (defaults to the BASE branch under pull_request_target)', () => {
    const { wf } = load();
    const checkout = wf.jobs[JOB].steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout, 'checkout step not found').toBeTruthy();
    expect(checkout?.with?.ref).toBeUndefined();
  });

  it('no step anywhere in the job references github.event.pull_request.head as a checkout ref', () => {
    const { text } = load();
    // The only permitted appearance of `.head` is `.head.sha`, read into the
    // HEAD_SHA env var for use as a plain SHA string (git show/fetch), never
    // as an actions/checkout `ref:` or any other execution surface.
    const headRefs = [...text.matchAll(/github\.event\.pull_request\.head(\.\w+)?/g)];
    expect(headRefs.length).toBeGreaterThan(0);
    for (const m of headRefs) {
      expect(m[1], `unexpected use of .head${m[1] ?? ''} — only .head.sha is permitted`).toBe(
        '.sha',
      );
    }
  });

  it('no step checks out or fetches the PR head into the working tree (git checkout/switch of the head ref)', () => {
    const { wf } = load();
    for (const step of wf.jobs[JOB].steps) {
      if (!step.run) continue;
      expect(step.run).not.toMatch(/git\s+(checkout|switch)\s+.*HEAD_SHA/);
    }
  });

  it('the head pin/diff reads are blob-only (git show / gh api), never a checkout', () => {
    const { wf } = load();
    const pinStep = wf.jobs[JOB].steps.find((s) => /Read the pin file/.test(s.name ?? ''));
    expect(pinStep, 'pin-read step not found').toBeTruthy();
    expect(String(pinStep?.run)).toContain('git show');
    expect(String(pinStep?.run)).not.toMatch(/git\s+(checkout|switch)/);
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

  it('the decide step invokes dependabot-published-bytes-pause.mjs with all four required flags', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) => /Decide whether to close/.test(s.name ?? ''));
    expect(String(step?.run)).toContain('dependabot-published-bytes-pause.mjs');
    expect(String(step?.run)).toContain('--changed-files-file changed-files.txt');
    expect(String(step?.run)).toContain('--base-pin-file base-pin.json');
    expect(String(step?.run)).toContain('--head-pin-file head-pin.json');
    expect(String(step?.run)).toContain('--merge-base-pin-file merge-base-pin.json');
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

  it('the API-list step reads REPO_FULL_NAME/PR_NUMBER from env, never ${{ }} inline in run:', () => {
    const { wf } = load();
    const step = wf.jobs[JOB].steps.find((s) =>
      /List the files this PR changed/.test(s.name ?? ''),
    );
    expect(step, 'API-list step not found').toBeTruthy();
    expect(String(step?.run)).toContain('${REPO_FULL_NAME}');
    expect(String(step?.run)).toContain('${PR_NUMBER}');
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

describe('the diff/pin-read steps precede the decide step, which precedes the close step', () => {
  it('ordering: checkout -> list changed files -> read pins -> decide -> close', () => {
    const { wf } = load();
    const steps = wf.jobs[JOB].steps;
    const listIdx = steps.findIndex((s) => /List the files this PR changed/.test(s.name ?? ''));
    const pinIdx = steps.findIndex((s) => /Read the pin file/.test(s.name ?? ''));
    const decideIdx = steps.findIndex((s) => /Decide whether to close/.test(s.name ?? ''));
    const closeIdx = steps.findIndex((s) => /Close the PR/.test(s.name ?? ''));
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(pinIdx).toBeGreaterThan(listIdx);
    expect(decideIdx).toBeGreaterThan(pinIdx);
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
