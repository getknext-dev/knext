/**
 * #309 round 2 — the real-bun proof must have somewhere to run.
 *
 * `packages/kn-next/src/__tests__/compile-cache-health-bun.test.ts` hard-fails
 * when `KNEXT_REQUIRE_BUN=1` and `bun` is absent, and skips its bun half
 * otherwise. The `Lint & Test` runner has no bun, so without a job that
 * installs bun AND sets that flag, the whole proof is green-by-skip in CI —
 * #408 item 2 verbatim ("the flag exists, CI never sets it"), which is what the
 * sibling guard `bun-exec-hardcap-ci.test.ts` exists for in another subsystem.
 *
 * These assertions guard the WIRING, not the behaviour.
 *
 * The CONTENT half is read as TEXT — a SHA-pinned `uses:`, an env var, a test
 * path are all textual facts. The "is this job actually blocking?" half is NOT
 * textual and is no longer asked that way (#672): #661 measured four single-edit
 * disarms a text anchor misses, and this file was GREEN under all four of them
 * (`"if": false`, `'if': false`, `continue-on-error: ${{ true }}`, `needs:` on a
 * skippable job) plus a job-level `strategy:`. That half now goes through the
 * parsed audit in `tests/helpers/blocking-gate.ts`, which reads KEYS and fails
 * closed on any job-level key it does not recognise. `yaml` is a root dependency
 * as of #653, so the older "no root yaml dependency" convention no longer has
 * its reason.
 *
 * `scripts/mutation-prove-ci-blocking-gates.mjs` is the standing proof that the
 * conversion bit: it disarms this job five ways and requires this file to red.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditBlockingGate } from './helpers/blocking-gate';

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const JOB_KEY = 'compile-cache-bun-probe:';
const TEST_PATH = 'packages/kn-next/src/__tests__/compile-cache-health-bun.test.ts';

/** The job's own lines, bounded by the next top-level job key. */
function jobBlock(): string {
  const raw = readFileSync(CI_YML, 'utf8');

  // Non-vacuity: an unreadable or restructured workflow must fail loudly rather
  // than let every assertion below pass by absence.
  expect(raw.length, 'ci.yml is empty or unreadable').toBeGreaterThan(1000);
  expect(raw, 'ci.yml no longer looks like a workflow').toMatch(/^jobs:/m);

  const start = raw.indexOf(`  ${JOB_KEY}`);
  expect(start, `no ${JOB_KEY} job in ci.yml`).toBeGreaterThan(-1);

  const rest = raw.slice(start + JOB_KEY.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the real-bun compile-cache probe is wired into CI (#309)', () => {
  it('runs the bun probe suite by path', () => {
    // By PATH, not by a directory: the file is inside packages/, which the main
    // suite also runs, so "vitest" alone would not tell us this job runs THIS
    // file. Renaming or moving the test without updating the job reds here.
    expect(jobBlock(), 'the job never runs the bun probe test file').toContain(TEST_PATH);
  });

  it('sets KNEXT_REQUIRE_BUN=1, so a missing bun FAILS instead of skipping', () => {
    expect(
      jobBlock(),
      'the probe runs WITHOUT KNEXT_REQUIRE_BUN=1 — a missing bun would skip, not fail',
    ).toMatch(/KNEXT_REQUIRE_BUN:\s*['"]?1['"]?/);
  });

  it('installs bun, since the flag turns a missing bun into a hard failure', () => {
    expect(jobBlock(), 'the job never installs bun').toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/);
  });

  it('installs the workspace, since the probe runs under the repo vitest', () => {
    expect(jobBlock(), 'the job never installs workspace dependencies').toMatch(/bun install/);
  });

  it('runs unconditionally on a PR and its failure fails the run (#661)', () => {
    // PARSED, not text-matched — see the header. The predecessor of this
    // assertion was `not.toMatch(/continue-on-error:\s*true/)` over the job's
    // lines, and it stayed green under every measured disarm.
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'compile-cache-bun-probe',
      gateCommand: /compile-cache-health-bun\.test\.ts/,
    });
    // Non-vacuity: an audit that parsed nothing must not pass by finding no
    // problem to report.
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the probe').toBe(1);
    // The transitive `needs` closure that was actually walked. Asserting it is
    // what keeps `needs:` audited rather than merely reported: if this job grows
    // a dependency, this list changes and someone has to look at whether the new
    // upstream can skip.
    expect(audit.needsClosure, 'the `needs` closure the audit walked').toEqual([
      'compile-cache-bun-probe',
    ]);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });

  it('the test file it points at really exists', () => {
    // The other half of the scan: a job referencing a deleted path would satisfy
    // every string assertion above while running nothing.
    expect(() => readFileSync(resolve(REPO_ROOT, TEST_PATH), 'utf8')).not.toThrow();
  });
});
