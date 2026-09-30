import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * WIRING GUARD for the nightly file-manager platform e2e caller (#1282,
 * #1305/#1563 round 2). This workflow is now a THIN caller of the shared
 * reusable implementation (file-manager-platform-e2e.yml) — the step-level
 * assertions (self-test ordering, deploy-through-CLI, image pinning, secrets,
 * checksum-verified applies…) live against that shared file now, in
 * tests/file-manager-platform-e2e-reusable-workflow.test.ts, since that is
 * the file whose body those checks actually describe. This file asserts only
 * what is specific to the nightly CALLER: its triggers, that it invokes the
 * shared implementation with the right inputs, and the red-alert wiring.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WF = resolve(ROOT, '.github/workflows/file-manager-platform-e2e-nightly.yml');

type Job = {
  uses?: string;
  with?: Record<string, unknown>;
  needs?: string[];
  if?: string;
  steps?: unknown[];
  [k: string]: unknown;
};
const text = readFileSync(WF, 'utf8');
const wf = parse(text) as { on: Record<string, unknown>; jobs: Record<string, Job> };
const check = wf.jobs['platform-e2e'];
const alert = wf.jobs['nightly-red-alert'];

describe('file-manager platform e2e nightly - wiring', () => {
  it('triggers on schedule + workflow_dispatch ONLY', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('calls the shared reusable implementation - it does not re-implement the suite itself', () => {
    expect(check.uses).toBe('./.github/workflows/file-manager-platform-e2e.yml');
    expect(check.steps).toBeUndefined();
  });

  it('runs the shared implementation against THIS commit (github.sha), unchanged nightly behaviour', () => {
    expect(check.with?.ref).toBe('${{ github.sha }}');
  });

  it('the red alert is schedule-only and keyed on the check job FAILING', () => {
    expect(alert.needs).toEqual(['platform-e2e']);
    expect(String(alert.if)).toContain("github.event_name == 'schedule'");
    expect(String(alert.if)).toContain("needs.platform-e2e.result == 'failure'");
    // A hung run hits the job timeout and reports `cancelled`, not `failure`.
    expect(String(alert.if)).toContain("needs.platform-e2e.result == 'cancelled'");
  });

  it('the alert job is fail-closed: no continue-on-error anywhere', () => {
    expect(text).not.toMatch(/continue-on-error/);
  });

  it('every third-party action this file itself uses is pinned by 40-hex SHA with a version comment', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)].filter(
      ([, ref]) => !ref.startsWith('./'),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/);
      expect(rest).toMatch(/#\s*v\d/);
    }
  });

  it('states a budget: a documented expectation', () => {
    expect(text).toMatch(/BUDGET:/);
  });
});
