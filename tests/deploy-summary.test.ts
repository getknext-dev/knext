import { describe, expect, it } from 'vitest';
// The summary generator exposes a pure parse function so it is unit-testable
// without invoking the workflow. It turns raw `run-tests.js` stdout into the
// machine-readable summary the compat-matrix publisher (#41) consumes.
import { summarize } from '../scripts/e2e-summary.mjs';

/**
 * Contract test for scripts/e2e-summary.mjs (#89, ADR-0007 A3-2 / unblocks #41).
 *
 * The official harness (`node run-tests.js --type e2e`) prints jest-style tallies.
 * `summarize()` must reduce that noisy output + the run metadata into the exact
 * artifact shape the matrix publisher expects: {passed, failed, excluded, ref, shard}.
 */

// A representative slice of `run-tests.js` stdout (jest reporter summary lines).
const SAMPLE_RUNNER_OUTPUT = `
  ● Test suite failed to run
Tests:       3 failed, 41 passed, 2 skipped, 46 total
Test Suites: 1 failed, 12 passed, 13 total
Time:        612.34 s
Ran all test suites.
`;

describe('scripts/e2e-summary.mjs — summarize() (#89)', () => {
  it('extracts passed/failed counts from jest-style "Tests:" line', () => {
    const s = summarize(SAMPLE_RUNNER_OUTPUT, { ref: 'v16.0.3', shard: '1/4', excluded: 7 });
    expect(s.passed).toBe(41);
    expect(s.failed).toBe(3);
  });

  it('carries through ref, shard, and excluded metadata', () => {
    const s = summarize(SAMPLE_RUNNER_OUTPUT, { ref: 'v16.0.3', shard: '1/4', excluded: 7 });
    expect(s.ref).toBe('v16.0.3');
    expect(s.shard).toBe('1/4');
    expect(s.excluded).toBe(7);
  });

  it('produces a fully-shaped, JSON-serializable summary object', () => {
    const s = summarize(SAMPLE_RUNNER_OUTPUT, { ref: 'v16.0.3', shard: '1/4', excluded: 7 });
    expect(Object.keys(s).sort()).toEqual(
      ['excluded', 'failed', 'notRun', 'passed', 'ref', 'shard'].sort(),
    );
    // round-trips through JSON (it's an artifact)
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('defaults counts to 0 when the runner output has no recognizable tally', () => {
    const s = summarize('no tests ran at all\n', { ref: 'v16.0.3', shard: '2/4', excluded: 0 });
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.excluded).toBe(0);
  });

  it('treats a missing failed-count (all green) as 0 failures', () => {
    const allGreen = 'Tests:       46 passed, 46 total\n';
    const s = summarize(allGreen, { ref: 'v16.0.3', shard: '3/4', excluded: 5 });
    expect(s.passed).toBe(46);
    expect(s.failed).toBe(0);
  });

  it('coerces a non-numeric excluded value to 0 (artifact stays well-typed)', () => {
    // CI passes --excluded as a string arg; a bad value must not poison the artifact.
    const s = summarize('Tests: 1 passed, 1 total\n', {
      ref: 'v16.0.3',
      shard: '4/4',
      // @ts-expect-error intentionally malformed input from the CLI boundary
      excluded: 'not-a-number',
    });
    expect(s.excluded).toBe(0);
    expect(Number.isNaN(s.excluded)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3-3 (#147): in NEXT_TEST_MODE=deploy the aggregate harness is `run-tests.js`,
// NOT jest's default reporter — so the jest-style `Tests: N passed, N failed`
// tally line is NEVER emitted. Instead run-tests.js prints PER-FILE result lines:
//   pass:  "<file> finished on retry <i>/<n> in <t>s"   (run-tests.js:676)
//   fail:  "<file> failed to pass within <n> retries"   (run-tests.js:703)
// The earlier parser only matched the jest tally, so a shard where a real deploy
// test FAILED (build/SWC error → "failed with code: 1") was summarized as
// {passed:0,failed:0} — a false-green. summarize() must count the run-tests.js
// per-file markers so real outcomes are honestly tallied (passed+failed > 0).
// ─────────────────────────────────────────────────────────────────────────────

// A faithful slice of real run-tests.js deploy-mode stdout (run 28317087611):
// one test that failed all retries (build SWC load failure), plus the run-tests.js
// abort line. There is NO jest "Tests:" summary line anywhere.
const SAMPLE_DEPLOY_RUNNER_OUTPUT = `
total: 179
Starting test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts retry 0/2
❌ test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts output:
 ⨯ Failed to load SWC binary for linux/x64
Starting test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts retry 1/2
Starting test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts retry 2/2
test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts failed due to Error: failed with code: 1
test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts failed to pass within 2 retries
exiting with code 1
`;

// A mixed run-tests.js slice in the REAL v16.0.3 output format: two distinct
// files PASS, one FAILS. The pass line is run-tests.js:727 verbatim —
//   `Finished ${test.file} on retry ${i}/${n} in ${t}s`
// i.e. the literal word "Finished" comes FIRST (capitalized), THEN the file path.
// (An earlier version of this fixture fabricated a file-first "… finished on
// retry …" line to match a buggy regex — that masked a real pass-path bug. The
// strings below are copied from run-tests.js source, NOT reverse-engineered.)
// One file (app-action-export) passes only on its 2nd retry to exercise de-dup.
const SAMPLE_DEPLOY_MIXED_OUTPUT = `
total: 179
Starting test/e2e/404-page-router/index.test.ts retry 0/2
Finished test/e2e/404-page-router/index.test.ts on retry 0/2 in 12.3s
Starting test/e2e/app-dir/actions/app-action-export.test.ts retry 0/2
Starting test/e2e/app-dir/actions/app-action-export.test.ts retry 1/2
Finished test/e2e/app-dir/actions/app-action-export.test.ts on retry 1/2 in 8.1s
Starting test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts retry 0/2
Starting test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts retry 1/2
Starting test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts retry 2/2
test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts failed to pass within 2 retries
exiting with code 1
`;

// An all-pass run-tests.js slice (real format) — proves the pass path counts.
const SAMPLE_DEPLOY_ALL_PASS_OUTPUT = `
total: 2
Starting test/e2e/404-page-router/index.test.ts retry 0/2
Finished test/e2e/404-page-router/index.test.ts on retry 0/2 in 5.0s
Starting test/e2e/app-dir/actions/app-action-export.test.ts retry 0/2
Finished test/e2e/app-dir/actions/app-action-export.test.ts on retry 0/2 in 3.2s
exiting with code 0
`;

describe('scripts/e2e-summary.mjs — run-tests.js deploy-mode parsing (A3-3, #147)', () => {
  it('counts a deploy test that failed all retries as failed>0 (no false-green)', () => {
    const s = summarize(SAMPLE_DEPLOY_RUNNER_OUTPUT, {
      ref: 'v16.0.3',
      shard: '1/4',
      excluded: 32,
    });
    // The whole point of A3-3: a "failed with code: 1" test MUST be counted.
    expect(s.failed).toBe(1);
    expect(s.passed).toBe(0);
    expect(s.passed + s.failed).toBeGreaterThan(0);
  });

  it('counts run-tests.js per-file PASS + FAIL markers in the real format (mixed shard)', () => {
    const s = summarize(SAMPLE_DEPLOY_MIXED_OUTPUT, {
      ref: 'v16.0.3',
      shard: '2/4',
      excluded: 32,
    });
    // Real run-tests.js "Finished <file> on retry …" passes + the "failed to pass
    // within …" failure must BOTH be counted — passed>0 AND failed>0.
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.passed).toBeGreaterThan(0);
    expect(s.failed).toBeGreaterThan(0);
  });

  it('counts an all-pass shard from the real "Finished <file>" format', () => {
    const s = summarize(SAMPLE_DEPLOY_ALL_PASS_OUTPUT, {
      ref: 'v16.0.3',
      shard: '3/4',
      excluded: 0,
    });
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(0);
  });

  it('counts each test FILE once, not once per retry line (pass + fail)', () => {
    // The failing file emits 3 "Starting … retry" lines but is ONE failure; the
    // app-action-export file emits 2 "Starting" lines + one "Finished" = ONE pass.
    const fail = summarize(SAMPLE_DEPLOY_RUNNER_OUTPUT, {
      ref: 'v16.0.3',
      shard: '1/4',
      excluded: 0,
    });
    expect(fail.failed).toBe(1);
    const mixed = summarize(SAMPLE_DEPLOY_MIXED_OUTPUT, {
      ref: 'v16.0.3',
      shard: '2/4',
      excluded: 0,
    });
    // app-action-export retried then passed → still exactly one pass, not two.
    expect(mixed.passed).toBe(2);
  });

  it('does NOT count a file-first "… finished on retry …" line (regex must match the REAL format)', () => {
    // Regression guard: the bug was a file-first, lowercase-"finished" pass regex.
    // run-tests.js@v16.0.3 NEVER emits "<file> finished on retry …" — it emits
    // "Finished <file> on retry …". A fixture in the OLD (wrong) shape must count
    // as 0 passes, proving the parser is keyed on real output, not the fabrication.
    const fabricatedFileFirst = `
Starting test/e2e/x/x.test.ts retry 0/2
test/e2e/x/x.test.ts finished on retry 0/2 in 1.0s
exiting with code 0
`;
    const s = summarize(fabricatedFileFirst, { ref: 'v16.0.3', shard: '1/4', excluded: 0 });
    expect(s.passed).toBe(0);
  });

  it('still parses the jest-style tally when run-tests.js does emit one', () => {
    // Backward-compat: the jest "Tests:" path must keep working.
    const s = summarize(SAMPLE_RUNNER_OUTPUT, { ref: 'v16.0.3', shard: '1/4', excluded: 7 });
    expect(s.passed).toBe(41);
    expect(s.failed).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3-3 (#147, run 28317739829): the INVERSE false-RED. A jest INFRA ABORT — jest
// could not LOCATE the selected test file, prints `No tests found, exiting with
// code 1`, run-tests.js retries, gives up, and prints the SAME `<file> failed to
// pass within N retries` a genuine assertion failure prints. The parser must NOT
// count that phantom as `failed` (the test never ran: no `next build`, no server
// boot, no assertion). It surfaces it as a distinct `notRun` counter instead.
//
// This is the EXACT shape of every shard in run 28317739829: 5 selected files,
// each aborting with "No tests found" → the old parser reported failed:5, a
// misleading false-RED implying knext adapter gaps that do not exist.
// ─────────────────────────────────────────────────────────────────────────────

// A faithful slice of run 28317739829 shard stdout: run-tests.js scopes each
// file's output under a `❌ <file> output` group, jest prints `No tests found,
// exiting with code 1` inside it, then run-tests.js prints the same failure lines
// a real failure would. NO `next build`, no server boot, no assertion ever ran.
const SAMPLE_DEPLOY_PHANTOM_ABORT_OUTPUT = `
total: 2
Starting test/e2e/404-page-router/index.test.ts retry 0/2
##[group]❌ test/e2e/404-page-router/index.test.ts output
HEADLESS=true ... /next.js/node_modules/.bin/jest '--ci' '--runInBand' '--forceExit' '--verbose' 'test/e2e/404-page-router/index.test.ts'
No tests found, exiting with code 1
In /home/runner/work/knext/knext/next.js/test
  13883 files checked.
Pattern: test/e2e/404-page-router/index.test.ts - 0 matches
Starting test/e2e/404-page-router/index.test.ts retry 1/2
Starting test/e2e/404-page-router/index.test.ts retry 2/2
test/e2e/404-page-router/index.test.ts failed due to Error: failed with code: 1
test/e2e/404-page-router/index.test.ts failed to pass within 2 retries
exiting with code 1
`;

// A MIXED slice: one file is a phantom infra-abort (No tests found), one file
// genuinely RAN (next build executed) and FAILED an assertion (no "No tests
// found" in its group). Only the latter is a real `failed`; the former is `notRun`.
const SAMPLE_DEPLOY_PHANTOM_AND_REAL_OUTPUT = `
total: 2
Starting test/e2e/404-page-router/index.test.ts retry 0/2
##[group]❌ test/e2e/404-page-router/index.test.ts output
[e2e-deploy] running next build
No tests found, exiting with code 1
Pattern: test/e2e/404-page-router/index.test.ts - 0 matches
test/e2e/404-page-router/index.test.ts failed to pass within 2 retries
Starting test/e2e/image-optimizer/index.test.ts retry 0/2
##[group]❌ test/e2e/image-optimizer/index.test.ts output
[e2e-deploy] running next build
[e2e-deploy] booting server
  ● image optimizer › serves webp
    expect(received).toBe(expected)
test/e2e/image-optimizer/index.test.ts failed to pass within 2 retries
exiting with code 1
`;

describe('scripts/e2e-summary.mjs — phantom infra-abort vs real failure (A3-3, #147)', () => {
  it('does NOT count a "No tests found" infra-abort as a real failure', () => {
    const s = summarize(SAMPLE_DEPLOY_PHANTOM_ABORT_OUTPUT, {
      ref: 'v16.0.3',
      shard: '1/4',
      excluded: 32,
    });
    // The whole point: a never-ran phantom must NOT be `failed` (false-RED).
    expect(s.failed).toBe(0);
    expect(s.passed).toBe(0);
  });

  it('surfaces the phantom abort under a distinct notRun counter', () => {
    const s = summarize(SAMPLE_DEPLOY_PHANTOM_ABORT_OUTPUT, {
      ref: 'v16.0.3',
      shard: '1/4',
      excluded: 32,
    });
    expect(s.notRun).toBe(1);
  });

  it('counts a REAL assertion failure as failed but the phantom as notRun (mixed shard)', () => {
    const s = summarize(SAMPLE_DEPLOY_PHANTOM_AND_REAL_OUTPUT, {
      ref: 'v16.0.3',
      shard: '2/4',
      excluded: 0,
    });
    // image-optimizer genuinely ran (next build + server boot) and failed an
    // assertion → 1 real failure. 404-page-router never ran (No tests found) →
    // 1 notRun, NOT a failure.
    expect(s.failed).toBe(1);
    expect(s.notRun).toBe(1);
    expect(s.passed).toBe(0);
  });

  it('does NOT classify a genuine "failed to pass within" (no No-tests-found) as notRun', () => {
    // The existing real-failure fixture has NO "No tests found" line, so it must
    // stay a real failure with notRun:0 — the phantom detector must not over-reach.
    const s = summarize(SAMPLE_DEPLOY_RUNNER_OUTPUT, {
      ref: 'v16.0.3',
      shard: '1/4',
      excluded: 0,
    });
    expect(s.failed).toBe(1);
    expect(s.notRun).toBe(0);
  });

  it('always includes a numeric notRun field in the artifact shape', () => {
    const s = summarize(SAMPLE_DEPLOY_ALL_PASS_OUTPUT, {
      ref: 'v16.0.3',
      shard: '3/4',
      excluded: 0,
    });
    expect(Object.keys(s).sort()).toEqual(
      ['excluded', 'failed', 'notRun', 'passed', 'ref', 'shard'].sort(),
    );
    expect(typeof s.notRun).toBe('number');
    expect(s.notRun).toBe(0);
  });
});
