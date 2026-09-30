#!/usr/bin/env node

/**
 * Mutation proof for the ratchet-floor guard (#1253).
 *
 * WHAT IS BEING PROVED
 * ---------------------
 * `scripts/lib/ratchet-floors.mjs` decides whether a marked floor went down
 * between two refs, and whether an allowlist entry legitimately exempts it.
 * Both halves must actually gate:
 *
 *   1. lowering an undetected floor is not silently accepted — breaking the
 *      comparison direction, or the marker scan, must red the spec;
 *   2. an INHERITED allowlist entry (present at base too) must NOT exempt a
 *      lowering — breaking the "introduced by this PR" check must red the spec.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`)
 * ----------------------------------------
 *   - Every verdict branches on the runner's EXIT CODE. Output is never parsed.
 *   - STEP 0 proves the harness can SEE RED before any green is trusted.
 *   - Edits go through `scripts/lib/mutation-harness.mjs`: each anchor must
 *     occur EXACTLY ONCE, and restores are byte-identical.
 *   - The last mutation is a NEGATIVE control: rewording a comment must stay green.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/ratchet-floor-guard.test.ts';
const SUBJECT = join(REPO_ROOT, 'scripts/lib/ratchet-floors.mjs');

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

/** Run a spec. Returns ONLY the exit code — output is deliberately not parsed. */
function runSpec(spec) {
  const runner = resolveSpecRunner(REPO_ROOT, spec);
  const res = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (res.status === null) {
    throw new Error(`runner did not exit cleanly: ${res.signal ?? res.error}`);
  }
  return res.status;
}

const failures = [];

function check(id, description, expected, actual) {
  const ok = expected === 0 ? actual === 0 : actual !== 0;
  if (!ok)
    failures.push(`${id}: ${description} — exit ${actual}, expected ${expected ? 'non-zero' : 0}`);
  console.log(`   ${ok ? 'ok' : 'FAIL'}  ${id} exit=${actual} — ${description}`);
}

// Scoped to only the files THIS prover touches, deliberately narrower than
// the repo-wide `scripts`/`tests` scope some sibling provers use: this prover
// can run alongside the full nightly lane (which mutates unrelated files all
// over `scripts/`), and a repo-wide status check would false-positive on the
// LANE's own in-flight, not-yet-restored mutation of some other file.
function assertTreeClean(label) {
  const dirty = git('status', '--porcelain', '--', SUBJECT, join(REPO_ROOT, SPEC))
    .split('\n')
    .filter((line) => line.trim());
  if (dirty.length) throw new Error(`[${label}] working tree not clean:\n${dirty.join('\n')}`);
}

function prove(id, description, snap, edits, expected) {
  console.log(`── ${id}: ${description}`);
  for (const [anchor, replacement] of edits) mutate(snap, anchor, replacement);
  try {
    check(id, description, expected, runSpec(SPEC));
  } finally {
    restore(snap);
  }
  recordMutation();
  assertTreeClean(`after ${id}`);
}

declareMutations(6);

console.log('── baseline: spec is green unmutated');
assertTreeClean('baseline');
const snap = snapshot(SUBJECT);
if (runSpec(SPEC) !== 0) {
  console.error('ABORT: the spec is red before any mutation. Nothing below would mean anything.');
  process.exit(1);
}

console.log('── STEP 0: can this harness observe RED at all?');
mutate(
  snap,
  "export const RATCHET_FLOOR_MARKER = '@ratchet-floor';",
  "export const RATCHET_FLOOR_MARKER = 'DISARMED';",
);
const canary = runSpec(SPEC);
restore(snap);
if (canary === 0) {
  console.error('ABORT: disarming the marker constant left the spec GREEN.');
  process.exit(1);
}
console.log(`   ok  the harness sees red (canary exit=${canary})`);
assertTreeClean('after canary');

prove(
  'M1',
  'flipping the lowered-comparison direction (< -> >) must red',
  snap,
  [
    [
      'if (headValue < baseValue && !introducedKeys.has(key)) {',
      'if (headValue > baseValue && !introducedKeys.has(key)) {',
    ],
  ],
  1,
);

prove(
  'M2',
  'dropping the allowlist-suppression check entirely (always flag) must red',
  snap,
  [['if (headValue < baseValue && !introducedKeys.has(key)) {', 'if (headValue < baseValue) {']],
  1,
);

prove(
  'M3',
  'treating an INHERITED allowlist entry (present at base) as introduced must red',
  snap,
  [
    [
      '.filter((entry) => !baseAllowlist.some((b) => b.file === entry.file && b.path === entry.path))',
      '.filter((entry) => true)',
    ],
  ],
  1,
);

prove(
  'M4',
  'no longer flattening object-leaf floors (only bare scalars) must red',
  snap,
  [["  if (value && typeof value === 'object' && !Array.isArray(value)) {", '  if (false) {']],
  1,
);

prove(
  'M5',
  'accepting a declaration NOT preceded by the marker (dropping the marker check) must red',
  snap,
  [['if (!lines[i].includes(RATCHET_FLOOR_MARKER)) continue;', 'if (false) continue;']],
  1,
);

console.log('── M6 (negative control): rewording a comment must stay GREEN');
mutate(
  snap,
  'export const RATCHET_FLOOR_MARKER = ',
  '// harmless reword\nexport const RATCHET_FLOOR_MARKER = ',
);
try {
  check('M6', 'a harmless comment reword must not red the spec', 0, runSpec(SPEC));
} finally {
  restore(snap);
}
recordMutation();
assertTreeClean('after M6');

if (failures.length) {
  console.error(`\n${failures.length} mutation(s) failed to prove:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('\nAll mutations proved as expected.');
