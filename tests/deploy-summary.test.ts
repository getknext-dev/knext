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
      ['excluded', 'failed', 'notRun', 'passed', 'ref', 'runtime', 'shard'].sort(),
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

  it('counts the v16.2.0 file-first "<file> finished on retry …" pass format', () => {
    // GROUND TRUTH UPDATE (A3-3 triage, run 28552585087 → harness ref bump):
    // run-tests.js CHANGED its pass marker between the two refs we have run:
    //   v16.0.3:  `Finished ${test.file} on retry ${i}/${n} in ${t}s`  ("Finished" first)
    //   v16.2.0:  `${test.file} finished on retry ${i}/${n} in ${t}s` (file first,
    //             lowercase "finished" — run-tests.js@v16.2.0:708-710, verbatim)
    // An earlier guard here asserted the file-first form must NOT count, because at
    // v16.0.3 it was a fabrication. At v16.2.0 it is the REAL format — a parser that
    // ignores it reports passed:0 for a green shard (a false-red / vacuous summary).
    const v1620FileFirst = `
Starting test/e2e/x/x.test.ts retry 0/2
test/e2e/x/x.test.ts finished on retry 0/2 in 1.0s
exiting with code 0
`;
    const s = summarize(v1620FileFirst, { ref: 'v16.2.0', shard: '1/16', excluded: 0 });
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(0);
  });

  it('counts a file seen in BOTH pass formats exactly once (cross-format de-dup)', () => {
    // Defensive: a mixed log (e.g. a ref bump mid-investigation, or tee'd reruns)
    // must not double-count one file that appears in both marker shapes.
    const bothFormats = `
Finished test/e2e/x/x.test.ts on retry 0/2 in 1.0s
test/e2e/x/x.test.ts finished on retry 0/2 in 1.0s
exiting with code 0
`;
    const s = summarize(bothFormats, { ref: 'v16.2.0', shard: '1/16', excluded: 0 });
    expect(s.passed).toBe(1);
  });

  it('does NOT count a non-marker line that merely contains "finished" (no "on retry")', () => {
    // The pass markers (both refs) always carry the `on retry <i>/<n>` suffix from
    // run-tests.js's template literal. Arbitrary prose mentioning a test file and
    // "finished" (e.g. an app's own log line) must not be tallied.
    const prose = `
build finished for test/e2e/x/x.test.ts in 1.0s
test/e2e/x/x.test.ts finished quickly
exiting with code 0
`;
    const s = summarize(prose, { ref: 'v16.2.0', shard: '1/16', excluded: 0 });
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
    // The run-tests.js log carries the `total:` selection header, so the
    // truncation-marker keys (#171 follow-up) are part of this shape too.
    expect(Object.keys(s).sort()).toEqual(
      [
        'excluded',
        'expectedTotal',
        'failed',
        'notRun',
        'passed',
        'ref',
        'runtime',
        'shard',
        'truncated',
      ].sort(),
    );
    expect(typeof s.notRun).toBe('number');
    expect(s.notRun).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #171 sys-design follow-up — the TRUNCATION marker. A shard KILLED mid-run
// (job/step timeout, runner eviction) reports the partial results its tee'd
// runner.log accumulated — indistinguishable from a complete run: {passed: 20,
// failed: 0} looks green even when 25 more selected tests never got to report.
// run-tests.js prints its selected-test count as a `total: N` header at run
// start (present verbatim in every faithful fixture above), so the summary can
// carry `expectedTotal` and flag `truncated: true` whenever fewer results than
// expected were tallied. The fail-on-red gate then fails on truncated — partial
// results are never green.
// ─────────────────────────────────────────────────────────────────────────────

describe('summarize() truncation marker (#171 sys-design follow-up)', () => {
  it('derives expectedTotal from the run-tests.js `total:` header; a fully-reported shard is truncated:false', () => {
    const s = summarize(SAMPLE_DEPLOY_ALL_PASS_OUTPUT, {
      ref: 'v16.2.0',
      shard: '3/16',
      excluded: 0,
    });
    expect(s.expectedTotal).toBe(2);
    expect(s.truncated).toBe(false);
  });

  it('flags truncated:true when fewer results than expectedTotal were reported (shard killed mid-run)', () => {
    // 3 selected, but the log ends after ONE pass marker — the other two files
    // never reported (the exact shape a step-timeout kill leaves behind).
    const killedMidRun = `
total: 3
Starting test/e2e/a/a.test.ts retry 0/2
test/e2e/a/a.test.ts finished on retry 0/2 in 1.0s
Starting test/e2e/b/b.test.ts retry 0/2
`;
    const s = summarize(killedMidRun, { ref: 'v16.2.0', shard: '1/16', excluded: 0 });
    expect(s.passed).toBe(1);
    expect(s.expectedTotal).toBe(3);
    expect(s.truncated).toBe(true);
  });

  it('counts failed AND notRun toward the expected total (a fully-reported red shard is NOT truncated)', () => {
    // total: 2 → 1 real failure + 1 phantom notRun = fully accounted for.
    const s = summarize(SAMPLE_DEPLOY_PHANTOM_AND_REAL_OUTPUT, {
      ref: 'v16.2.0',
      shard: '2/16',
      excluded: 0,
    });
    expect(s.failed).toBe(1);
    expect(s.notRun).toBe(1);
    expect(s.expectedTotal).toBe(2);
    expect(s.truncated).toBe(false);
  });

  it('omits expectedTotal/truncated when no selection count is derivable (per-suite jest runs)', () => {
    // The jest-tally path (per-suite runs, #164) has no run-tests.js `total:`
    // header — the artifact shape for those consumers stays byte-stable.
    const s = summarize(SAMPLE_RUNNER_OUTPUT, { ref: 'v16.2.0', shard: '1/16', excluded: 0 });
    expect(Object.keys(s)).not.toContain('expectedTotal');
    expect(Object.keys(s)).not.toContain('truncated');
  });

  it('honors an explicit meta.expectedTotal override (CLI --expected-total) over the log header', () => {
    const s = summarize(SAMPLE_DEPLOY_ALL_PASS_OUTPUT, {
      ref: 'v16.2.0',
      shard: '3/16',
      excluded: 0,
      expectedTotal: 5,
    });
    expect(s.expectedTotal).toBe(5);
    expect(s.truncated).toBe(true);
  });

  it('an EMPTY runner log with a known expectedTotal is truncated (a vanished shard is never green)', () => {
    const s = summarize('', { ref: 'v16.2.0', shard: '1/16', excluded: 0, expectedTotal: 10 });
    expect(s.expectedTotal).toBe(10);
    expect(s.truncated).toBe(true);
  });

  it('coerces a malformed expectedTotal override to absent (artifact stays well-typed)', () => {
    const s = summarize('no total header here\n', {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
      // @ts-expect-error intentionally malformed input from the CLI boundary
      expectedTotal: 'not-a-number',
    });
    expect(Object.keys(s)).not.toContain('expectedTotal');
    expect(Object.keys(s)).not.toContain('truncated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3-3 (#147, run 28318485456 — the GROUND-TRUTH fixture). The prior phantom
// detector FAILED on the REAL shard log and still reported {failed:1,notRun:0}.
// Two real-world properties of the actual run-tests.js deploy stdout broke it,
// NEITHER of which the synthetic fixtures above exercised:
//
//  (1) The jest invocation echo prints `JEST_JUNIT_OUTPUT_NAME=<file>` where the
//      file path is the UNDERSCORE-joined form (run-tests.js:555,
//      `test.file.replaceAll('/', '_')`), e.g.
//        JEST_JUNIT_OUTPUT_NAME=test_e2e_404-page-router_index.test.ts
//      A naive `\S*\.test\.\w+` scope regex captures THAT underscore form as the
//      "current file" — which never equals the SLASH-form key the
//      `<file> failed to pass within N retries` marker uses, so the phantom set and
//      the failure set never intersect → the phantom is mis-counted as `failed`.
//
//  (2) run-tests.js runs the shard CONCURRENTLY, so two files' output INTERLEAVES
//      (`Starting A`, `Starting B`, then A's `❌ … output` group, then B's). Scope
//      must follow run-tests.js's OWN group boundaries (`❌ <file> output` …
//      `end of <file> output`), inside which a file's `No tests found` always sits,
//      rather than the last-seen `.test.` token on any line.
//
// This fixture is a faithful, de-timestamped slice of run 28318485456 shard 1/4:
// two files, both phantom infra-aborts (jest `No tests found`), interleaved, WITH
// the underscore JEST_JUNIT echo line. The fix must surface BOTH as notRun, 0 fail.
const SAMPLE_DEPLOY_REAL_INTERLEAVED_PHANTOM = `
total: 179
Starting test/e2e/404-page-router/index.test.ts retry 0/2
Starting test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts retry 0/2
❌ test/e2e/404-page-router/index.test.ts output:
HEADLESS=true NEXT_TELEMETRY_DISABLED=1 CI= JEST_JUNIT_OUTPUT_NAME=test_e2e_404-page-router_index.test.ts JEST_SUITE_NAME=deploy:1/4:e2e:test/e2e/404-page-router/index.test.ts /next.js/node_modules/.bin/jest '--ci' '--runInBand' '--forceExit' '--verbose' 'test/e2e/404-page-router/index.test.ts'
No tests found, exiting with code 1
In /home/runner/work/knext/knext/next.js
  1706 files checked.
  testMatch: **/*.test.js, **/*.test.ts, **/*.test.jsx, **/*.test.tsx - 1706 matches
Pattern: test/e2e/404-page-router/index.test.ts - 0 matches
end of test/e2e/404-page-router/index.test.ts output
##[group]❌ test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts output
HEADLESS=true JEST_JUNIT_OUTPUT_NAME=test_e2e_app-dir_actions-allowed-origins_app-action-allowed-origins.test.ts JEST_SUITE_NAME=deploy:1/4:e2e:test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts /next.js/node_modules/.bin/jest '--ci' '--runInBand' '--forceExit' '--verbose' 'test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts'
No tests found, exiting with code 1
Pattern: test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts - 0 matches
end of test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts output
Starting test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts retry 1/2
Starting test/e2e/404-page-router/index.test.ts retry 1/2
##[group]❌ test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts output
No tests found, exiting with code 1
Pattern: test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts - 0 matches
end of test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts output
##[group]❌ test/e2e/404-page-router/index.test.ts output
No tests found, exiting with code 1
Pattern: test/e2e/404-page-router/index.test.ts - 0 matches
end of test/e2e/404-page-router/index.test.ts output
Starting test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts retry 2/2
Starting test/e2e/404-page-router/index.test.ts retry 2/2
##[group]❌ test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts output
No tests found, exiting with code 1
Pattern: test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts - 0 matches
end of test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts output
##[group]❌ test/e2e/404-page-router/index.test.ts output
No tests found, exiting with code 1
Pattern: test/e2e/404-page-router/index.test.ts - 0 matches
end of test/e2e/404-page-router/index.test.ts output
test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts failed due to Error: failed with code: 1
test/e2e/app-dir/actions-allowed-origins/app-action-allowed-origins.test.ts failed to pass within 2 retries
test/e2e/404-page-router/index.test.ts failed due to Error: failed with code: 1
test/e2e/404-page-router/index.test.ts failed to pass within 2 retries
exiting with code 1
`;

describe('scripts/e2e-summary.mjs — GROUND-TRUTH real shard log (A3-3, #147 run 28318485456)', () => {
  it('counts BOTH interleaved "No tests found" aborts as notRun, 0 failed (the false-RED the prior fix missed)', () => {
    const s = summarize(SAMPLE_DEPLOY_REAL_INTERLEAVED_PHANTOM, {
      ref: 'v16.0.3',
      shard: '1/4',
      excluded: 5,
    });
    // Both files are phantom infra-aborts: jest never located them, no next build,
    // no server boot, no assertion. They must be notRun, NOT failed.
    expect(s.failed).toBe(0);
    expect(s.notRun).toBe(2);
    expect(s.passed).toBe(0);
  });

  it('is not fooled by the underscore JEST_JUNIT_OUTPUT_NAME echo (scope must use the slash form)', () => {
    // Single-file slice carrying the exact underscore env-echo line that hijacked
    // the prior scope tracker. The slash-keyed failure marker must still resolve to
    // the same file the phantom set keys on.
    const slice = `
total: 1
Starting test/e2e/404-page-router/index.test.ts retry 0/2
❌ test/e2e/404-page-router/index.test.ts output:
HEADLESS=true JEST_JUNIT_OUTPUT_NAME=test_e2e_404-page-router_index.test.ts /next.js/node_modules/.bin/jest '--ci' 'test/e2e/404-page-router/index.test.ts'
No tests found, exiting with code 1
Pattern: test/e2e/404-page-router/index.test.ts - 0 matches
end of test/e2e/404-page-router/index.test.ts output
test/e2e/404-page-router/index.test.ts failed to pass within 2 retries
exiting with code 1
`;
    const s = summarize(slice, { ref: 'v16.0.3', shard: '1/4', excluded: 0 });
    expect(s.failed).toBe(0);
    expect(s.notRun).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3-3 (#147) fix round 1 — the OVERCOUNT bugs (triage of run 28558576615).
// The baseline run reported 491 failed; the TRUE count of distinct failing files was
// 473. Two parser bugs made up the difference:
//
//  (a) DOUBLE-COUNT: `matchCount(text, /(\d+)\s+failed/)` grabs the FIRST jest
//      per-file tally line (e.g. `Tests: 1 failed, 1 total`) that a captured
//      ❌ output group happens to contain, and ADDS it to the per-file marker
//      count. When run-tests.js per-file markers are present they are the ONLY
//      honest ledger — the jest tally must NOT be added on top (~16 of the 18
//      overcounted "failures").
//
//  (b) PHANTOM CAPTURES: the marker regexes used `(\S+\.test\.\S+)`, which
//      matched `}}.test.ts`-style tokens out of JSON content echoed inside
//      output groups (2 of the 491 were such phantoms). Real run-tests.js file
//      keys are repo-root-relative and ALWAYS start with `test/` — the token
//      regex must require that prefix (`test/\S+\.test\.\w+`).
// ─────────────────────────────────────────────────────────────────────────────

describe('scripts/e2e-summary.mjs — overcount fixes (A3-3 #147 fix round 1, run 28558576615)', () => {
  it('does NOT add a jest per-file tally inside a ❌ output group to the per-file markers', () => {
    // One real pass + one real fail, and the failing group ECHOES a jest tally
    // (`Tests: 1 failed, …` and `1 passed`) — the old parser summed both shapes
    // and reported passed:2/failed:2. Markers are authoritative: 1/1.
    const log = `
total: 2
Starting test/e2e/404-page-router/index.test.ts retry 0/2
test/e2e/404-page-router/index.test.ts finished on retry 0/2 in 12.3s
Starting test/e2e/image-optimizer/index.test.ts retry 0/2
##[group]❌ test/e2e/image-optimizer/index.test.ts output
[e2e-deploy] running next build
Tests:       1 failed, 1 total
Test Suites: 1 failed, 1 total
end of test/e2e/image-optimizer/index.test.ts output
test/e2e/image-optimizer/index.test.ts failed to pass within 2 retries
exiting with code 1
`;
    const s = summarize(log, { ref: 'v16.2.0', shard: '1/16', excluded: 32 });
    expect(s.failed).toBe(1);
    expect(s.passed).toBe(1);
  });

  it('does not let an interleaved jest "N passed" tally inflate the pass count either', () => {
    const log = `
total: 1
Starting test/e2e/x/x.test.ts retry 0/2
##[group]❌ test/e2e/x/x.test.ts output
Tests:       3 passed, 3 total
end of test/e2e/x/x.test.ts output
test/e2e/x/x.test.ts failed to pass within 2 retries
exiting with code 1
`;
    const s = summarize(log, { ref: 'v16.2.0', shard: '2/16', excluded: 0 });
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(1);
  });

  it('still uses the jest tally when NO run-tests.js per-file markers exist at all', () => {
    // Guard the other direction: the jest path is the only signal for per-suite
    // jest runs — markers-absent must keep parsing it (no regression of #164).
    const s = summarize('Tests:       2 failed, 40 passed, 42 total\n', {
      ref: 'v16.2.0',
      shard: '3/16',
      excluded: 0,
    });
    expect(s.passed).toBe(40);
    expect(s.failed).toBe(2);
  });

  it('ignores phantom non-test/ tokens like `}}.test.ts` captured from JSON content (fail marker)', () => {
    // Verbatim shape of the 2 phantom captures in run 28558576615: JSON content
    // inside an output group lines up so `\S+` grabs `}}.test.ts`. A real
    // run-tests.js key always starts with `test/`.
    const log = `
total: 1
Starting test/e2e/x/x.test.ts retry 0/2
{"config":{"retries":2}}.test.ts failed to pass within 2 retries
test/e2e/x/x.test.ts finished on retry 0/2 in 1.0s
exiting with code 0
`;
    const s = summarize(log, { ref: 'v16.2.0', shard: '4/16', excluded: 0 });
    expect(s.failed).toBe(0);
    expect(s.passed).toBe(1);
  });

  it('ignores phantom non-test/ tokens on the pass markers too (both formats)', () => {
    const log = `
{"a":1}}.test.ts finished on retry 0/2 in 1.0s
Finished }}.test.ts on retry 0/2 in 1.0s
exiting with code 0
`;
    const s = summarize(log, { ref: 'v16.2.0', shard: '5/16', excluded: 0 });
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #147 item 4 (the Bun runtime axis): the summary artifact must be LANE-
// ATTRIBUTABLE. With a Node nightly and a Bun weekly emitting the same
// compat-suite-summary-*.json shape, a summary that does not carry the runtime
// would let a Bun result be silently read as Node evidence (or vice versa) —
// the compat-matrix Node ✅ is a NODE claim, so every artifact must say which
// lane produced it.
describe('summarize() runtime attribution (#147 Bun axis)', () => {
  it('carries the runtime through to the artifact', () => {
    const s = summarize('Tests: 1 passed, 1 total\n', {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
      runtime: 'bun',
    });
    expect(s.runtime).toBe('bun');
  });

  it('defaults runtime to node when absent (backwards compatible with pre-lane artifacts)', () => {
    const s = summarize('', { ref: 'v16.2.0', shard: '1/16', excluded: 0 });
    expect(s.runtime).toBe('node');
  });

  it('normalizes a non-string runtime to the node default (artifact stays well-typed)', () => {
    const s = summarize('', {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
      // @ts-expect-error intentionally malformed input from the CLI boundary
      runtime: 42,
    });
    expect(s.runtime).toBe('node');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #188 (the bun-version dispatch knob): a canary dispatch's evidence must be
// VERSION-ATTRIBUTABLE. `runtime: "bun"` alone cannot distinguish a 1.3.14 run
// from a 1.4.0-canary run — and the whole point of the canary dispatch is to
// prove the 3 remaining red files are Bun-VERSION-gated. So the summary carries
// the OBSERVED `bun --version` as `runtimeVersion`. Node lane: the key is
// ABSENT (documented choice — node's version is pinned by the workflow's
// setup-node, and omitting the key keeps the node artifact shape byte-stable
// for existing consumers, e.g. the #41 matrix publisher).
describe('summarize() runtimeVersion attribution (#188 bun-version knob)', () => {
  it('carries the observed bun version through to the artifact', () => {
    const s = summarize('Tests: 1 passed, 1 total\n', {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
      runtime: 'bun',
      runtimeVersion: '1.4.0-canary.28',
    });
    expect(s.runtimeVersion).toBe('1.4.0-canary.28');
    // Round-trips through JSON (it's an artifact).
    expect(JSON.parse(JSON.stringify(s)).runtimeVersion).toBe('1.4.0-canary.28');
  });

  it('OMITS the key when no version was captured (the node lane shape stays unchanged)', () => {
    const s = summarize('', { ref: 'v16.2.0', shard: '1/16', excluded: 0, runtime: 'node' });
    expect(Object.keys(s)).not.toContain('runtimeVersion');
  });

  it('treats an empty/whitespace version as absent (the workflow passes "" on the node lane)', () => {
    const s = summarize('', {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
      runtime: 'node',
      runtimeVersion: '  ',
    });
    expect(Object.keys(s)).not.toContain('runtimeVersion');
  });

  it('normalizes a non-string runtimeVersion to absent (artifact stays well-typed)', () => {
    const s = summarize('', {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
      runtime: 'bun',
      // @ts-expect-error intentionally malformed input from the CLI boundary
      runtimeVersion: 1.4,
    });
    expect(Object.keys(s)).not.toContain('runtimeVersion');
  });

  it('trims the captured version (shell command substitution can carry whitespace)', () => {
    const s = summarize('', {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
      runtime: 'bun',
      runtimeVersion: '1.3.14\n',
    });
    expect(s.runtimeVersion).toBe('1.3.14');
  });
});
