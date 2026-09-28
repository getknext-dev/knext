import { afterEach, describe, expect, it, jest, spyOn } from 'bun:test';
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
// #1520 (raised from #1515) — run 36312054519: a `createNext` deploy-script
// failure inside a test file's `beforeAll` must classify as kind 'deploy', never
// 'assertion'/'unclassified'. 419 files failed before a single request was made,
// and the ledger recorded them as ordinary per-case failures — read by hand as
// "the self-contained binary serves wrong responses" until the shard logs were
// checked (#1515 root-cause comment). A harness/deploy failure must never read
// as a runtime regression.
//
// The official harness prints exactly two message shapes for this
// (`test/lib/next-modes/next-deploy.ts`'s `createNext`), both thrown before
// `beforeAll` returns:
//   `Custom deploy script failed: …`
//   `Custom deploy script returned invalid URL: …`
// ─────────────────────────────────────────────────────────────────────────────

// Shape 1: the deploy script itself exits non-zero. No per-case ✕ lines at all —
// jest never entered the file's tests ("Test suite failed to run"), so `cases`
// is empty. Before #1520 this fell through to 'unclassified'.
const SAMPLE_DEPLOY_SCRIPT_FAILED_OUTPUT = `
total: 1
Starting test/e2e/app-dir/actions/actions.test.ts retry 0/2
##[group]❌ test/e2e/app-dir/actions/actions.test.ts output
[e2e-deploy] running next build
  ● Test suite failed to run

    Custom deploy script failed: Error: Command failed with exit code 1: ./deploy.sh
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

end of test/e2e/app-dir/actions/actions.test.ts output
test/e2e/app-dir/actions/actions.test.ts failed to pass within 2 retries
exiting with code 1
`;

// Shape 2: the deploy script exits 0 but its stdout is not a bare URL (the
// #1515 leaked-banner root cause). Same "no cases printed" shape.
const SAMPLE_DEPLOY_SCRIPT_INVALID_URL_OUTPUT = `
total: 1
Starting test/e2e/app-dir/segment-cache/segment-cache.test.ts retry 0/2
##[group]❌ test/e2e/app-dir/segment-cache/segment-cache.test.ts output
[e2e-deploy] running next build
  ● Test suite failed to run

    Custom deploy script returned invalid URL: undefined
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:225:13)

end of test/e2e/app-dir/segment-cache/segment-cache.test.ts output
test/e2e/app-dir/segment-cache/segment-cache.test.ts failed to pass within 2 retries
exiting with code 1
`;

// Shape 3: the `beforeAll`-cascade shape (#1520's "every case in the file
// failed before a request was made") — jest DOES enumerate the describe
// block's individual `it`s and marks each ✕ with the hook's own error, so
// `cases` is non-empty. Before #1520 this classified as 'assertion' (the
// literal bug the issue reports); 'deploy' must take PRIORITY over the
// per-case markers, because the deploy script — not those cases — is why the
// file never produced a real result.
const SAMPLE_DEPLOY_SCRIPT_CASCADE_OUTPUT = `
total: 1
Starting test/e2e/app-dir/actions-alt/actions-alt.test.ts retry 0/2
##[group]❌ test/e2e/app-dir/actions-alt/actions-alt.test.ts output
[e2e-deploy] running next build
  ✕ server action › one (2 ms)
  ✕ server action › two (1 ms)

  ● server action › one

    Custom deploy script failed: Error: Command failed with exit code 1: ./deploy.sh
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

  ● server action › two

    Custom deploy script failed: Error: Command failed with exit code 1: ./deploy.sh
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

end of test/e2e/app-dir/actions-alt/actions-alt.test.ts output
test/e2e/app-dir/actions-alt/actions-alt.test.ts failed to pass within 2 retries
exiting with code 1
`;

describe('scripts/e2e-summary.mjs — deploy-script failures classify as kind "deploy" (#1520)', () => {
  it('classifies "Custom deploy script failed: …" as kind "deploy"', () => {
    const s = summarize(SAMPLE_DEPLOY_SCRIPT_FAILED_OUTPUT, {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
    });
    expect(s.failed).toBe(1);
    expect(s.failures).toEqual([
      expect.objectContaining({
        file: 'test/e2e/app-dir/actions/actions.test.ts',
        kind: 'deploy',
      }),
    ]);
  });

  it('classifies "Custom deploy script returned invalid URL: …" as kind "deploy"', () => {
    const s = summarize(SAMPLE_DEPLOY_SCRIPT_INVALID_URL_OUTPUT, {
      ref: 'v16.2.0',
      shard: '2/16',
      excluded: 0,
    });
    expect(s.failed).toBe(1);
    expect(s.failures).toEqual([
      expect.objectContaining({
        file: 'test/e2e/app-dir/segment-cache/segment-cache.test.ts',
        kind: 'deploy',
      }),
    ]);
  });

  it('the beforeAll cascade (every case failed before a request was made) still classifies as "deploy", not "assertion"', () => {
    const s = summarize(SAMPLE_DEPLOY_SCRIPT_CASCADE_OUTPUT, {
      ref: 'v16.2.0',
      shard: '3/16',
      excluded: 0,
    });
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure.kind).toBe('deploy');
    // The per-case names are still carried (they are real evidence of the
    // cascade), just not what decides the kind.
    expect(failure.cases).toEqual(['server action › one', 'server action › two']);
  });

  it('a deploy-classified failure is never counted as notRun (it is a real, attributed failure)', () => {
    const s = summarize(SAMPLE_DEPLOY_SCRIPT_FAILED_OUTPUT, {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
    });
    expect(s.notRun).toBe(0);
    expect(Object.keys(s)).not.toContain('notRunFiles');
  });

  it('does NOT misclassify an ordinary assertion failure as "deploy" (no false positive)', () => {
    const s = summarize(SAMPLE_DEPLOY_RUNNER_OUTPUT, {
      ref: 'v16.0.3',
      shard: '1/4',
      excluded: 0,
    });
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure.kind).not.toBe('deploy');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1550 round 2 (lead-directed) — a round-1 review of #1520 found the classifier
// matched the "Custom deploy script …" phrase ANYWHERE on any line, across every
// retry, file-wide — so a genuine regression could read as harness noise. Fixed
// two ways:
//   1. the deploy marker is ANCHORED to the start of its own line (an assertion
//      whose message merely CONTAINS the phrase, or a stray log echo, no longer
//      matches);
//   2. classification is scoped to the FINAL retry attempt only, and ranked PER
//      CASE-BLOCK, with 'deploy' BELOW 'timeout' and 'assertion' — a case
//      genuinely explained by something else is never demoted to harness noise.
// Every fixture below is a genuine, real red that must NOT read as 'deploy'.
// ─────────────────────────────────────────────────────────────────────────────

const F1550 = 'test/e2e/app-dir/x/x.test.ts';
/** Wrap ONE retry's body in the real run-tests.js group markers. */
function wrapOneRetry(body: string) {
  return `
total: 1
Starting ${F1550} retry 0/2
##[group]❌ ${F1550} output
${body}
end of ${F1550} output
${F1550} failed to pass within 2 retries
exiting with code 1
`;
}

describe('scripts/e2e-summary.mjs — deploy is ranked below assertion/timeout, per case (#1550 round 2)', () => {
  it('an assertion whose OWN message merely contains the deploy phrase is NOT deploy (the anchor fix)', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ error page › renders deploy error (5 ms)

  ● error page › renders deploy error

    expect(received).toContain(expected)
    Expected substring: "Custom deploy script failed"
    Received string:    "<html>ok</html>"
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).not.toBe('deploy');
  });

  it('a mixed file (one createNext deploy failure, one genuine assertion failure) is NOT deploy', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ block A › one (2 ms)
  ✕ block B › real (40 ms)

  ● block A › one

    Custom deploy script failed: Error: Command failed with exit code 1
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

  ● block B › real

    expect(received).toBe(expected)
    Expected: 200
    Received: 500
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).not.toBe('deploy');
  });

  it('retry 0 hitting a deploy failure then retry 1 failing a genuine assertion (same file) is NOT deploy — final retry only', () => {
    const s = summarize(
      `
total: 1
Starting ${F1550} retry 0/2
##[group]❌ ${F1550} output
  ● Test suite failed to run
    Custom deploy script failed: Error: exit 1
end of ${F1550} output
Starting ${F1550} retry 1/2
##[group]❌ ${F1550} output
  ✕ real › case (30 ms)
  ● real › case
    expect(received).toBe(expected)
end of ${F1550} output
${F1550} failed to pass within 2 retries
exiting with code 1
`,
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).not.toBe('deploy');
  });

  it('a real 60s timeout plus a deploy line in another case is "timeout", never "deploy" (precedence)', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ a › slow (60001 ms)
  ● a › slow
    thrown: "Exceeded timeout of 60000 ms for a test.
  ● b › other
    Custom deploy script returned invalid URL: undefined
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).toBe('timeout');
    expect(failure?.kind).not.toBe('deploy');
  });

  it('retry 0 failing a genuine assertion then retry 1 hitting a deploy failure (same file) IS deploy — stale retry-0 evidence must not linger', () => {
    // The inverse of the "final retry only" test above: this is what proves the
    // per-retry RESET is load-bearing, not just harmless. If retry 0's real
    // assertion evidence were never cleared, it would wrongly out-vote retry
    // 1's clean deploy-only outcome (assertion ranks above deploy) even though
    // the file's ACTUAL final state is a harness failure, not a code bug.
    const s = summarize(
      `
total: 1
Starting ${F1550} retry 0/2
##[group]❌ ${F1550} output
  ✕ real › case (30 ms)
  ● real › case
    expect(received).toBe(expected)
end of ${F1550} output
Starting ${F1550} retry 1/2
##[group]❌ ${F1550} output
  ● Test suite failed to run
    Custom deploy script failed: Error: exit 1
end of ${F1550} output
${F1550} failed to pass within 2 retries
exiting with code 1
`,
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).toBe('deploy');
  });

  it('a server log line that echoes the deploy phrase (not the harness marker itself) is NOT deploy', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ a › b (3 ms)
  ● a › b
    expect(received).toBe(expected)
[server] Custom deploy script failed? no
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).not.toBe('deploy');
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

// ─────────────────────────────────────────────────────────────────────────────
// #212 — the #194 truncation-guard FALSE POSITIVE (runs 28699757721 + 28699158428,
// shards 3/16 + 7/16 on BOTH). Ground truth from the raw shard logs: the harness
// at v16.2.0 selects REAL scaffold files whose paths contain SPACES —
//   test/e2e/app-dir/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts   (shard 3)
//   test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts           (shard 7)
// run-tests.js counts them in its `total: N` header AND runs them AND prints the
// normal pass marker for them ("… finished on retry 0/2 in 20.428s" — verbatim in
// the shard-3 log). But every summarize() file token was `test/\S+\.test\.\w+`,
// and `\S+` cannot cross the spaces inside `{{ toFileName name }}` — so the pass
// was INVISIBLE: reported = expectedTotal - 1 with failed=0 → truncated:true →
// the guard failed a genuinely green shard. expectedTotal (a count) and the
// reported tally (parsed markers) MUST measure the same universe: the token has
// to accept every path run-tests.js can select, spaces included, while staying
// anchored to the `test/` prefix and the exact marker suffixes (the #147
// anti-garbage properties, re-asserted by the overcount suite above).
// NOT the mechanism: retry accounting — PR-run shard 3's failed-first file
// (segment-cache/prefetch-layout-sharing, pass on retry 2/2) tallies correctly.
// ─────────────────────────────────────────────────────────────────────────────

// Faithful de-timestamped slice of run 28699757721 / 28699158428 shard 3/16,
// compressed to 4 selected files: a plain pass, the FAILED-FIRST file (two ❌
// output groups, then a pass on retry 2/2 — the exact PR-run shard-3 shape),
// the SPACED template file (verbatim path), and a trailing plain pass.
const SAMPLE_DEPLOY_SHARD3_SPACED_TEMPLATE = `
total: 4
Starting test/e2e/app-dir/actions-unused-args/actions-unused-args.test.ts retry 0/2
test/e2e/app-dir/actions-unused-args/actions-unused-args.test.ts finished on retry 0/2 in 2.202s
Starting test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts retry 0/2
##[group]❌ test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts output
[e2e-deploy] running next build
  ● segment cache › prefetch layout sharing (timeout)
end of test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts output
Starting test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts retry 1/2
Starting test/e2e/app-dir/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts retry 0/2
test/e2e/app-dir/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts finished on retry 0/2 in 20.428s
Starting test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts retry 2/2
test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts finished on retry 2/2 in 24.66s
Starting test/e2e/children-page/index.test.ts retry 0/2
test/e2e/children-page/index.test.ts finished on retry 0/2 in 3.0s
exiting with code 0
`;

describe('summarize() — spaced harness paths must be accounted (#212 truncation false positive)', () => {
  it('counts the spaced {{ toFileName name }} template pass — the shard-3/7 shape is NOT truncated', () => {
    // THE #212 bug: on main this reports passed:3 of expectedTotal:4 with
    // failed:0 → truncated:true, failing a genuinely green shard.
    const s = summarize(SAMPLE_DEPLOY_SHARD3_SPACED_TEMPLATE, {
      ref: 'v16.2.0',
      shard: '3/16',
      excluded: 32,
    });
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(0);
    expect(s.notRun).toBe(0);
    expect(s.expectedTotal).toBe(4);
    expect(s.truncated).toBe(false);
  });

  it('counts the failed-first file exactly once (pass on retry 2/2, ❌ groups from earlier attempts)', () => {
    // The retry-accounting hypothesis from #210, disproven but pinned: a file
    // that fails attempts 0/1 (printing ❌ output groups) then passes on retry
    // 2/2 is ONE pass — never a failure, never double-counted.
    const s = summarize(SAMPLE_DEPLOY_SHARD3_SPACED_TEMPLATE, {
      ref: 'v16.2.0',
      shard: '3/16',
      excluded: 0,
    });
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(0);
  });

  it('counts the shard-7 spaced template path (test/e2e/test-template/…) too', () => {
    const shard7 = `
total: 2
Starting test/e2e/app-document/client.test.ts retry 0/2
test/e2e/app-document/client.test.ts finished on retry 0/2 in 3.1s
Starting test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts retry 0/2
test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts finished on retry 0/2 in 24.886s
exiting with code 0
`;
    const s = summarize(shard7, { ref: 'v16.2.0', shard: '7/16', excluded: 32 });
    expect(s.passed).toBe(2);
    expect(s.expectedTotal).toBe(2);
    expect(s.truncated).toBe(false);
  });

  it('counts a spaced-path FAILURE as failed (marker keys stay consistent across outcomes)', () => {
    const log = `
total: 1
Starting test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts retry 0/2
##[group]❌ test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts output
[e2e-deploy] running next build
  ● template › renders
end of test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts output
test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts failed to pass within 2 retries
exiting with code 1
`;
    const s = summarize(log, { ref: 'v16.2.0', shard: '7/16', excluded: 0 });
    expect(s.failed).toBe(1);
    expect(s.notRun).toBe(0);
    expect(s.expectedTotal).toBe(1);
    expect(s.truncated).toBe(false);
  });

  it('classifies a spaced-path phantom (No tests found in its own group) as notRun, not failed', () => {
    // The group open/close boundaries must resolve the SAME spaced key the
    // failure marker uses, or the phantom partition silently breaks for these files.
    const log = `
total: 1
Starting test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts retry 0/2
##[group]❌ test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts output
No tests found, exiting with code 1
Pattern: test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts - 0 matches
end of test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts output
test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts failed to pass within 2 retries
exiting with code 1
`;
    const s = summarize(log, { ref: 'v16.2.0', shard: '7/16', excluded: 0 });
    expect(s.failed).toBe(0);
    expect(s.notRun).toBe(1);
    expect(s.expectedTotal).toBe(1);
    expect(s.truncated).toBe(false);
  });

  it('REAL truncation is still caught: a selected file with NO result marker at all flags truncated', () => {
    // The guard keeps its teeth — a shard killed mid-run (third file started,
    // never reported; spaced file counted normally) must stay truncated:true.
    const killed = `
total: 3
Starting test/e2e/app-document/client.test.ts retry 0/2
test/e2e/app-document/client.test.ts finished on retry 0/2 in 3.1s
Starting test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts retry 0/2
test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts finished on retry 0/2 in 24.886s
Starting test/e2e/children-page/index.test.ts retry 0/2
`;
    const s = summarize(killed, { ref: 'v16.2.0', shard: '7/16', excluded: 0 });
    expect(s.passed).toBe(2);
    expect(s.expectedTotal).toBe(3);
    expect(s.truncated).toBe(true);
  });

  it('a spaced pass and a spaced failure of DIFFERENT template files stay distinct keys', () => {
    // Both real template paths exist in the harness (app-dir + e2e) — the
    // space-tolerant token must not glue two files on one line universe together.
    const log = `
total: 2
test/e2e/app-dir/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts finished on retry 0/2 in 20.4s
test/e2e/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts failed to pass within 2 retries
exiting with code 1
`;
    const s = summarize(log, { ref: 'v16.2.0', shard: '3/16', excluded: 0 });
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.truncated).toBe(false);
  });
});

// ── #194 accepted-risk follow-up: warn when truncation detection is disabled ──
// Truncation protection rests on run-tests.js's `total: N` log header; a future
// harness ref that renames it FAILS OPEN silently (expectedTotal omitted, no
// truncated flag, a killed shard can read as green). The smallest honest signal:
// summarize() WARNS (never fails) when the run-tests path yields no expected
// total. Per-suite jest runs legitimately have no selection count — no warning.
describe('summarize() warns when a run-tests-path summary lacks expectedTotal (#194 follow-up)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const deployLogNoHeader = `
Starting test/e2e/a/a.test.ts retry 0/2
test/e2e/a/a.test.ts finished on retry 0/2 in 1.0s
`;

  it('WARNS (not fails) when per-file markers are present but no `total:` header / override exists', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const s = summarize(deployLogNoHeader, { ref: 'v16.2.0', shard: '1/16', excluded: 0 });
    // Fail-open behavior is unchanged (keys omitted), but no longer SILENT.
    expect(Object.keys(s)).not.toContain('expectedTotal');
    expect(Object.keys(s)).not.toContain('truncated');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/truncation detection/i);
  });

  it('does not warn when the `total:` header is present', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    summarize(`total: 1\n${deployLogNoHeader}`, { ref: 'v16.2.0', shard: '1/16', excluded: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when an explicit --expected-total override is given', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    summarize(deployLogNoHeader, {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
      expectedTotal: 1,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn on the per-suite jest-tally path (no selection count exists there)', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    summarize(SAMPLE_RUNNER_OUTPUT, { ref: 'v16.0.3', shard: '1/4', excluded: 7 });
    expect(warn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1555 — three concrete follow-ups from the #1550 round-2 closing review,
// plus one nit, all "label only, no grading effect" (a deploy-classified red
// resets the credential like any other red either way):
//   N1: an `afterAll` `next.destroy()` TypeError — a SIDE EFFECT of the
//       earlier `createNext` deploy failure, since the instance it tears down
//       was never assigned — was measured to downgrade ~11% of real deploy
//       failures to 'assertion'. It must not.
//   N2: `unexplainedCase` (a failing case with NO error-detail block at all)
//       was untested in isolation from `hasNonDeployBlock`.
//   N3: the #1550 round-2 per-retry reset (load-bearing for `kind`) also
//       silently DISCARDS an earlier retry's own cases/timeoutMs evidence —
//       `compat-vinext-ledger.mjs` matches known failures on `cases`, so that
//       evidence must be preserved, not overwritten.
//   Nit: timeout ranks above deploy WITHIN one case's own block (previously
//        only proven across two different blocks).
// ─────────────────────────────────────────────────────────────────────────────

describe('scripts/e2e-summary.mjs — afterAll teardown cascade stays "deploy" (#1555 N1)', () => {
  it('a beforeAll deploy-script cascade followed by an afterAll next.destroy() TypeError is still "deploy"', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ foo describe › renders (2 ms)

  ● Test suite failed to run

    Custom deploy script failed: Error: Command failed with exit code 1: ./deploy.sh
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

  ● foo describe › renders

    Custom deploy script failed: Error: Command failed with exit code 1: ./deploy.sh
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

  ● Test suite failed to run

    TypeError: Cannot read properties of undefined (reading 'destroy')
        at Object.afterAll (/next.js/test/lib/next-modes/base.ts:145:16)
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).toBe('deploy');
    expect(failure?.cases).toEqual(['foo describe › renders']);
  });

  it('the SAME teardown TypeError with NO accompanying deploy evidence anywhere is NOT swallowed as deploy (fail closed)', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ foo describe › renders (2 ms)

  ● foo describe › renders

    expect(received).toBe(expected)
    Expected: 200
    Received: 500

  ● Test suite failed to run

    TypeError: Cannot read properties of undefined (reading 'destroy')
        at Object.afterAll (/next.js/test/lib/next-modes/base.ts:145:16)
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).not.toBe('deploy');
  });
});

describe('scripts/e2e-summary.mjs — unexplainedCase guard, in isolation (#1555 N2)', () => {
  it('a failing case with NO error-detail block at all downgrades away from "deploy" even when every PRINTED block is deploy-explained', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ a › one (2 ms)
  ✕ a › two (3 ms)

  ● a › one

    Custom deploy script failed: Error: exit 1
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    // Two failing cases, only ONE error-detail block ("a › two" has none) —
    // unexplainedCase must fail closed to 'assertion', never 'deploy', even
    // though the one block that DOES exist is fully deploy-explained.
    expect(failure?.kind).toBe('assertion');
    expect(failure?.cases).toEqual(['a › one', 'a › two']);
  });
});

describe('scripts/e2e-summary.mjs — retry attempts preserve prior cases/timeout evidence (#1555 N3)', () => {
  it("retry0 timeout, retry1 real assertion (same file): kind reflects the FINAL retry, but retry0's evidence survives via `attempts`", () => {
    const s = summarize(
      `
total: 1
Starting ${F1550} retry 0/2
##[group]❌ ${F1550} output
  ✕ a › slow (60001 ms)
  ● a › slow
    thrown: "Exceeded timeout of 60000 ms for a test.
end of ${F1550} output
Starting ${F1550} retry 1/2
##[group]❌ ${F1550} output
  ✕ real › case (30 ms)
  ● real › case
    expect(received).toBe(expected)
end of ${F1550} output
${F1550} failed to pass within 2 retries
exiting with code 1
`,
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    // Final-retry classification is UNCHANGED (#1550 round 2's fix — final
    // retry only decides `kind`/top-level `cases`/`timeoutMs`):
    expect(failure?.kind).toBe('assertion');
    expect(failure?.cases).toEqual(['real › case']);
    expect(failure?.timeoutMs).toBeUndefined();
    // But the earlier retry's own evidence is not silently dropped — it
    // survives in `attempts`, in retry order, for a consumer like
    // compat-vinext-ledger.mjs that matches known failures on `cases`.
    expect(failure?.attempts).toEqual([
      { cases: ['a › slow'], timeoutMs: 60000 },
      { cases: ['real › case'] },
    ]);
  });

  it('a single-attempt (never retried) file carries no `attempts` key — the artifact stays byte-stable', () => {
    const s = summarize(SAMPLE_DEPLOY_SCRIPT_FAILED_OUTPUT, {
      ref: 'v16.2.0',
      shard: '1/16',
      excluded: 0,
    });
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(Object.keys(failure ?? {})).not.toContain('attempts');
  });
});

describe('scripts/e2e-summary.mjs — timeout ranks above deploy WITHIN one case block (#1555 nit)', () => {
  it('a single case block carrying BOTH the timeout throw and a deploy-script line classifies "timeout", not "deploy"', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ a › slow (60001 ms)

  ● a › slow

    thrown: "Exceeded timeout of 60000 ms for a test.
    Custom deploy script failed: Error: exit 1
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).toBe('timeout');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1555 round 2 — a closing review of the N1 excuse itself found it applied
// too broadly: to ANY case block (not only a `Test suite failed to run`
// block), and it stayed set for the whole block even when a genuine
// assertion sat right next to the teardown marker. Fixtures below are named
// to match the review's own fixture IDs (A4b/A6/A7), plus one each isolating
// the `hasDeployBlock` gate and the anchor on `teardownCascadeRe`.
// ─────────────────────────────────────────────────────────────────────────────

describe('scripts/e2e-summary.mjs — the afterAll-teardown excuse is scoped to its own header and content (#1555 round 2 review)', () => {
  it("A4b: a REAL per-case failure shaped like the teardown TypeError, in a DIFFERENT case's own block, is never excused", () => {
    const s = summarize(
      wrapOneRetry(`  ✕ a › one (2 ms)
  ✕ b › closes server (2 ms)

  ● a › one

    Custom deploy script failed: Error: exit 1
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

  ● b › closes server

    TypeError: Cannot read properties of undefined (reading 'close')
        at Object.<anonymous> (/next.js/test/app.test.ts:40:10)
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    // "b › closes server" is a genuine, unrelated case-level failure — its
    // own header is NOT "Test suite failed to run", so the shape match alone
    // must not excuse it, no matter that "a › one" proves real deploy
    // evidence elsewhere in the same group.
    expect(failure?.kind).toBe('assertion');
    expect(failure?.cases).toEqual(['a › one', 'b › closes server']);
  });

  it('A6: an excused teardown block does not count as explaining a DIFFERENT, block-less failing case', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ a › one (2 ms)
  ✕ a › two (3 ms)

  ● a › one

    Custom deploy script failed: Error: exit 1
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

  ● Test suite failed to run

    TypeError: Cannot read properties of undefined (reading 'destroy')
        at Object.afterAll (/next.js/test/lib/next-modes/base.ts:145:16)
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    // Two failing cases, two blocks — but one block is the excused teardown
    // cascade, which explains nothing about "a › two". Counting it toward
    // the count-match guard would let "a › two" hide with no explanation.
    expect(failure?.kind).toBe('assertion');
    expect(failure?.cases).toEqual(['a › one', 'a › two']);
  });

  it('A7: a "Test suite failed to run" block that ALSO carries a genuine assertion is not "only" the teardown crash', () => {
    const s = summarize(
      wrapOneRetry(`  ✕ a › one (2 ms)

  ● a › one

    Custom deploy script failed: Error: exit 1
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

  ● Test suite failed to run

    TypeError: Cannot read properties of undefined (reading 'destroy')
        at Object.afterAll (/next.js/test/lib/next-modes/base.ts:145:16)
    expect(received).toBe(expected)
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    expect(failure?.kind).toBe('assertion');
  });

  it('a LONE teardown-cascade block with NO deploy evidence anywhere in the group fails closed to "assertion" (the hasDeployBlock gate)', () => {
    const s = summarize(
      wrapOneRetry(`  ● Test suite failed to run

    TypeError: Cannot read properties of undefined (reading 'destroy')
        at Object.afterAll (/next.js/test/lib/next-modes/base.ts:145:16)
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    // Without ANY deploy evidence in the group, the teardown-shaped block
    // must stay a real, unexplained failure — never 'deploy' and never
    // 'unclassified' (which is what dropping the `hasDeployBlock` gate on
    // the excuse would produce, since it would also stop counting as a
    // non-deploy block at all).
    expect(failure?.kind).toBe('assertion');
  });

  it("an assertion's OWN diff text merely containing the teardown marker (no line-start match) is never excused (the anchor)", () => {
    const s = summarize(
      wrapOneRetry(`  ✕ a › one (2 ms)

  ● a › one

    Custom deploy script failed: Error: exit 1
        at createNext (/next.js/test/lib/next-modes/next-deploy.ts:210:13)

  ● Test suite failed to run

    Received: "TypeError: Cannot read properties of undefined (reading 'destroy')"
`),
      { ref: 'v16.2.0', shard: '1/16', excluded: 0 },
    );
    const [failure] = s.failures ?? [];
    expect(failure).toBeDefined();
    // The "Received: ..." line only CONTAINS the marker text; it does not
    // START with it. Excusing this block would flip the file to 'deploy'
    // even though "a › one" is its only real case and it is not itself the
    // harness's own teardown crash.
    expect(failure?.kind).toBe('assertion');
    expect(failure?.cases).toEqual(['a › one']);
  });
});
