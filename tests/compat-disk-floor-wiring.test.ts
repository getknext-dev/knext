import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the free-disk-floor guard's WORKFLOW WIRING (#1530), not just its
 * pure functions.
 *
 * WHY THIS FILE EXISTS
 * `tests/compat-disk-floor-check.test.ts` and
 * `scripts/mutation-prove-compat-disk-floor-check.mjs` prove
 * `evaluateDiskFloor` in isolation. Round-2 review found that none of the
 * existing coverage — including the 6 `compat-window-audit` provers and the
 * disqualifier-labelling tests — would notice if the WORKFLOW STOPPED CALLING
 * that function at all: an anchor-exact mutation of the live YAML that
 * (a) deleted the whole "Free disk floor" step, (b) deleted the skip branch
 * in the real test-run step (so the suite runs after a floor breach anyway),
 * or (c) deleted the early exit in the summarize step (so an empty-log
 * 0/0/0 parse overwrites the infra-classified summary the floor step wrote)
 * all left CI green. This file is the missing "guard green when its subject
 * is removed is decoration" check for that wiring — see
 * `scripts/mutation-prove-compat-disk-floor-wiring.mjs` for the anchor-exact,
 * byte-restored proof that each of the three checks below actually reds on
 * the mutation it targets.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

/**
 * The text of ONE step, from its `- name: <stepName>` line up to (but not
 * including) the next step at the same indentation (six spaces — the
 * `deploy-tests` job's step list). Throws if the name is missing or
 * ambiguous, so a rename that silently breaks this test is loud rather than
 * quietly scanning the wrong text.
 */
function stepBlock(text: string, stepName: string): string {
  const marker = `- name: ${stepName}`;
  const startIdx = text.indexOf(marker);
  if (startIdx === -1) {
    throw new Error(`compat-disk-floor-wiring: step not found: ${JSON.stringify(stepName)}`);
  }
  if (text.indexOf(marker, startIdx + 1) !== -1) {
    throw new Error(
      `compat-disk-floor-wiring: step name is not unique: ${JSON.stringify(stepName)}`,
    );
  }
  const lineStart = text.lastIndexOf('\n', startIdx) + 1;
  const nextStepIdx = text.indexOf('\n      - name:', startIdx);
  const end = nextStepIdx === -1 ? text.length : nextStepIdx;
  return text.slice(lineStart, end);
}

const DISK_FLOOR_STEP = 'Free disk floor (#1530)';
const RUN_TESTS_STEP = 'Run official deploy tests (knext adapter)';
const SUMMARIZE_STEP = 'Summarize shard result';
const BREACH_GUARD = /if \[ "\$\{\{ steps\.disk-floor\.outputs\.ok \}\}" = 'false' \]/;

describe('compat-disk-floor guard wiring (#1530) — the workflow, not just evaluateDiskFloor', () => {
  it('the disk-floor step exists and runs BEFORE the real test-run step', () => {
    const text = readWorkflow();
    const floorIdx = text.indexOf(`- name: ${DISK_FLOOR_STEP}`);
    const runIdx = text.indexOf(`- name: ${RUN_TESTS_STEP}`);
    expect(floorIdx, 'the "Free disk floor" step is missing from the workflow').toBeGreaterThan(-1);
    expect(runIdx, 'the "Run official deploy tests" step is missing').toBeGreaterThan(-1);
    expect(
      floorIdx,
      'the disk-floor step must run BEFORE the real test-run step (it is a precondition check)',
    ).toBeLessThan(runIdx);
  });

  it('the disk-floor step publishes its verdict as `id: disk-floor` / `outputs.ok`', () => {
    const block = stepBlock(readWorkflow(), DISK_FLOOR_STEP);
    expect(block, 'the step must be addressable as `steps.disk-floor`').toContain('id: disk-floor');
    expect(block, 'the step must publish its verdict to GITHUB_OUTPUT as `ok`').toMatch(
      /echo "ok=.*"\s*>>\s*"\$GITHUB_OUTPUT"/,
    );
  });

  it('the real test-run step SKIPS the suite on a breach — never runs it against a starved disk', () => {
    const block = stepBlock(readWorkflow(), RUN_TESTS_STEP);
    const guardIdx = block.search(BREACH_GUARD);
    const elseIdx = block.indexOf('else', guardIdx === -1 ? 0 : guardIdx);
    const runTestsIdx = block.indexOf('run-tests.js --type e2e');
    expect(guardIdx, 'no disk-floor breach guard found in the test-run step').toBeGreaterThan(-1);
    expect(elseIdx, 'the breach guard has no else branch to skip into').toBeGreaterThan(guardIdx);
    expect(runTestsIdx, 'the real run-tests.js invocation is missing').toBeGreaterThan(-1);
    expect(
      runTestsIdx,
      'run-tests.js must run inside the ELSE branch (after the guard), never unconditionally',
    ).toBeGreaterThan(elseIdx);
  });

  it('the summarize step exits early on a breach — never overwrites the infra summary with an empty-log parse', () => {
    const block = stepBlock(readWorkflow(), SUMMARIZE_STEP);
    const guardIdx = block.search(BREACH_GUARD);
    const exitIdx = block.indexOf('exit 0', guardIdx === -1 ? 0 : guardIdx);
    // The real invocation, not the doc comment ABOVE the guard that also
    // mentions `e2e-summary.mjs` in prose (that comment is what motivates the
    // guard, and it sits textually before the guard itself).
    const summaryIdx = block.indexOf('node scripts/e2e-summary.mjs');
    expect(guardIdx, 'no disk-floor breach guard found in the summarize step').toBeGreaterThan(-1);
    expect(
      exitIdx,
      'the breach guard must `exit 0` before running e2e-summary.mjs, or a breach gets clobbered',
    ).toBeGreaterThan(guardIdx);
    expect(summaryIdx, 'the e2e-summary.mjs invocation is missing').toBeGreaterThan(-1);
    expect(exitIdx, 'the early exit must precede the e2e-summary.mjs call textually').toBeLessThan(
      summaryIdx,
    );
  });
});
