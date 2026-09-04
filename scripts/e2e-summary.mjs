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

// The run-tests.js test-FILE key token, shared by every marker/boundary regex so
// all of them resolve the SAME key universe (pass, fail, group open/close).
//
// #212 (runs 28699757721 + 28699158428, shards 3/16 + 7/16): the harness selects
// REAL scaffold files whose paths contain SPACES —
//   test/e2e/app-dir/test-template/{{ toFileName name }}/{{ toFileName name }}.test.ts
// run-tests.js counts them in its `total: N` header, runs them, and prints the
// normal per-file markers for them — but the old `test/\S+\.test\.\w+` token
// cannot cross a space, so the result was dropped while expectedTotal counted it:
// reported = expectedTotal - 1 with failed=0 → truncated:true on a genuinely
// green shard (the #194 guard false positive). The token is therefore LAZY
// same-line "anything" (`[^\r\n]*?`) between the anchors that carry the honesty
// guarantees from #147 fix round 1: it must START at the repo-root-relative
// `test/` prefix and END at `.test.<ext>` immediately before the verbatim
// run-tests.js marker suffix — so `}}.test.ts`-style JSON garbage (no `test/`
// prefix reaching a marker suffix) still never matches.
const FILE_TOKEN = String.raw`test\/[^\r\n]*?\.test\.`;

/**
 * How a failing test FILE failed (#545). Coarse on purpose — see the shape
 * comment inside summarize() for what each value does and does not claim.
 * @typedef {'timeout' | 'assertion' | 'unclassified'} FailureKind
 */

/**
 * One failing test FILE's attribution record.
 * @typedef {object} ShardFailure
 * @property {string} file repo-root-relative test file (run-tests.js's own key)
 * @property {FailureKind} kind
 * @property {number} [timeoutMs] present only when kind === 'timeout'
 * @property {string[]} cases failing case names, de-duplicated across retries
 */

/**
 * The summary artifact shape. Every optional key is OMITTED (not undefined)
 * when it does not apply, which is what keeps a green node artifact byte-stable
 * for the #41 matrix publisher — a consumer contract, not a style choice.
 * @typedef {object} ShardSummary
 * @property {number} passed
 * @property {number} failed
 * @property {number} notRun
 * @property {number} excluded
 * @property {string} ref
 * @property {string} shard
 * @property {string} runtime
 * @property {string} [runtimeVersion]
 * @property {string} [builder] #608 — 'vinext' on the compiled single-executable axis
 * @property {number} [expectedTotal]
 * @property {boolean} [truncated]
 * @property {ShardFailure[]} [failures] #545 — present only on a RED shard
 * @property {string[]} [notRunFiles] #545 — present only when a phantom abort occurred
 */

/**
 * Parse jest-style runner output + run metadata into the summary artifact shape.
 * @param {string} runnerOutput raw stdout from run-tests.js
 * @param {{ref:string, shard:string, excluded:number, runtime?:string, runtimeVersion?:string, builder?:string, expectedTotal?:number}} meta
 * @returns {ShardSummary}
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
  // #212: the token is the shared space-tolerant FILE_TOKEN (see its comment) —
  // `\S+` dropped the harness's real `{{ toFileName name }}` template paths and
  // false-positived the truncation guard.
  const runTestsPassed = new Set([
    ...collectTestFiles(
      text,
      new RegExp(String.raw`\bFinished\s+(${FILE_TOKEN}\w+)\s+on retry\s+\d+\/\d+`, 'g'),
    ),
    ...collectTestFiles(
      text,
      new RegExp(String.raw`(${FILE_TOKEN}\w+)\s+finished on retry\s+\d+\/\d+`, 'g'),
    ),
  ]);
  const runTestsFailedAll = collectTestFiles(
    text,
    new RegExp(String.raw`(${FILE_TOKEN}\w+)\s+failed to pass within\s+\d+\s+retries`, 'g'),
  );

  // HONESTY (A3-3): partition the run-tests.js "failed to pass within …" files
  // into REAL failures vs PHANTOM infra-aborts. A phantom is a file jest could
  // never LOCATE: its `❌ <file> output` group contains jest's
  //   `No tests found, exiting with code 1`
  // (no `next build`, no server boot, no assertion). Those must NOT inflate
  // `failed` — they are surfaced as `notRun`. A file with NO such marker in its
  // output group ran for real and its failure is genuine.
  // #545 (sprint-1 T1) — ONE scan of the run-tests.js output groups now yields
  // both the phantom set AND the per-file failure ATTRIBUTION (case names +
  // failure kind). See scanOutputGroups() for why attribution has to be
  // group-scoped rather than line-global.
  const groups = scanOutputGroups(text);
  const phantomFiles = new Set([...groups].filter(([, g]) => g.noTestsFound).map(([file]) => file));
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
    // #608 (the vinext AXIS): `runtime` says which process serves; it does NOT
    // say which ARTIFACT was served. Both lanes that run on bun would otherwise
    // be indistinguishable in the ledger — the retired bun-standalone weekly
    // booted `.next/standalone/server.js`, the vinext lane boots a COMPILED
    // SINGLE EXECUTABLE, and their pass counts mean different things. Same
    // omit-by-default discipline as `runtimeVersion`: absent on the
    // next-build lanes, so those artifacts stay byte-stable for the #41
    // publisher, and only an explicit 'vinext' records the compiled axis.
    ...(meta?.builder === 'vinext' ? { builder: 'vinext' } : {}),
    // #171 — truncated means "fewer results than the shard's selection count
    // were reported": a killed shard's partial green must never read as green.
    // failed AND notRun both count as reported results (a fully-reported red
    // shard is red, not truncated).
    ...(expectedTotal !== undefined
      ? { expectedTotal, truncated: passed + failed + notRun < expectedTotal }
      : {}),
    // #545 (sprint-1 T1) — ATTRIBUTION. Counts alone made "which test flaked?"
    // answerable only by downloading job logs, so a re-run erased the signal and
    // the flake rate stayed folklore. A red shard now NAMES its failing files,
    // their failing cases, and the failure KIND, in the same lane-labelled
    // artifact the matrix publisher already consumes.
    //
    // `kind` is deliberately coarse and honest:
    //   'timeout'  — the group contains jest's bare `Exceeded timeout of N ms
    //                for a test.` throw. That is a HANG signature, not slowness:
    //                the node lane's only shard-level red since 2026-07-05 (run
    //                29984259723, segment-cache/dynamic-on-hover) hit exactly
    //                60000 ms on all three retries, which is the #214 family
    //                signature upstream root-caused as vercel/next.js#95301.
    //                It means "at least one case in this file timed out", never
    //                "all did" — `cases` carries the rest.
    //   'assertion' — failing cases, no timeout throw.
    //   'unclassified' — the file failed with neither marker (e.g. a build
    //                abort). Named rather than swallowed.
    //
    // Both keys are OMITTED when empty so a GREEN shard's artifact stays
    // byte-stable for existing consumers (the #41 matrix publisher).
    ...(runTestsFailed.size > 0
      ? { failures: [...runTestsFailed].sort().map((file) => attributeFailure(file, groups)) }
      : {}),
    ...(runTestsNotRun.size > 0 ? { notRunFiles: [...runTestsNotRun].sort() } : {}),
  };
}

/**
 * Build the per-file failure record from its scanned output group.
 * @param {string} file
 * @param {Map<string, {noTestsFound:boolean, cases:Set<string>, timeoutMs:number|undefined}>} groups
 * @returns {ShardFailure}
 */
function attributeFailure(file, groups) {
  const g = groups.get(file);
  const cases = g ? [...g.cases].sort() : [];
  const kind =
    g?.timeoutMs !== undefined ? 'timeout' : cases.length > 0 ? 'assertion' : 'unclassified';
  return {
    file,
    kind,
    ...(g?.timeoutMs !== undefined ? { timeoutMs: g.timeoutMs } : {}),
    cases,
  };
}

/**
 * Scan run-tests.js's per-file output groups ONCE, collecting everything the
 * summary attributes per file.
 *
 * GROUP SCOPING IS LOAD-BEARING (A3-3, run 28318485456 — the ground truth this
 * parser is regression-tested against). run-tests.js runs files CONCURRENTLY
 * (-c 2) and interleaves their captured child output, bracketing each file's
 * slice between:
 *   open:  `❌ <file> output:`  /  `##[group]❌ <file> output`
 *   close: `end of <file> output`
 * Attributing a `✕ …` or a timeout throw by "nearest .test. token on the line"
 * would mis-assign a sibling's failure under concurrency — the same class of bug
 * that once counted the underscore JEST_JUNIT_OUTPUT_NAME echo as a distinct
 * file. Everything below is credited ONLY while a group is open.
 *
 * @param {string} text
 * @returns {Map<string, {noTestsFound:boolean, cases:Set<string>, timeoutMs:number|undefined}>}
 */
function scanOutputGroups(text) {
  const groups = new Map();
  const lines = String(text ?? '').split('\n');
  const groupOpenRe = new RegExp(String.raw`❌\s+(${FILE_TOKEN}(?:js|ts|jsx|tsx))\s+output\b`);
  const groupCloseRe = new RegExp(
    String.raw`^(?:.*\bend of\s+)(${FILE_TOKEN}(?:js|ts|jsx|tsx))\s+output\b`,
  );
  const noTestsRe = /No tests found, exiting with code 1/;
  // jest --verbose per-case FAIL line: `    ✕ <name> (<n> ms)`.
  const failedCaseRe = /✕\s+(.+?)\s+\(\d+(?:\.\d+)?\s*ms\)\s*$/;
  // jest's bare per-case timeout throw (the hardcoded 60s individualTestTimeout).
  const timeoutRe = /Exceeded timeout of (\d+) ms for a test/;
  let current = null;
  for (const line of lines) {
    const close = line.match(groupCloseRe);
    if (close) {
      current = null;
      continue;
    }
    const open = line.match(groupOpenRe);
    if (open) {
      current = open[1];
      if (!groups.has(current)) {
        groups.set(current, { noTestsFound: false, cases: new Set(), timeoutMs: undefined });
      }
      continue;
    }
    if (!current) continue;
    const g = groups.get(current);
    if (noTestsRe.test(line)) g.noTestsFound = true;
    const failedCase = line.match(failedCaseRe);
    // De-dup is inherent: run-tests.js reprints the ✕ line once per retry and
    // `cases` is a Set, so a 3-retry failure is ONE case, not three.
    if (failedCase) g.cases.add(failedCase[1].trim());
    const timeout = line.match(timeoutRe);
    if (timeout && g.timeoutMs === undefined) g.timeoutMs = Number(timeout[1]);
  }
  return groups;
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
    // #608 — the BUILD axis ('vinext' on the compiled single-executable lane;
    // absent/anything else on the next-build lanes). See summarize()'s shape note.
    builder: args.builder,
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
