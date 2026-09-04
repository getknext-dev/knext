import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditBlockingGate } from './helpers/blocking-gate';

/**
 * #448 — the SIGTERM hardcap e2e has a hard-fail guard; this asserts it has
 * somewhere to fire.
 *
 * The e2e itself throws when `KNEXT_REQUIRE_BUN=1` and `bun` is absent, which is
 * the right shape. But it also carries `describe.skipIf(!bunAvailable)`, so in
 * any environment WITHOUT that env var it silently skips. Before the
 * `bun-exec-hardcap` job existed, no workflow ran `examples/bun-exec`'s tests at
 * all — so the guard was correct and completely inert, which is #408 item 2
 * verbatim ("the flag exists, CI never sets it") in a different subsystem.
 *
 * These assertions therefore guard the WIRING, not the behaviour: the job must
 * exist, must actually run the example's suite, must install bun, and must set
 * the env var that converts a missing `bun` from a skip into a failure. Deleting
 * that env var is a one-line edit that disarms the gate without reddening
 * anything else — this test is what makes that edit visible.
 *
 * The CONTENT assertions below read the job as TEXT — a SHA-pinned `uses:`, an
 * env var, a script name are all textual facts and stay trivially portable.
 * The "is this job actually blocking?" question is NOT textual and is no longer
 * asked that way: #661 measured three single-edit disarms that a text anchor
 * misses, so that half is parsed (`tests/helpers/blocking-gate.ts`). `yaml` is a
 * root dependency as of #653, so the reason the older convention gave for
 * avoiding a parse no longer holds.
 */

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const JOB_KEY = 'bun-exec-hardcap:';

/** The `bun-exec-hardcap` job's own lines, bounded by the next top-level job key. */
function jobBlock(): string {
  const raw = readFileSync(CI_YML, 'utf8');

  // Non-vacuity: if the file were unreadable or the workflow restructured, every
  // assertion below would pass by absence rather than by agreement.
  expect(raw.length, 'ci.yml is empty or unreadable').toBeGreaterThan(1000);
  expect(raw, 'ci.yml no longer looks like a workflow').toMatch(/^jobs:/m);

  const start = raw.indexOf(`  ${JOB_KEY}`);
  expect(start, `no ${JOB_KEY} job in ci.yml`).toBeGreaterThan(-1);

  const rest = raw.slice(start + JOB_KEY.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('bun-exec hardcap gate is wired into CI (#448)', () => {
  it('runs the example suite', () => {
    expect(jobBlock(), 'the job never runs the example test suite').toMatch(/bun run test|vitest/);
  });

  it('sets KNEXT_REQUIRE_BUN=1, so a missing bun FAILS instead of skipping', () => {
    // The whole point. Without it, a runner without `bun` skips the hardcap
    // suite and the job goes green having asserted nothing.
    expect(
      jobBlock(),
      'the suite runs WITHOUT KNEXT_REQUIRE_BUN=1 — a missing bun would skip, not fail',
    ).toMatch(/KNEXT_REQUIRE_BUN:\s*['"]?1['"]?/);
  });

  it('installs bun, since the guard turns a missing bun into a hard failure', () => {
    expect(
      jobBlock(),
      'the job never installs bun, so KNEXT_REQUIRE_BUN=1 would always throw',
    ).toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
  });

  it('runs unconditionally on a PR and its failure fails the run (#661)', () => {
    // PARSED, not text-matched. The text form of this assertion was a regex
    // anchored on four-space indentation plus `continue-on-error:\s*true`, and
    // #661 measured three single-edit disarms it let through with every
    // assertion in this file green: a quoted `"if":` key, `continue-on-error:
    // ${{ true }}`, and `needs:` on a job that can skip. Adding three more
    // patterns is the same defect one level up, so the audit asks the semantic
    // question of the parsed workflow and FAILS CLOSED on any job-level key it
    // does not recognise.
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'bun-exec-hardcap',
      gateCommand: /bun run test\b|vitest/,
    });
    // Non-vacuity: an audit that parsed nothing must not pass by finding no
    // problem to report.
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the suite').toBe(1);
    // The transitive `needs` closure that was actually walked. Asserting it is
    // what keeps `needs:` audited rather than merely reported: if this job grows
    // a dependency, this list changes and someone has to look at whether the new
    // upstream can skip.
    expect(audit.needsClosure, 'the `needs` closure the audit walked').toEqual([
      'bun-exec-hardcap',
    ]);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });
});
