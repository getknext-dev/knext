import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * rev-1382's ISSUES_FOUND round on the shipped-pin early-warning lane
 * (#1376 option b): 4 concrete defects, all in how the lane's 4-leg matrix
 * dispatches and identifies `test-e2e-deploy.yml` runs.
 *
 *   1. The lane cancelled its own runs — `test-e2e-deploy.yml`'s dispatch
 *      concurrency group is keyed on `<workflow>-dispatch-<ref>` alone, so 4
 *      legs dispatched within seconds of each other on the same ref (`main`)
 *      cancel one another, and also collide with any concurrent manual
 *      dispatch.
 *   2. `pickDispatchedRun` had no per-leg identity at all — "newest
 *      workflow_dispatch run not seen before" is a heuristic that every leg
 *      satisfies identically when they race, so all 4 legs could latch onto
 *      the SAME run and report a shared, wrong verdict for 3 of them.
 *   3. The tracking-issue alert ran once PER LEG (inside the matrix job),
 *      so a red night could file up to 4 duplicate issues.
 *   4. `MAX_WAIT_MS`'s default (90 min) equals the job's own
 *      `timeout-minutes` (90), so GitHub's hard job-timeout kills the step
 *      before the script's own deadline code path can run — the step is
 *      reported `cancelled`, not `failure`, and `if: failure()` never fires.
 *
 * Fix, in one sentence: give every dispatch a caller-supplied `dispatchId`
 * that becomes the dispatched run's OWN `run-name`, match on that EXACT
 * `displayTitle` with no recency fallback (covered by
 * `tests/compat-shipped-pin-dispatch-poll.test.ts`), key the concurrency
 * group on it too, move the alert to one job after the matrix, and give the
 * job's own timeout real headroom over the script's wait deadline.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const TEST_E2E_DEPLOY_PATH = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const EARLY_WARNING_WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github/workflows/compat-shipped-pin-early-warning.yml',
);
const DISPATCH_SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/compat-shipped-pin-dispatch-and-wait.mjs');

const testE2eDeployText = readFileSync(TEST_E2E_DEPLOY_PATH, 'utf8');
const testE2eDeployDoc = parseYaml(testE2eDeployText) as Record<string, unknown>;
const earlyWarningText = readFileSync(EARLY_WARNING_WORKFLOW_PATH, 'utf8');
const earlyWarningDoc = parseYaml(earlyWarningText) as Record<string, unknown>;

describe('finding 1+2 prerequisite — test-e2e-deploy.yml carries a dispatchId input and a run-name that carries it', () => {
  it('workflow_dispatch declares a `dispatchId` string input, optional, empty by default', () => {
    const inputs = (
      (testE2eDeployDoc.on as Record<string, unknown>)?.workflow_dispatch as {
        inputs?: Record<string, unknown>;
      }
    )?.inputs;
    expect(inputs, 'test-e2e-deploy.yml has no workflow_dispatch.inputs').toBeTruthy();
    const dispatchId = inputs?.dispatchId as
      | { required?: boolean; type?: string; default?: string }
      | undefined;
    expect(
      dispatchId,
      'test-e2e-deploy.yml has no `dispatchId` input (#1382 finding 1+2)',
    ).toBeTruthy();
    expect(dispatchId?.type).toBe('string');
    expect(dispatchId?.required).toBe(false);
    expect(dispatchId?.default).toBe('');
  });

  it('declares a top-level `run-name:` derived from the dispatchId input', () => {
    expect(
      'run-name' in testE2eDeployDoc,
      'test-e2e-deploy.yml has no `run-name:` — a caller cannot identify its own dispatched run by an exact title',
    ).toBe(true);
    const runName = String(testE2eDeployDoc['run-name']);
    expect(runName).toContain('github.event.inputs.dispatchId');
  });

  it('a run-name built from an UNSANITISED dispatchId cannot silently fall back to the workflow name on a real, non-empty id (self-test)', () => {
    // Guards against a run-name expression that LOOKS like it reads
    // dispatchId but actually always resolves to the constant workflow name
    // (e.g. a stray literal replacing the expression). Anchored on the
    // presence of the fallback operator alongside the input reference.
    const runName = String(testE2eDeployDoc['run-name']);
    expect(runName).toMatch(/\|\|/);
    expect(runName).toContain('github.workflow');
  });
});

describe('finding 1 — the dispatch concurrency group is keyed so 4 legs never cancel each other or a plain manual dispatch', () => {
  it('the concurrency group expression incorporates `github.event.inputs.dispatchId`', () => {
    const concurrency = testE2eDeployDoc.concurrency as { group?: unknown } | undefined;
    expect(concurrency?.group, 'test-e2e-deploy.yml has no concurrency.group').toBeTruthy();
    const group = String(concurrency?.group);
    expect(
      group,
      `concurrency group ${JSON.stringify(group)} does not reference dispatchId — a fast multi-leg fan-out on the same ref still collides`,
    ).toContain('github.event.inputs.dispatchId');
  });

  it('a plain dispatch (no dispatchId) still groups deterministically by ref, so repeat cancellation is preserved (self-test, not a regression)', () => {
    const concurrency = testE2eDeployDoc.concurrency as { group?: unknown } | undefined;
    const group = String(concurrency?.group);
    // The fallback branch must still be keyed on github.ref, exactly as
    // before this fix — a plain dispatch's own re-dispatch cancellation
    // behaviour must not silently disappear as a side effect of the
    // dispatchId fix.
    expect(group).toContain('github.ref');
  });
});

describe('finding 3 — the tracking-issue alert runs ONCE, not per-leg', () => {
  it("the early-warning workflow's alert job is a SEPARATE job, `needs:` the matrix job, not a step inside it", () => {
    const jobs = earlyWarningDoc.jobs as Record<string, { needs?: unknown; steps?: unknown[] }>;
    const matrixJobId = Object.keys(jobs).find((id) => {
      const job = jobs[id] as { strategy?: { matrix?: unknown } };
      return Boolean(job.strategy?.matrix);
    });
    expect(
      matrixJobId,
      'could not find the matrix job in compat-shipped-pin-early-warning.yml',
    ).toBeTruthy();

    const alertJobId = Object.keys(jobs).find(
      (id) =>
        id !== matrixJobId &&
        (jobs[id].steps ?? []).some(
          (s) =>
            typeof (s as { run?: string }).run === 'string' &&
            (s as { run: string }).run.includes('gh issue'),
        ),
    );
    expect(
      alertJobId,
      'the tracking-issue alert must live in its OWN job (single-fire), not a step inside the matrix job',
    ).toBeTruthy();

    const needs = jobs[alertJobId as string].needs;
    const needsList = Array.isArray(needs) ? needs : [needs];
    expect(
      needsList,
      `alert job ${alertJobId} must \`needs:\` the matrix job ${matrixJobId}`,
    ).toContain(matrixJobId);
  });

  it('the matrix job ITSELF carries no `gh issue create`/`gh issue comment` step (no per-leg alert)', () => {
    const jobs = earlyWarningDoc.jobs as Record<
      string,
      { strategy?: { matrix?: unknown }; steps?: unknown[] }
    >;
    const matrixJobId = Object.keys(jobs).find((id) => Boolean(jobs[id].strategy?.matrix));
    expect(matrixJobId).toBeTruthy();
    const matrixSteps = jobs[matrixJobId as string].steps ?? [];
    const alertSteps = matrixSteps.filter(
      (s) =>
        typeof (s as { run?: string }).run === 'string' &&
        (s as { run: string }).run.includes('gh issue'),
    );
    expect(
      alertSteps,
      'the matrix job still carries its own alert step — this fires once per leg (up to 4 duplicate issues)',
    ).toEqual([]);
  });
});

describe('finding 4 — the job timeout leaves real headroom over the script wait deadline', () => {
  it("the matrix job's timeout-minutes is strictly greater than the dispatch script's own MAX_WAIT_MS default", () => {
    const jobs = earlyWarningDoc.jobs as Record<
      string,
      { strategy?: { matrix?: unknown }; ['timeout-minutes']?: number }
    >;
    const matrixJobId = Object.keys(jobs).find((id) => Boolean(jobs[id].strategy?.matrix));
    expect(matrixJobId).toBeTruthy();
    const timeoutMinutes = jobs[matrixJobId as string]['timeout-minutes'];
    expect(typeof timeoutMinutes).toBe('number');

    const scriptText = readFileSync(DISPATCH_SCRIPT_PATH, 'utf8');
    const m = scriptText.match(/MAX_WAIT_MS\s*\?\?\s*(\d+)\s*\*\s*60_000/);
    expect(
      m,
      'could not find the MAX_WAIT_MS default expression in the dispatch script',
    ).toBeTruthy();
    const maxWaitMinutes = Number(m?.[1]);

    expect(
      (timeoutMinutes as number) > maxWaitMinutes,
      `job timeout-minutes (${timeoutMinutes}) must be strictly greater than MAX_WAIT_MS's default (${maxWaitMinutes} min) — equal or less means the job is hard-killed (status cancelled) before the script's own deadline path can exit 1, and \`if: failure()\` never fires`,
    ).toBe(true);
  });
});

describe('the dispatch script computes and passes a per-leg dispatchId, and the workflow supplies it', () => {
  it('the dispatch script reads a DISPATCH_ID env var and passes it as the `dispatchId` workflow input', () => {
    const scriptText = readFileSync(DISPATCH_SCRIPT_PATH, 'utf8');
    expect(scriptText).toContain('process.env.DISPATCH_ID');
    expect(scriptText).toContain('`dispatchId=${dispatchId}`');
  });

  it('the workflow computes DISPATCH_ID from the run id + matrix cell — unique per leg, per run', () => {
    const jobs = earlyWarningDoc.jobs as Record<
      string,
      { strategy?: { matrix?: unknown }; steps?: { env?: Record<string, unknown> }[] }
    >;
    const matrixJobId = Object.keys(jobs).find((id) => Boolean(jobs[id].strategy?.matrix));
    expect(matrixJobId).toBeTruthy();
    const dispatchStep = (jobs[matrixJobId as string].steps ?? []).find(
      (s) => s.env && 'DISPATCH_ID' in (s.env as Record<string, unknown>),
    );
    expect(dispatchStep, 'no step in the matrix job sets DISPATCH_ID').toBeTruthy();
    const value = String((dispatchStep?.env as Record<string, unknown>).DISPATCH_ID);
    expect(value).toContain('github.run_id');
    expect(value).toContain('matrix.runtime');
    expect(value).toContain('matrix.builder');
  });

  it('the pickDispatchedRun call in the script passes dispatchId through, matching what it dispatched', () => {
    // Paren-BALANCED extraction, not a `(...);`-bounded regex: the mutation
    // harness's residue marker can land between a mutated call's closing `)`
    // and the ORIGINAL `;` that followed it in source, swallowing the
    // semicolon into the comment and pushing a naive `\);`-terminated regex
    // past this call entirely, to whatever `);` happens to appear next in
    // the file — silently certifying a mutation that removed `dispatchId`
    // as caught. Balancing parens char-by-char from the call's own `(` is
    // immune to that: it never looks for a closing `;` at all, and it
    // handles the call spanning multiple lines (as it does once `await
    // listRecentRuns(repo)` is inlined as an argument).
    const scriptText = readFileSync(DISPATCH_SCRIPT_PATH, 'utf8');
    const sigIdx = scriptText.indexOf('pickDispatchedRun(');
    expect(sigIdx, 'could not find a pickDispatchedRun( call site').toBeGreaterThan(-1);
    const openIdx = sigIdx + 'pickDispatchedRun'.length;
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < scriptText.length; i++) {
      if (scriptText[i] === '(') depth++;
      else if (scriptText[i] === ')') {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    expect(closeIdx, 'could not balance the pickDispatchedRun(...) call').toBeGreaterThan(-1);
    const call = scriptText.slice(sigIdx, closeIdx + 1);
    expect(call).toContain('dispatchId');
  });
});
