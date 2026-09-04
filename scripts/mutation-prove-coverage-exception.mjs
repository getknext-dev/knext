#!/usr/bin/env node
/**
 * Mutation proof for the coverage DATED EXCEPTION (sprint 2, lane G).
 *
 * WHAT IS BEING PROVED, AND WHY IT NEEDS PROVING
 * ----------------------------------------------
 * `branches` and `statements` left the coverage gate for a correct reason — bun's
 * lcov carries no `BRDA`/`BRF`/`BRH` — recorded as a paragraph. The paragraph was
 * replaced by `COVERAGE_METRIC_EXCEPTIONS` + `assertEveryMetricAccountedFor`,
 * which claim three things:
 *
 *   1. the exception EXPIRES, and expiry fails closed;
 *   2. an unknown key THROWS, so a typo'd `expiress` cannot become an exception
 *      that never expires while reading as one that does;
 *   3. the gate SCRIPT actually consults it — the wiring, not just the module.
 *
 * All three are exactly the kind of claim that passes review by inspection. (3)
 * in particular: `coverage-gate.test.ts:211-214` already stayed green through a
 * silent drop from 77 to 70, which is the same class one level up, so a wiring
 * assertion here gets mutated rather than trusted.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`)
 * ----------------------------------------
 *   - Every verdict branches on the runner's EXIT CODE. Output is never parsed:
 *     this repo has had 14 decorative mutations certified all-green by a
 *     pass/fail grep that ANSI defeated.
 *   - STEP 0 proves the harness can SEE RED before any green is trusted.
 *   - Anchored edits go through `scripts/lib/mutation-harness.mjs`, which refuses
 *     unless the anchor occurs EXACTLY ONCE and restores by content-addressed
 *     bytes.
 *   - M5 is a NEGATIVE control. Editing a `note` — the one field with no
 *     semantics — must leave the guard GREEN. Without it this proves only that
 *     the spec is sensitive to the file being touched at all.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/coverage-gate.test.ts';
const POLICY = join(REPO_ROOT, 'scripts/lib/coverage-policy.mjs');
const CHECKER = join(REPO_ROOT, 'scripts/check-coverage.mjs');

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

/** Run the spec. Returns ONLY the exit code — output is deliberately not parsed. */
function runSpec(spec) {
  const runner = resolveSpecRunner(REPO_ROOT, spec);
  const res = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (res.status === null) {
    throw new Error(`runner did not exit cleanly: ${res.signal ?? res.error}`);
  }
  return res.status;
}

const failures = [];

function check(id, description, expected, actual) {
  const ok = expected === actual;
  if (!ok) failures.push(`${id}: ${description} — exit ${actual}, expected ${expected}`);
  console.log(`   ${ok ? 'ok' : 'FAIL'}  ${id} exit=${actual} (want ${expected}) — ${description}`);
}

function assertTreeClean(label) {
  const dirty = git('status', '--porcelain')
    .split('\n')
    .filter((line) => line.trim() && !line.includes('.claude/'));
  if (dirty.length) throw new Error(`[${label}] working tree not clean:\n${dirty.join('\n')}`);
}

declareMutations(5);

console.log('── baseline: the unmutated guard is green');
assertTreeClean('baseline');
const policySnap = snapshot(POLICY);
const checkerSnap = snapshot(CHECKER);
if (runSpec(SPEC) !== 0) {
  console.error(
    'ABORT: the guard is not green before any mutation. Nothing below would mean anything.',
  );
  process.exit(1);
}

console.log('── STEP 0: can this harness observe RED at all?');
// Rather than plant a canary spec file, break the guard's own subject in the
// crudest possible way and require red. A harness that cannot see THIS cannot
// see anything below it.
mutate(policySnap, "metric: 'branches',", "metric: 'brunches',");
const canaryExit = runSpec(SPEC);
restore(policySnap);
if (canaryExit === 0) {
  console.error(
    'ABORT: renaming an excused metric left the guard GREEN. The harness cannot see red.',
  );
  process.exit(1);
}
console.log(`   ok  the harness sees red (canary exit=${canaryExit})`);
assertTreeClean('after canary');

console.log('\n── planting M1: the expiry date removed');
// The clock is the whole point of a dated exception. An entry with no `expires`
// must be rejected outright, not silently treated as permanent.
mutate(
  policySnap,
  "    expires: '2026-12-01',\n    note: \"Renew with a fresh measurement",
  '    note: "Renew with a fresh measurement',
);
check('M1', 'an exception with no `expires` is not an exception', 1, runSpec(SPEC));
recordMutation();
restore(policySnap);
assertTreeClean('after M1');

console.log('── planting M2: expiry stops failing closed (lapsed entries keep suppressing)');
mutate(
  policySnap,
  'if (new Date(`${entry.expires}T00:00:00Z`) <= now) continue; // lapsed — no longer suppresses',
  '// lapsed entries deliberately keep suppressing (the mutation)',
);
check('M2', 'a lapsed exception must stop excusing its metric', 1, runSpec(SPEC));
recordMutation();
restore(policySnap);
assertTreeClean('after M2');

console.log('── planting M3: an unknown key is IGNORED instead of throwing');
// The quietest way to neuter the clock: `expiress` parses as an entry with no
// expiry, so it never lapses while looking exactly like one that does.
mutate(
  policySnap,
  'const unknown = Object.keys(entry).filter((k) => !EXCEPTION_KEYS.has(k));',
  'const unknown = [];',
);
check('M3', "a typo'd key must THROW, never be dropped", 1, runSpec(SPEC));
recordMutation();
restore(policySnap);
assertTreeClean('after M3');

console.log('── planting M4: the GATE SCRIPT stops consulting the exceptions');
// The wiring, mutated rather than trusted. `coverage-gate.test.ts` has stayed
// green through a silent floor drop before; a module that is correct and unread
// is the same defect with better documentation.
mutate(
  checkerSnap,
  'assertEveryMetricAccountedFor(THRESHOLDS, activeMetricExceptions());',
  '// the gate no longer asks whether every metric is accounted for',
);
check('M4', 'check-coverage.mjs must call the accounting check', 1, runSpec(SPEC));
recordMutation();
restore(checkerSnap);
assertTreeClean('after M4');

console.log('── planting M5 (NEGATIVE control): a `note` reworded');
// `note` carries no semantics. If this reds, the spec is asserting on the file
// being touched rather than on the exception's meaning, and every green above
// would be worth less than it looks.
mutate(
  policySnap,
  "note: 'Only actionable if the gate gains an istanbul-shaped source",
  "note: 'Reworded by the negative control; only actionable if the gate gains an istanbul-shaped source",
);
check('M5', 'the guard must stay GREEN — `note` is prose, not policy', 0, runSpec(SPEC));
recordMutation();
restore(policySnap);
assertTreeClean('after M5');

console.log('\n── final state');
assertTreeClean('final');
console.log('   ok  subjects restored byte-identically; working tree clean');

if (failures.length) {
  console.error(`\n${failures.length} mutation(s) did NOT behave as required:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n5 mutation(s) behaved as required (4 red, 1 negative control green), 0 survived.');
