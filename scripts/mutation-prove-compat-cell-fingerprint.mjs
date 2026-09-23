#!/usr/bin/env node
/**
 * Mutation proof for the #1294 guards in `tests/compat-window-fingerprint.test.ts`,
 * `tests/compat-vinext-lane.test.ts` and `tests/compat-window-audit.test.ts`:
 *
 *   1. PER-CELL WORKFLOW ENTRY — `workflowRootForLane` must resolve each lane's
 *      OWN executing workflow (`compat-vinext.yml` for the vinext cells) from
 *      the ONE declared table (`CREDENTIAL_CELLS`), not a hardcoded
 *      `test-e2e-deploy.yml`. This is the mutation named in round 1's exit
 *      criteria: DROP `compat-vinext.yml` from the inputs by reverting to the
 *      pre-#1294 hardcode, and the spec must go RED.
 *   2. `--lane` MUST ACTUALLY SELECT — a lane argument that gets computed but
 *      then discarded (falling back to the default lane always) is
 *      indistinguishable from no lane support at all.
 *   3. THE IMPORT/SOURCE CLOSURE MUST ACTUALLY RUN — round 1's directory-
 *      pattern `scripts/lib` root only saw `e2e-*`-prefixed files, so
 *      `scripts/e2e-preflight.mjs`'s imports of `./lib/knext-closure.mjs` and
 *      `./lib/workspace-protocol.mjs` (neither `e2e-`-prefixed) stayed
 *      invisible to the digest — round 2's exact finding. Disarming the
 *      closure loop must remove EVERYTHING it swept in (shell-sourced
 *      `e2e-state-snapshot.sh` included).
 *   4. THE JS `from` IMPORT MUST STILL BE DETECTED post-tokenizer (round 2's
 *      review comment, re-anchored on the round-3 tokenizer rewrite): remove
 *      `knext-closure.mjs` from the computed closure by disabling the
 *      token-stream `from` context check, and the spec must go RED.
 *   5. THE TOKENIZER MUST ACTUALLY STRIP COMMENTS (round 3, jev 0.90) — a
 *      regex over RAW source hard-errors the WHOLE fingerprint on a comment
 *      that merely MENTIONS an import-like path to a file that does not
 *      exist. Reverting `jsImportSpecifiers` to scan raw, untokenized source
 *      must bring that false hard-error back.
 *   6. THE DECLARED `extraFiles` (round 3) MUST ACTUALLY BE APPLIED — THE
 *      mutation named in round 3's exit criteria: remove
 *      `compat-credential-ref.mjs` (and its `extraFiles` siblings) from the
 *      computed closure by disarming the loop that adds them, and the spec
 *      must go RED.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration. Each mutation below deletes one piece of behaviour and requires
 * the spec to go RED, then GREEN again after restore — both directions,
 * because a spec that never recovers proves the restore is broken, not the
 * guard.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise —
 *     a silently-failed substitution would certify a decorative guard green;
 *   * `declareMutations`/`recordMutation` — the lane can tell 5-of-6 from
 *     6-of-6;
 *   * judged on EXIT CODES, never on grepped output — vitest/bun:test write
 *     ANSI, and a pass/fail grep over it once certified fourteen decorative
 *     mutations green.
 *
 * Usage:  node scripts/mutation-prove-compat-cell-fingerprint.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FINGERPRINT = resolve(REPO_ROOT, 'scripts/compat-window-fingerprint.mjs');
const SPECS = [
  'tests/compat-window-fingerprint.test.ts',
  'tests/compat-vinext-lane.test.ts',
  'tests/compat-window-audit.test.ts',
  'tests/compat-credential-ref.test.ts',
];

declareMutations(6);

const RUNNERS = SPECS.map((spec) => ({ spec, runner: resolveSpecRunner(REPO_ROOT, spec) }));

/** True when EVERY spec in SPECS passed. Exit code only — never the output. */
function specsPass() {
  for (const { spec, runner } of RUNNERS) {
    const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (r.status !== 0) return false;
  }
  return true;
}

let pass = 0;
let fail = 0;

// Every mutation below lands in FINGERPRINT — the module-level const bound to
// a literal repo-relative path above, which the static prover-anchor audit
// (`scripts/lib/prover-lane.mjs`) recognises. Do not thread a `target`
// parameter through this wrapper: the audit resolves `mutate(snap, …)`'s
// subject by tracing `snap = snapshot(<ident>)` back to a directly-bound
// path const, not through an intermediate function parameter — a `target`
// parameter would make every mutation here invisible to that audit.
function prove(label, anchor, replacement) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(FINGERPRINT);
  try {
    mutate(snap, anchor, replacement);
    if (specsPass()) {
      console.log('   x DECORATION: the specs stayed GREEN with the behaviour removed');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specsPass()) {
    console.error(`   FATAL: ${SPECS.join(', ')} did not go green again after restore`);
    process.exit(1);
  }
}

// The harness must be able to SEE red before any verdict it gives means
// anything: specs that are already red would make every mutation look "caught".
console.log('Baseline: the specs must be GREEN before anything is mutated.');
if (!specsPass()) {
  console.error(`FATAL: ${SPECS.join(', ')} are not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// 1. THE mutation named in round 1's exit criteria: drop compat-vinext.yml
//    from a vinext cell's inputs by reverting `workflowRootForLane` to the
//    pre-#1294 hardcode. Every lane, including bun-vinext, would fingerprint
//    test-e2e-deploy.yml again — exactly the bug #1294 exists to close.
prove(
  'per-cell workflow entry: hardcode every lane back to test-e2e-deploy.yml',
  "  return { kind: 'file', path: `.github/workflows/${cell.workflowFile}` };",
  "  return { kind: 'file', path: '.github/workflows/test-e2e-deploy.yml' };",
);

// 2. Stop actually USING the caller's `lane` — every call fingerprints the
//    default lane regardless of what was requested.
prove(
  '--lane is computed but discarded: collectHarness always uses CREDENTIAL_LANE',
  'const harness = collectHarness(repoRoot, lane, { workflowFile });',
  'const harness = collectHarness(repoRoot, CREDENTIAL_LANE, { workflowFile });',
);

// 3. Stop running the import/source closure at all — everything it swept in
//    (shell-sourced `e2e-state-snapshot.sh` AND every JS import) vanishes
//    from the frozen set, reopening the #1280 gap wholesale.
prove(
  'closure loop disarmed: entry scripts stop reaching anything beyond themselves',
  'for (const abs of closureFrom(closureEntries)) {',
  'for (const abs of []) {',
);

// 4. Round 2's named mutation, re-anchored on the round-3 tokenizer: remove
//    `knext-closure.mjs` from the computed closure by disabling the
//    token-stream `from` context check — while leaving `require()`, dynamic
//    `import()` and the bare-`import` check intact — removes exactly that
//    one dependency (its only detection path) and nothing else.
prove(
  "remove knext-closure.mjs from the computed closure: disable the 'from' context check",
  '/\\bfrom\\s*$/.test(tail) ||',
  'false ||',
);

// 5. THE round-3 main finding, reproduced EXACTLY: short-circuit
//    `jsImportSpecifiers` to the pre-round-3 raw regex (a `from '…'` match
//    over untokenized source, comments included) instead of the token
//    stream. The rest of the real function becomes dead code inside a stub
//    (still syntactically valid — same closing brace), so a decoy comment
//    hard-errors the whole fingerprint again, exactly as it did before this
//    fix.
prove(
  'tokenizer bypassed: jsImportSpecifiers scans raw source (comments included), so a decoy comment hard-errors',
  'function jsImportSpecifiers(src) {\n  const tokens = tokenizeJs(src);',
  'function jsImportSpecifiers(src) {\n  const specs = [];\n  for (const m of src.matchAll(/\\bfrom\\s+[\'\\"](\\.\\.?\\/[^\'\\"]+)[\'\\"]/g)) specs.push(m[1]);\n  return specs;\n}\nfunction unusedPreRound3Tokenizer(src) {\n  const tokens = tokenizeJs(src);',
);

// 6. THE round-3 exit-criterion mutation: remove `compat-credential-ref.mjs`
//    (and its `extraFiles` siblings — `compat-run-ledger.mjs`,
//    `.github/compat-credential-ref.json`) from the computed closure by
//    disarming the loop that applies `CREDENTIAL_CELLS[lane].extraFiles`.
prove(
  'remove compat-credential-ref.mjs from the closure: disarm the extraFiles loop',
  'for (const relPath of cell?.extraFiles ?? []) {',
  'for (const relPath of []) {',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
