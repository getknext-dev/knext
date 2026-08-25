#!/usr/bin/env node
/**
 * Mutation proof for `tests/no-committed-transform-cache.test.ts` (#545, #710).
 *
 * WHAT THE GUARD CLAIMS, AND WHY IT NEEDS PROVING
 * ------------------------------------------------
 * Commit `8a805bb` shipped 978 lines of Vite SSR transform cache under a random
 * 21-char root directory, inside a commit whose message declared only a
 * one-file docs change. The guard exists so that cannot recur. Its central
 * claim is NOT "that directory is gone" — it is that the output is caught by
 * CONTENT, under any name and at any depth, so a future cache under a new
 * random name is caught without anyone updating a list.
 *
 * That claim is exactly the kind that passes review by inspection and fails in
 * practice, so it is proved here by mutation rather than asserted. M2 is the
 * one that matters: same content, unrelated path. A name-based guard sails
 * through it and the "cannot come back" claim would be false.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`)
 * ----------------------------------------
 *   - Every verdict branches on the runner's EXIT CODE. This repo has already
 *     had 14 decorative mutations certified all-green by a pass/fail grep that
 *     vitest's ANSI defeated; output is never parsed here.
 *   - STEP 0 proves the harness can SEE RED before any green is trusted. A
 *     runner that always exits 0 would certify every mutation below while
 *     nothing ran at all.
 *   - Anchored edits go through `scripts/lib/mutation-harness.mjs`, which
 *     refuses unless the anchor occurs EXACTLY ONCE, restores by content-
 *     addressed bytes, and re-asserts every anchor afterwards.
 *   - M6 is a NEGATIVE control. Deleting the `.gitignore` rule must leave the
 *     guard GREEN, proving the two layers are independent and that the guard's
 *     protection is not an artifact of the ignore rule. A prover with no
 *     negative control cannot tell a guard from a tripwire.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = 'tests/no-committed-transform-cache.test.ts';
const GUARD_ABS = join(REPO_ROOT, GUARD);
const NANOID_DIR = 'DlmvdBjTqJS8cyZMNX2T5';
const CANARY = 'tests/__canary-transform-cache-harness.test.ts';

/**
 * The transform-cache marker, assembled from parts for the same reason the
 * guard assembles it: this file is tracked, and the guard refuses any tracked
 * file containing the literal. If it appeared here the prover would trip the
 * guard it exists to prove, and the inevitable "fix" would be an allowlist —
 * the silent exemption the guard must not have.
 */
const MARKER = ['__vite', 'ssr', 'import__'].join('_');

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Run a spec. Returns ONLY the exit code — output is deliberately not parsed. */
function runSpec(spec) {
  const runner = resolveTestRunner(REPO_ROOT);
  const res = spawnSync(runner.command, [...runner.args, 'run', spec], {
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
  return ok;
}

/**
 * The tree must be clean between mutations. `git status --porcelain` is checked
 * rather than assumed: a mutation that survives a stall is the incident this
 * repo's harness was built for.
 */
function assertTreeClean(label) {
  const dirty = git('status', '--porcelain')
    .split('\n')
    .filter((line) => line.trim() && !line.includes('.claude/'));
  if (dirty.length) {
    throw new Error(`[${label}] working tree not clean:\n${dirty.join('\n')}`);
  }
}

/** Stage a file that .gitignore would otherwise hide — the careless `git add -f` path. */
function addForced(relPath, contents) {
  const abs = join(REPO_ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  git('add', '-f', relPath);
}

function unstageAndDelete(relPath, rootDir) {
  git('rm', '-q', '-f', '--cached', relPath);
  rmSync(join(REPO_ROOT, rootDir ?? relPath), { recursive: true, force: true });
}

declareMutations(8);

console.log('── baseline: the unmutated guard is green');
assertTreeClean('baseline');
const baseSnap = snapshot(GUARD_ABS);
if (runSpec(GUARD) !== 0) {
  console.error(
    'ABORT: the guard is not green before any mutation. Nothing below would mean anything.',
  );
  process.exit(1);
}

console.log('── STEP 0: can this harness observe RED at all?');
const canaryAbs = join(REPO_ROOT, CANARY);
writeFileSync(
  canaryAbs,
  [
    "import { describe, expect, it } from 'vitest';",
    "describe('canary', () => {",
    "  it('fails on purpose so the harness proves it can see red', () => {",
    '    expect(1).toBe(2);',
    '  });',
    '});',
    '',
  ].join('\n'),
);
const canaryExit = runSpec(CANARY);
rmSync(canaryAbs, { force: true });
if (canaryExit !== 1) {
  console.error(
    `ABORT: a deliberately failing spec exited ${canaryExit}, not 1. The harness cannot see red, so every green below is meaningless.`,
  );
  process.exit(1);
}
console.log('   ok  the harness sees red (canary exit=1)');
assertTreeClean('after canary');

console.log('\n── planting M1: the original transform cache, reinstated and tracked');
const m1 = `${NANOID_DIR}/client/e2924c856f4e1566b0f1adbaff216b2f2456a8ab`;
addForced(
  m1,
  `const ${MARKER}_0__ = await ${MARKER}("/node_modules/.pnpm/vitest/dist/index.js");\n`,
);
check('M1', 'the exact defect from 8a805bb', 1, runSpec(GUARD));
recordMutation();
unstageAndDelete(m1, NANOID_DIR);
assertTreeClean('after M1');

console.log('── planting M2: the SAME content under an unrelated name and depth');
const m2 = 'docs/compat/.cache-restored-by-mistake.txt';
addForced(m2, `const ${MARKER}_3__ = await ${MARKER}("/some/module.js");\n`);
check('M2', 'content match is name-independent (the central claim)', 1, runSpec(GUARD));
recordMutation();
unstageAndDelete(m2);
assertTreeClean('after M2');

console.log('── planting M3: a nanoid-shaped cache dir carrying NO marker');
const m3 = 'AbCdEfGhIjKlMnOpQrStU/client/deadbeef';
addForced(m3, 'nothing recognisable in here at all\n');
check('M3', 'the path check fires independently of the content check', 1, runSpec(GUARD));
recordMutation();
unstageAndDelete(m3, 'AbCdEfGhIjKlMnOpQrStU');
assertTreeClean('after M3');

console.log('── planting M4: the corpus emptied (the vacuous-scan protection)');
mutate(
  baseSnap,
  ".split('\\0')\n    .filter(Boolean);",
  ".split('\\0')\n    .filter(() => false);",
);
check('M4', 'a scan reaching zero files must not pass as "no marker found"', 1, runSpec(GUARD));
recordMutation();
restore(baseSnap);
assertTreeClean('after M4');

console.log('── planting M5: the marker written verbatim into the guard itself');
mutate(
  baseSnap,
  "const PROSE_ALLOWED = new Set(['.gitignore']);",
  `const PROSE_ALLOWED = new Set(['.gitignore']);\n// leaked: ${MARKER}`,
);
check('M5', 'the guard is not exempt from its own scan', 1, runSpec(GUARD));
recordMutation();
restore(baseSnap);
assertTreeClean('after M5');

console.log('── planting M6 (NEGATIVE control): the .gitignore shape rule deleted');
const giSnap = snapshot(join(REPO_ROOT, '.gitignore'));
const shapeRule = `/${'[A-Za-z0-9_-]'.repeat(21)}/client/`;
// `commentPrefix` is required: the harness knows no comment syntax for a
// `.gitignore`, and it refuses to plant an UNMARKED mutation rather than
// leaving residue no scan could find.
mutate(giSnap, shapeRule, '# shape rule removed by the negative control', {
  commentPrefix: '#',
});
check('M6', 'the guard must stay GREEN — the two layers are independent', 0, runSpec(GUARD));
recordMutation();
restore(giSnap);
assertTreeClean('after M6');

// M7 and M8 pin the two evasion axes that round-2 review found in the first
// version of this guard, which skipped any file over 4 MB and any file
// containing a NUL byte. Both scanned GREEN with the marker present. The guard
// now scans BYTES in bounded chunks, so both are covered — and these two
// mutations are what stop that silently regressing into a skip again.
console.log('── planting M7: the marker inside an OVERSIZED file (the old 4 MB cap)');
const m7 = 'docs/compat/.oversized-cache-probe.txt';
addForced(
  m7,
  `${'x'.repeat(4.9 * 1024 * 1024)}\nconst ${MARKER}_9__ = await ${MARKER}("/late/in/a/big/file.js");\n`,
);
check('M7', 'size is not an exemption — a 4.9 MB file is still scanned', 1, runSpec(GUARD));
recordMutation();
unstageAndDelete(m7);
assertTreeClean('after M7');

console.log('── planting M8: the marker in a file carrying a NUL byte (the old binary skip)');
const m8 = 'docs/compat/.nul-padded-cache-probe.txt';
addForced(
  m8,
  `${String.fromCharCode(0)}binary-looking padding\nconst ${MARKER}_4__ = await ${MARKER}("/mod.js");\n`,
);
check(
  'M8',
  '"binary" is not an exemption — a NUL byte no longer hides the marker',
  1,
  runSpec(GUARD),
);
recordMutation();
unstageAndDelete(m8);
assertTreeClean('after M8');

console.log('\n── residue and final state');
if (existsSync(join(REPO_ROOT, NANOID_DIR))) {
  throw new Error('cache-directory residue survived the proof');
}
// `git grep` exits 1 when nothing matches — that is the state we require. The
// .gitignore documents the marker in prose and is excluded by path.
const residue = spawnSync('git', ['grep', '-l', MARKER, '--', '.', ':!.gitignore'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
});
if (residue.status !== 1) {
  throw new Error(`marker residue in tracked files:\n${residue.stdout}`);
}
console.log('   ok  no marker residue in tracked files (git grep exit=1)');
assertTreeClean('final');
console.log('   ok  guard restored byte-identically; working tree clean');

if (failures.length) {
  console.error(`\n${failures.length} mutation(s) did NOT behave as required:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n8 mutation(s) behaved as required (7 red, 1 negative control green), 0 survived.');
