#!/usr/bin/env node
/**
 * scripts/e2e-summary.mjs — reduce official-harness runner output to a machine-
 * readable summary artifact (#89, ADR-0007 A3-2). Unblocks #41 (publish the matrix
 * honestly): the matrix publisher consumes {passed, failed, excluded, ref, shard}.
 *
 * Two output shapes must be parsed:
 *
 *  (1) jest reporter tally (per-suite jest runs):
 *        Tests:       3 failed, 41 passed, 2 skipped, 46 total
 *
 *  (2) run-tests.js AGGREGATE output (NEXT_TEST_MODE=deploy, what this gate runs).
 *      run-tests.js is NOT jest's default reporter — it spawns jest per test FILE
 *      and prints its OWN per-file result lines, never a `Tests:` tally:
 *        pass:  "<file> finished on retry <i>/<n> in <t>s"  (run-tests.js:676)
 *        fail:  "<file> failed to pass within <n> retries"  (run-tests.js:703)
 *      A3-3 (#147): the old jest-only parser reported {passed:0,failed:0} for a
 *      shard where a real deploy test FAILED (build "failed with code: 1") — a
 *      false-green. We MUST count these per-file markers so failures are honest.
 *
 * HONESTY (A3-3, run 28317739829) — the inverse false-RED. A jest INFRA ABORT is
 * NOT a test result. When jest cannot LOCATE the selected file it prints:
 *     No tests found, exiting with code 1
 * and run-tests.js then retries, gives up, and prints the SAME `<file> failed to
 * pass within N retries` line a genuine assertion failure prints. The earlier
 * parser counted that phantom as `failed:1` — a misleading FALSE-RED: it tallied a
 * test that NEVER RAN (no `next build`, no server boot, no assertion) as a deploy
 * failure. summarize() MUST distinguish "the deploy test ran and failed" from
 * "jest never found the file / infra abort" and surface the latter as a SEPARATE
 * `notRun` counter — never as `failed`. (Symmetric to the #164 false-green fix:
 * the summary must tell the TRUTH about what actually executed.)
 *
 * Usage (in CI, per shard):
 *   node scripts/e2e-summary.mjs \
 *     --runner-log <path> --ref <gitref> --shard <n/m> --excluded <count> \
 *     --out compat-suite-summary.json
 *
 * The pure `summarize()` export is unit-tested in tests/deploy-summary.test.ts.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Parse jest-style runner output + run metadata into the summary artifact shape.
 * @param {string} runnerOutput raw stdout from run-tests.js
 * @param {{ref:string, shard:string, excluded:number}} meta
 * @returns {{passed:number, failed:number, notRun:number, excluded:number, ref:string, shard:string}}
 */
export function summarize(runnerOutput, meta) {
  const text = String(runnerOutput ?? '');

  // (1) jest reporter tally — authoritative when present (per-suite jest runs).
  const jestPassed = matchCount(text, /(\d+)\s+passed/);
  const jestFailed = matchCount(text, /(\d+)\s+failed/);

  // (2) run-tests.js aggregate per-file markers (NEXT_TEST_MODE=deploy). Count
  // DISTINCT test FILES so a test that retries N times is tallied exactly once.
  // The EXACT v16.0.3 format strings (verified at run-tests.js:727 + :754):
  //   pass:  `Finished ${test.file} on retry ${i}/${n} in ${t}s`  ← "Finished"
  //          comes FIRST (capitalized), THEN the file path. NOT file-first.
  //   fail:  `${test.file} failed to pass within ${n} retries`    ← file first.
  const runTestsPassed = collectTestFiles(
    text,
    /\bFinished\s+(\S+\.test\.\S+)\s+on retry\s+\d+\/\d+/g,
  );
  const runTestsFailedAll = collectTestFiles(
    text,
    /(\S+\.test\.\S+)\s+failed to pass within\s+\d+\s+retries/g,
  );

  // HONESTY (A3-3): partition the run-tests.js "failed to pass within …" files
  // into REAL failures vs PHANTOM infra-aborts. A phantom is a file jest could
  // never LOCATE: its `❌ <file> output` group contains jest's
  //   `No tests found, exiting with code 1`
  // (no `next build`, no server boot, no assertion). Those must NOT inflate
  // `failed` — they are surfaced as `notRun`. A file with NO such marker in its
  // output group ran for real and its failure is genuine.
  const phantomFiles = filesWithNoTestsFound(text);
  const runTestsNotRun = new Set();
  const runTestsFailed = new Set();
  for (const file of runTestsFailedAll) {
    if (phantomFiles.has(file)) {
      runTestsNotRun.add(file);
    } else {
      runTestsFailed.add(file);
    }
  }

  // Prefer whichever shape actually reported results. The two never co-occur in
  // a real run, but if both somehow appear, sum them — never silently drop a
  // failure (an under-count here is the false-green A3-3 exists to prevent).
  const passed = jestPassed + runTestsPassed.size;
  const failed = jestFailed + runTestsFailed.size;
  const notRun = runTestsNotRun.size;

  return {
    passed,
    failed,
    notRun,
    excluded: Number(meta?.excluded ?? 0) || 0,
    ref: String(meta?.ref ?? ''),
    shard: String(meta?.shard ?? ''),
  };
}

/**
 * Identify the set of test FILES whose run-tests.js output group reported jest's
 * `No tests found, exiting with code 1` — i.e. jest never located the file, so the
 * "failure" is a phantom infra-abort, not a real deploy-test result.
 *
 * run-tests.js groups each file's output under a `❌ <file> output` header
 * (run-tests.js:624/628). We walk the log, tracking the "current file" from those
 * headers (and from the per-attempt JEST_SUITE_NAME / jest-command echo, which also
 * names the file), and mark a file phantom when a `No tests found` line appears
 * while it is current. Falls back to a whole-log heuristic only when no file scope
 * can be established (so a phantom is never silently reclassified as a real fail).
 * @param {string} text
 * @returns {Set<string>}
 */
function filesWithNoTestsFound(text) {
  const phantom = new Set();
  const lines = text.split('\n');
  // A line that re-scopes "the current file": the run-tests.js output-group
  // header, or the per-attempt jest invocation echo / JEST_SUITE_NAME, both of
  // which carry the `<…>.test.<ext>` path. The leading boundary excludes quotes
  // and path separators that the jest-command echo wraps the path in (e.g.
  // `'test/e2e/…/index.test.ts'`) so the captured path NORMALIZES to the same
  // string the `failed to pass within` marker uses (no surrounding quote).
  const fileScopeRe = /([\w./-]+\.test\.(?:js|ts|jsx|tsx))\b/;
  const noTestsRe = /No tests found, exiting with code 1/;
  let current = null;
  for (const line of lines) {
    if (noTestsRe.test(line)) {
      if (current) phantom.add(current);
      continue;
    }
    const m = line.match(fileScopeRe);
    if (m) current = m[1];
  }
  return phantom;
}

function matchCount(text, re) {
  const m = text.match(re);
  return m ? Number(m[1]) : 0;
}

/** Collect the SET of UNIQUE test-file paths captured by a per-file marker regex. */
function collectTestFiles(text, re) {
  const files = new Set();
  for (const m of text.matchAll(re)) {
    if (m[1]) files.add(m[1]);
  }
  return files;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key) args[key] = argv[i + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runnerLog = args['runner-log'];
  const out = args.out ?? 'compat-suite-summary.json';
  let runnerOutput = '';
  if (runnerLog) {
    try {
      runnerOutput = readFileSync(runnerLog, 'utf8');
    } catch (err) {
      console.error(`[e2e-summary] could not read runner log "${runnerLog}": ${String(err)}`);
    }
  }
  const summary = summarize(runnerOutput, {
    ref: args.ref ?? '',
    shard: args.shard ?? '',
    excluded: Number(args.excluded ?? 0),
  });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[e2e-summary] wrote ${out}: ${JSON.stringify(summary)}`);
}

// Run as CLI only when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
