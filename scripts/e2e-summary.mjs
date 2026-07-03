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
 * TRUNCATION (#171 sys-design follow-up): a shard KILLED mid-run (step timeout,
 * runner eviction) reports the partial results its tee'd runner.log accumulated
 * — indistinguishable from a complete run. run-tests.js prints its selected-
 * test count as a `total: N` header at run start (verified in the real-run
 * fixtures this parser is tested against), so the summary derives
 * `expectedTotal` from it (or from an explicit --expected-total override) and
 * flags `truncated: true` whenever passed+failed+notRun < expectedTotal. The
 * fail-on-red workflow gate fails on truncated — partial results are never
 * green. Both keys are OMITTED when no selection count is derivable (per-suite
 * jest runs — that artifact shape stays byte-stable).
 *
 * Usage (in CI, per shard):
 *   node scripts/e2e-summary.mjs \
 *     --runner-log <path> --ref <gitref> --shard <n/m> --excluded <count> \
 *     [--expected-total <n>] --out compat-suite-summary.json
 *
 * The pure `summarize()` export is unit-tested in tests/deploy-summary.test.ts.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Parse jest-style runner output + run metadata into the summary artifact shape.
 * @param {string} runnerOutput raw stdout from run-tests.js
 * @param {{ref:string, shard:string, excluded:number, runtime?:string, runtimeVersion?:string, expectedTotal?:number}} meta
 * @returns {{passed:number, failed:number, notRun:number, excluded:number, ref:string, shard:string, runtime:string, runtimeVersion?:string, expectedTotal?:number, truncated?:boolean}}
 */
export function summarize(runnerOutput, meta) {
  const text = String(runnerOutput ?? '');

  // (2) run-tests.js aggregate per-file markers (NEXT_TEST_MODE=deploy). Count
  // DISTINCT test FILES so a test that retries N times is tallied exactly once.
  // The pass-marker format CHANGED between the harness refs this gate has run
  // (both verified against run-tests.js source at the tag):
  //   v16.0.3 (run-tests.js:727): `Finished ${test.file} on retry ${i}/${n} in ${t}s`
  //           ← "Finished" comes FIRST (capitalized), THEN the file path.
  //   v16.2.0 (run-tests.js:708-710): `${test.file} finished on retry ${i}/${n} in ${t}s`
  //           ← file FIRST, lowercase "finished".
  //   fail (both refs): `${test.file} failed to pass within ${n} retries` ← file first.
  // Parse BOTH pass shapes (union of file sets — a file is one pass regardless of
  // which marker reported it) so a harness-ref bump can never zero the pass count.
  //
  // A3-3 fix round 1 (#147, run 28558576615): the file token must be ANCHORED to
  // run-tests.js's repo-root-relative key shape (`test/…`). The old `\S+\.test\.\S+`
  // token also matched `}}.test.ts`-style garbage out of JSON content echoed in
  // output groups — 2 of the 491 reported failures were such phantoms.
  const runTestsPassed = new Set([
    ...collectTestFiles(text, /\bFinished\s+(test\/\S+\.test\.\w+)\s+on retry\s+\d+\/\d+/g),
    ...collectTestFiles(text, /(test\/\S+\.test\.\w+)\s+finished on retry\s+\d+\/\d+/g),
  ]);
  const runTestsFailedAll = collectTestFiles(
    text,
    /(test\/\S+\.test\.\w+)\s+failed to pass within\s+\d+\s+retries/g,
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

  // A3-3 fix round 1 (#147, run 28558576615 — the OVERCOUNT bug): when
  // run-tests.js per-file markers are present they are the ONLY honest ledger.
  // The old code ADDED the jest `(\d+) failed` first-match on top — but a
  // captured ❌ output group routinely ECHOES a jest per-file tally
  // (`Tests: 1 failed, …`), so ~16 failures were double-counted (491 reported
  // vs 473 real distinct failing files). The jest tally is parsed ONLY when no
  // per-file marker exists at all (per-suite jest runs — the #164 false-green
  // path stays covered).
  const markersPresent = runTestsPassed.size + runTestsFailedAll.size > 0;
  const passed = markersPresent ? runTestsPassed.size : matchCount(text, /(\d+)\s+passed/);
  const failed = markersPresent ? runTestsFailed.size : matchCount(text, /(\d+)\s+failed/);
  const notRun = runTestsNotRun.size;

  // #171 sys-design follow-up — the TRUNCATION marker. The shard's selected-
  // test count comes from an explicit meta override (CLI --expected-total)
  // when given, else from run-tests.js's own `total: N` header (printed at run
  // start, so it survives in a partial log even when the run is killed later;
  // anchored to line start so a `… 46 total` jest tally can never match). When
  // neither is available (per-suite jest runs) BOTH keys are omitted and the
  // legacy artifact shape is byte-stable.
  const overrideTotal = Number(meta?.expectedTotal);
  const totalHeader = text.match(/^total:\s*(\d+)\s*$/m);
  const expectedTotal =
    Number.isFinite(overrideTotal) && overrideTotal > 0
      ? Math.floor(overrideTotal)
      : totalHeader
        ? Number(totalHeader[1])
        : undefined;

  // #194 accepted-risk follow-up: the `total:` header is the ONLY implicit
  // source of expectedTotal, and a harness ref that renames it fails OPEN
  // silently (no truncated flag — a killed shard could read as green). On the
  // run-tests path (per-file markers present) that absence is anomalous, so
  // WARN — never fail — to keep the fail-open path honest and visible.
  if (markersPresent && expectedTotal === undefined) {
    console.warn(
      '[e2e-summary] WARN: run-tests.js per-file markers present but no expected total ' +
        '(no `total: N` header in the runner log and no --expected-total override) — ' +
        'truncation detection is DISABLED for this shard; a killed shard could read as green.',
    );
  }

  return {
    passed,
    failed,
    notRun,
    excluded: Number(meta?.excluded ?? 0) || 0,
    ref: String(meta?.ref ?? ''),
    shard: String(meta?.shard ?? ''),
    // #147 item 4 (Bun runtime axis): the artifact must be LANE-ATTRIBUTABLE —
    // the Node nightly and the Bun weekly emit the same summary shape, and the
    // compat-matrix Node ✅ is a NODE claim, so every summary says which lane
    // produced it. Mirrors e2e-deploy.sh's own KNEXT_RUNTIME semantics: exactly
    // 'bun' selects bun, anything else (absent, junk) is the node default.
    runtime: meta?.runtime === 'bun' ? 'bun' : 'node',
    // #188 (the bun-version dispatch knob): the artifact must also be VERSION-
    // attributable — "runtime": "bun" alone can't distinguish a 1.3.14 run from
    // a 1.4.0-canary run, and the canary dispatch exists to prove the remaining
    // red files are Bun-VERSION-gated. `runtimeVersion` carries the OBSERVED
    // `bun --version` (trimmed; shell command substitution carries whitespace).
    // DOCUMENTED CHOICE: on the node lane the key is ABSENT (the workflow
    // passes ""), keeping the node artifact shape byte-stable for existing
    // consumers (the #41 matrix publisher); node's version is already pinned
    // by the workflow's setup-node. Non-string/empty input → absent.
    ...(typeof meta?.runtimeVersion === 'string' && meta.runtimeVersion.trim() !== ''
      ? { runtimeVersion: meta.runtimeVersion.trim() }
      : {}),
    // #171 — truncated means "fewer results than the shard's selection count
    // were reported": a killed shard's partial green must never read as green.
    // failed AND notRun both count as reported results (a fully-reported red
    // shard is red, not truncated).
    ...(expectedTotal !== undefined
      ? { expectedTotal, truncated: passed + failed + notRun < expectedTotal }
      : {}),
  };
}

/**
 * Identify the set of test FILES whose run-tests.js output group reported jest's
 * `No tests found, exiting with code 1` — i.e. jest never located the file, so the
 * "failure" is a phantom infra-abort, not a real deploy-test result.
 *
 * GROUND TRUTH (run 28318485456 — the fix the prior version got wrong): scope must
 * follow run-tests.js's OWN output-group boundaries, NOT the last `.test.` token on
 * any line. run-tests.js (CI, concurrent) interleaves files and brackets each
 * file's captured child output between:
 *   open:  `❌ <file> output:`  /  `##[group]❌ <file> output`        (run-tests.js:624/628)
 *   close: `end of <file> output`                                     (run-tests.js:644/646)
 * The `<file>` in BOTH boundaries is the SLASH form — the SAME key the
 * `<file> failed to pass within N retries` failure marker uses. The previous tracker
 * instead grabbed any `\S*.test.\w+` token, which (a) captured the UNDERSCORE-joined
 * `JEST_JUNIT_OUTPUT_NAME=test_e2e_…_index.test.ts` echo (run-tests.js:555,
 * `replaceAll('/','_')`) — a key that never matches the slash-form failure marker,
 * so the phantom was mis-counted as a real `failed` — and (b) mis-attributed lines
 * across the concurrent interleave. We now ONLY (re)scope on the group boundaries,
 * and we credit a `No tests found` line ONLY while a group is OPEN (the abort always
 * prints inside the failing file's own group), so neither the underscore echo nor
 * interleaving can corrupt the attribution.
 * @param {string} text
 * @returns {Set<string>}
 */
function filesWithNoTestsFound(text) {
  const phantom = new Set();
  const lines = text.split('\n');
  // run-tests.js output-group OPEN header (with or without the GHA ##[group] prefix
  // and the trailing colon variant). Captures the SLASH-form file path — anchored
  // to the repo-root-relative `test/` prefix so group keys always equal the
  // failure-marker keys (A3-3 fix round 1 tightened both the same way).
  const groupOpenRe = /❌\s+(test\/\S+\.test\.(?:js|ts|jsx|tsx))\s+output\b/;
  // run-tests.js output-group CLOSE marker.
  const groupCloseRe = /^(?:.*\bend of\s+)(test\/\S+\.test\.(?:js|ts|jsx|tsx))\s+output\b/;
  const noTestsRe = /No tests found, exiting with code 1/;
  let current = null;
  for (const line of lines) {
    // A close marker ends the current scope (after we've had a chance to credit a
    // No-tests abort inside it). Match close BEFORE open: a single line is never
    // both, but ordering keeps intent explicit.
    const close = line.match(groupCloseRe);
    if (close) {
      current = null;
      continue;
    }
    const open = line.match(groupOpenRe);
    if (open) {
      current = open[1];
      continue;
    }
    if (current && noTestsRe.test(line)) {
      phantom.add(current);
    }
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
    runtime: args.runtime,
    // #188 — the observed serving-runtime version (bun lane only; "" on node
    // → summarize omits the key). See the shape comment in summarize().
    runtimeVersion: args['runtime-version'],
    // #171 — optional explicit selected-test count; when absent summarize()
    // derives it from the runner log's `total: N` header.
    expectedTotal:
      args['expected-total'] !== undefined ? Number(args['expected-total']) : undefined,
  });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[e2e-summary] wrote ${out}: ${JSON.stringify(summary)}`);
}

// Run as CLI only when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
