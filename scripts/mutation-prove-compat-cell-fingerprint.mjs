#!/usr/bin/env node
/**
 * Mutation proof for the #1294 guards in `tests/compat-window-fingerprint.test.ts`,
 * `tests/compat-vinext-lane.test.ts`, `tests/compat-window-audit.test.ts`,
 * `tests/compat-credential-ref.test.ts` and
 * `tests/compat-window-fingerprint-execution-scan.test.ts`:
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
 *   4. IMPORT/EXPORT *DECLARATIONS* MUST STILL BE DETECTED (round 5's parser
 *      rewrite, re-anchored from round 2's original finding): disabling the
 *      `ts.isImportDeclaration`/`ts.isExportDeclaration` branch — leaving
 *      `require()`/dynamic `import()` call detection intact — must remove
 *      `knext-closure.mjs` (a plain `import { … } from '…'`) from the
 *      closure and nothing else.
 *   5. THE PARSER MUST ACTUALLY RUN, NOT A STUB — disarming the whole AST
 *      walk (`jsLocalImportSpecifiers` returns `[]` unconditionally) must
 *      remove EVERY JS-detected dependency: round 5's own regression tests
 *      (a regex after a keyword, a nested template literal) as well as the
 *      real-repo `knext-closure.mjs`/`workspace-protocol.mjs` imports.
 *   6. THE DECLARED `extraFiles` (round 3) MUST ACTUALLY BE APPLIED — THE
 *      mutation named in round 3's exit criteria: remove
 *      `compat-credential-ref.mjs` (and its `extraFiles` siblings) from the
 *      computed closure by disarming the loop that adds them, and the spec
 *      must go RED.
 *   7. A DECLARED EXTRA'S OWN IMPORTS MUST BE FOLLOWED (round 4, jev 0.75, THE
 *      main finding): `compat-run-ledger.mjs` imports
 *      `./compat-credential-ref.mjs`, and extras are now fed into the SAME
 *      closure walk as every other entry point — disarming just that feed
 *      (not the direct `addEntry` for the extra itself) must reopen the gap.
 *   8. FAIL-CLOSED on a NON-LITERAL require()/import() specifier (round 5,
 *      jev 0.90's fix, not its finding): a computed specifier MIGHT be
 *      relative, and skipping it silently (which a broken `addSpecifier`
 *      that stops throwing and just returns would do) reopens the "silently
 *      unfrozen dependency" failure mode one layer up.
 *   9. FAIL-CLOSED on a file that does not PARSE AT ALL (round 5): disarming
 *      the `ts.transpileModule` syntax-diagnostics check — which runs
 *      BEFORE the (deliberately error-tolerant) AST walk — must let an
 *      unterminated string/regex silently fall through to a best-effort,
 *      possibly-wrong parse instead of refusing outright.
 *  10. #1422 — `NAMED_EXCEPTIONS` in
 *      `tests/compat-window-fingerprint-execution-scan.test.ts` must stay
 *      SCOPED PER SOURCE FILE via `isNamedException` (exact (source, path)
 *      pair), never per lane or global. Two mutations: ignoring `source`, and
 *      ignoring `path`, must each go RED against the unit coverage.
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
 *   * `declareMutations`/`recordMutation` — the lane can tell 8-of-9 from
 *     9-of-9;
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
const EXECUTION_SCAN_SPEC_PATH = resolve(
  REPO_ROOT,
  'tests/compat-window-fingerprint-execution-scan.test.ts',
);
const SPECS = [
  'tests/compat-window-fingerprint.test.ts',
  'tests/compat-vinext-lane.test.ts',
  'tests/compat-window-audit.test.ts',
  'tests/compat-credential-ref.test.ts',
  'tests/compat-window-fingerprint-execution-scan.test.ts',
];

declareMutations(11);

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

/** Exit code of ONLY the mutated spec — no timing, no output parsing. */
function execScanSpecPasses() {
  const spec = 'tests/compat-window-fingerprint-execution-scan.test.ts';
  const { runner } = RUNNERS.find((r) => r.spec === spec);
  const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
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

// #1422 — same contract as `prove` above, but the subject is
// EXECUTION_SCAN_SPEC_PATH (the execution-scan spec's own guard logic, not
// FINGERPRINT). A SEPARATE function, not a `target` parameter on `prove`,
// for the same static-audit reason documented above `prove`.
function proveOnExecutionScanSpec(label, anchor, replacement) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(EXECUTION_SCAN_SPEC_PATH);
  try {
    mutate(snap, anchor, replacement);
    if (execScanSpecPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
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

// 4. Round 5's parser rewrite, round 2's original finding re-anchored:
//    disable import/export DECLARATION detection specifically (leaving
//    require()/dynamic import() intact) — `knext-closure.mjs` is reached via
//    a plain `import { … } from '…'`, so this removes exactly that
//    dependency's only detection path.
prove(
  'import/export DECLARATIONS stop being detected: disable the ts.isImportDeclaration/isExportDeclaration branch',
  'if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {',
  'if (false) {',
);

// 5. THE round-5 exit criterion: stop running the parser at all.
//    `jsLocalImportSpecifiers` becomes a stub that finds nothing, so every
//    JS-detected dependency vanishes — the real-repo imports AND round 5's
//    own keyword-regex / nested-template regression tests.
prove(
  'the AST walk is disarmed: jsLocalImportSpecifiers returns [] unconditionally',
  'function jsLocalImportSpecifiers(src, absPath) {',
  'function jsLocalImportSpecifiers(src, absPath) {\n  return [];\n}\nfunction unusedRound5Walk(src, absPath) {',
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

// 7. THE round-4 main finding's named mutation: stop feeding a declared extra
//    into the import/source closure walk. `compat-run-ledger.mjs` imports
//    `./compat-credential-ref.mjs`; on bun-vinext (which declares
//    run-ledger.mjs but NOT credential-ref.mjs directly) that import is the
//    ONLY reason credential-ref.mjs is frozen at all. Disarming just the
//    `closureEntries.push` (leaving the direct `addEntry` for the extra
//    itself intact) reopens exactly that gap without touching mutation 6's
//    behaviour.
prove(
  "an extraFiles entry's OWN imports stop being followed: disarm closureEntries.push for extras",
  'addEntry(relPath, abs);\n    closureEntries.push(abs);',
  'addEntry(relPath, abs);',
);

// 8. THE round-5 fail-closed fix: a require()/import() whose specifier is
//    NOT a string literal must be a hard error. Disarming `addSpecifier`'s
//    literal check makes it silently push nothing for a non-literal
//    specifier instead of throwing — a computed relative path would then be
//    silently invisible to the closure, exactly the failure mode this
//    exists to close.
prove(
  'non-literal require()/import() specifier stops being a hard error: silently skip it instead',
  'specs.push(node.text);\n      return;\n    }\n    const { line: lineNumber } = sourceFile.getLineAndCharacterOfPosition(\n      callOrDeclNode.getStart(sourceFile),\n    );\n    throw new Error(\n      `compat-window fingerprint: ${absPath}:${lineNumber + 1} references a module with a NON-LITERAL specifier.',
  'specs.push(node.text);\n      return;\n    }\n    return;\n    const { line: lineNumber } = sourceFile.getLineAndCharacterOfPosition(\n      callOrDeclNode.getStart(sourceFile),\n    );\n    throw new Error(\n      `compat-window fingerprint: ${absPath}:${lineNumber + 1} references a module with a NON-LITERAL specifier.',
);

// 9. THE round-5 fail-closed fix, the syntax-error half: a file that does
//    not parse at all (unterminated string/regex, among other syntax
//    errors) must be a hard error BEFORE the error-tolerant
//    `ts.createSourceFile` walk ever runs. Disarming the diagnostics check
//    lets a malformed file fall through to a silent, possibly-wrong
//    best-effort parse.
prove(
  'the syntax-error fail-closed check is disarmed: a file that does not parse is walked anyway',
  'if (syntaxErrors.length > 0) {',
  'if (false) {',
);

// 10. #1422 — `isNamedException` must key on the exact (source, path) pair.
//     Each anchor is asserted to occur exactly once by `mutate` (abort
//     otherwise); the verdict is the specs' exit code, never their output.
const IS_NAMED_ANCHOR =
  'return NAMED_EXCEPTIONS.some((e) => e.path === ref && e.sources.includes(source));';
proveOnExecutionScanSpec(
  'isNamedException stops checking the source file: any file referencing a named path is exempt (#1422)',
  IS_NAMED_ANCHOR,
  'return NAMED_EXCEPTIONS.some((e) => e.path === ref);',
);
proveOnExecutionScanSpec(
  'isNamedException stops checking the path: any reference from a named source is exempt (#1422)',
  IS_NAMED_ANCHOR,
  'return NAMED_EXCEPTIONS.some((e) => e.sources.includes(source));',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
