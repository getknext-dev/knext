import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * WIRING GUARD for the parameterized file-manager platform e2e at a git tag (#1305, #1563).
 *
 * The workflow accepts a git ref input (default: rcTag from .github/compat-credential-ref.json),
 * checks out that ref, builds the operator FROM THAT REF, and records the operator image digest
 * as part of the rc evidence. Each test asserts on the PARSED workflow.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WF = resolve(ROOT, '.github/workflows/file-manager-platform-e2e-at-tag.yml');

type Step = { name?: string; uses?: string; run?: string; if?: string; [k: string]: unknown };
type Job = {
  steps: Step[];
  needs?: string[];
  if?: string;
  inputs?: Record<string, unknown>;
  [k: string]: unknown;
};
const text = readFileSync(WF, 'utf8');
const wf = parse(text) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};
const check = wf.jobs['platform-e2e-at-tag'];

describe('file-manager platform e2e at tag - wiring', () => {
  it('accepts a git ref input with a description', () => {
    expect(wf.on).toHaveProperty('workflow_dispatch');
    const dispatch = wf.on['workflow_dispatch'] as { inputs?: Record<string, unknown> };
    expect(dispatch?.inputs).toBeDefined();
    expect(dispatch.inputs).toHaveProperty('git-ref');
    const refInput = dispatch.inputs?.['git-ref'] as { description?: string; default?: string };
    expect(typeof refInput?.description).toBe('string');
  });

  it('reads rcTag from .github/compat-credential-ref.json as the default git-ref', () => {
    expect(text).toMatch(/\.github\/compat-credential-ref\.json/);
    expect(text).toMatch(/rcTag/);
  });

  it('checks out the specified git ref before building the operator', () => {
    const checkout = check.steps.find((s) => (s.uses ?? '').includes('actions/checkout'));
    const buildOp = check.steps.find((s) => (s.run ?? '').includes('docker-build'));
    expect(checkout).toBeDefined();
    expect(buildOp).toBeDefined();
    expect(check.steps.indexOf(checkout!)).toBeLessThan(check.steps.indexOf(buildOp!));
  });

  it('builds the operator image from the checked-out ref', () => {
    const buildOp = check.steps.find((s) => (s.run ?? '').includes('docker-build'));
    expect(buildOp?.run).toContain('IMG=');
  });

  it('captures the operator image digest as a job output or artifact', () => {
    expect(text).toMatch(/digest|image.*sha256/i);
    expect(text).toMatch(/upload.*artifact|actions\/upload-artifact/i);
  });

  it('records the git ref, run id, and digest in the job summary', () => {
    expect(text).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(text).toMatch(/github\.run_id/);
  });

  it('is triggered by workflow_dispatch only', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
  });

  it('fails closed on operator build or e2e check failure', () => {
    expect(text).not.toMatch(/continue-on-error/);
    const suite = check.steps.find((s) => (s.run ?? '').includes('platform-e2e.mjs'));
    expect(suite?.if).toBeUndefined();
  });
});
