/**
 * Mutation prover for the install-smoke alias-coverage guards.
 * Each mutation is applied ALONE and graded on the runner's EXIT CODE — never on grepped
 * output — then restored byte-identically with a clean-tree assertion on both sides.
 *
 * Two expectations, because a guard that reds on EVERYTHING is as useless as one that
 * never reds: `expect: 'red'` mutations remove the behaviour under test and must kill the
 * gate; `expect: 'green'` mutations are LEGITIMATE changes the guard must tolerate, and
 * they fail the prover if the gate reds on them.
 *
 * Run only against a COMMITTED tree — restores are `git checkout -- .`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const WT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = join(WT, 'scripts', 'install-smoke.mjs');
const CHANGESET = join(WT, '.changeset', 'config.json');
const ALIAS_DIR = join(WT, 'packages', 'kn-next-alias');
const ALIAS_PKG = join(ALIAS_DIR, 'package.json');
const ALIAS_BIN = join(ALIAS_DIR, 'bin', 'kn-next.js');
const SHAPE_SPEC = 'tests/install-smoke-coverage-derivation.test.ts';
const NEWPUB_DIR = join(WT, 'packages', 'newpub');
const LIB_PKG = join(WT, 'packages', 'lib', 'package.json');
const LOCKSTEP_SPEC = 'tests/publish-preflight.test.ts';
const STASH = join(tmpdir(), 'knext-alias-shim-stash.js');
/**
 * The paths this prover touches. The clean assertion is scoped to them, not
 * repo-wide: a repo-wide check aborts on any unrelated untracked file (a review
 * note, a stray build artifact), which fails closed but leaves the prover
 * unrunnable in a working checkout and reds the nightly lane for a non-finding.
 * Scoping keeps residue INSIDE the mutated paths caught, which is the residue
 * that could actually grade a later mutation against a dirty tree.
 */
const MUTATED_PATHS = [
  'scripts/install-smoke.mjs',
  '.changeset/config.json',
  'packages/kn-next-alias',
  'packages/newpub',
  'packages/lib/package.json',
];

const git = (...a) => execFileSync('git', a, { cwd: WT, encoding: 'utf8' });

function clean(when) {
  const st = git('status', '--porcelain', '--', ...MUTATED_PATHS).trim();
  if (st !== '') {
    console.error(`ABORT: tree not clean ${when}:\n${st}`);
    process.exit(1);
  }
}

/** Exactly-once anchored substitution. A miss ABORTS — a silent no-op would grade green. */
function mutate(file, anchor, replacement, checkOnly = false) {
  const s = readFileSync(file, 'utf8');
  const n = s.split(anchor).length - 1;
  if (n !== 1) {
    console.error(`ABORT: anchor occurs ${n}x in ${file} (expected 1)`);
    process.exit(1);
  }
  if (checkOnly) return;
  writeFileSync(file, s.replace(anchor, replacement));
}

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    guard: 'derived coverage — a PUBLISHABLE package this gate does not pack',
    apply: (checkOnly) => mutate(SMOKE, '    [aliasTarball, aliasPkgDir],\n', '', checkOnly),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M2',
    expect: 'red',
    graded: 'lockstep',
    guard:
      'the lockstep group loses a member — graded by the spec that OWNS that invariant, ' +
      'because this gate deliberately no longer reads `fixed`',
    // Round 2 of this prover caught its own obsolescence: while coverage derived from
    // `fixed`, this mutation reddened the gate. Now that coverage derives from the
    // PUBLISHABLE set (review finding B1), mutating `fixed` correctly cannot affect the
    // gate — it exited 0. That is the fix working, not a hole, but dropping a member
    // from `fixed` still ships a broken set, so the mutation moves to the guard that
    // owns it rather than being deleted.
    apply: (checkOnly) => mutate(CHANGESET, ', "kn-next"]]', ']]', checkOnly),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M8',
    expect: 'red',
    guard: 'the OTHER direction — a package this gate packs that no longer publishes',
    // M1 proves a publishable package left unpacked fails. This proves the converse,
    // which nothing else covered once M2 stopped applying: mark a packed package
    // private and it leaves the publishable set while still being packed.
    apply: (checkOnly) =>
      mutate(
        LIB_PKG,
        '"name": "@getknext/lib",',
        '"name": "@getknext/lib",\n  "private": true,',
        checkOnly,
      ),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M3',
    expect: 'red',
    guard: 'the alias declares a bin the tarball does not ship (pnpm pack exits 0 on this)',
    apply: () => renameSync(ALIAS_BIN, STASH),
    restore: () => {
      if (existsSync(STASH)) renameSync(STASH, ALIAS_BIN);
      git('checkout', '--', '.');
    },
  },
  {
    id: 'M4',
    expect: 'red',
    guard: 'the shim is shipped but does not forward to the real CLI',
    apply: () => writeFileSync(ALIAS_BIN, '#!/usr/bin/env node\nprocess.exit(3);\n'),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M5',
    expect: 'green',
    guard: 'FALSE-POSITIVE CHECK — renaming the shim AND its `bin` mapping together is legitimate',
    apply: () => {
      const pkg = JSON.parse(readFileSync(ALIAS_PKG, 'utf8'));
      pkg.bin = { 'kn-next': 'bin/cli.js' };
      writeFileSync(ALIAS_PKG, `${JSON.stringify(pkg, null, 2)}\n`);
      renameSync(ALIAS_BIN, join(ALIAS_DIR, 'bin', 'cli.js'));
    },
    restore: () => {
      const moved = join(ALIAS_DIR, 'bin', 'cli.js');
      if (existsSync(moved)) rmSync(moved);
      git('checkout', '--', '.');
    },
  },
  {
    id: 'M6',
    expect: 'red',
    graded: 'shape',
    guard: 'the derivation replaced by a hardcoded list that names every package publishable TODAY',
    apply: (checkOnly) =>
      mutate(
        SMOKE,
        '  const publishable = publishablePackages(\n' +
          '    readWorkspaceManifests(repoRoot),\n' +
          '    changesetConfig.ignore ?? [],\n' +
          '  ).map((p) => p.name);',
        "  const publishable = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];",
        checkOnly,
      ),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M9',
    expect: 'red',
    graded: 'shape',
    guard: "step 5's exports/bin completeness reverted to a hardcoded package list",
    // Round 2 of review found this uncovered by all eight declared mutations, and its
    // own mutation survived both graders. Graded by the shape spec because the gate
    // cannot see it: the derived and hardcoded forms check the same set TODAY.
    apply: (checkOnly) =>
      mutate(
        SMOKE,
        '  const entries = packed.map((p) => ({',
        '  const entries = [corePkgDir, libPkgDir, dbPkgDir].map((p) => ({',
        checkOnly,
      ),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M7',
    expect: 'red',
    graded: 'shape',
    guard:
      'a NEW publishable package that nobody adds to the gate (the review finding, reproduced)',
    apply: () => {
      mkdirSync(NEWPUB_DIR, { recursive: true });
      writeFileSync(
        join(NEWPUB_DIR, 'package.json'),
        `${JSON.stringify({ name: '@getknext/newpub', version: '0.3.1', main: 'index.js' }, null, 2)}\n`,
      );
      writeFileSync(join(NEWPUB_DIR, 'index.js'), 'module.exports = {};\n');
    },
    restore: () => {
      if (existsSync(NEWPUB_DIR)) rmSync(NEWPUB_DIR, { recursive: true, force: true });
      git('checkout', '--', '.');
    },
  },
];

const runSmoke = () =>
  spawnSync('node', ['scripts/install-smoke.mjs'], {
    cwd: WT,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  }).status;

/**
 * The PR-time half. The gate proves coverage is correct TODAY; it cannot catch a
 * derivation swapped for a hardcoded list that happens to name every package
 * publishable today and silently misses the next one. `SHAPE_SPEC` asserts the
 * derivation still exists, so mutations of that shape are graded here.
 */
const runSpec = (spec) => {
  const runner = resolveTestRunner(WT);
  return spawnSync(runner.command, [...runner.args, 'run', spec], {
    cwd: WT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  }).status;
};

// Preflight every anchored mutation BEFORE the first expensive run. An anchor
// invalidated by an unrelated edit used to surface as an abort seven mutations and
// twenty-five minutes in — which is how it surfaced on this very branch, when a
// hardening of `changesetConfig.ignore` moved the text M6 anchors on. It is still an
// ABORT and never a skip: a mutation whose anchor no longer matches proves nothing,
// and a prover that quietly carried on would report a clean sweep it did not run.
console.log('=== preflight: every anchored mutation must still match its subject ===');
const anchoredCount = MUTATIONS.filter((m) => m.apply.length > 0).length;
for (const m of MUTATIONS) {
  if (m.apply.length > 0) m.apply(true);
}
console.log(`preflight ok: ${anchoredCount} anchored mutation(s) still match`);

declareMutations(MUTATIONS.length);

clean('before the negative control');
console.log('=== negative control: unmutated tree must EXIT 0 (both graders) ===');
const ncShape = runSpec(SHAPE_SPEC);
console.log(`NC(shape) exit=${ncShape}`);
if (ncShape !== 0) {
  console.error(
    'ABORT: the shape spec is red before any mutation — M6/M7 would grade meaningless.',
  );
  process.exit(1);
}
const ncLock = runSpec(LOCKSTEP_SPEC);
console.log(`NC(lockstep) exit=${ncLock}`);
if (ncLock !== 0) {
  console.error(
    'ABORT: the lockstep spec is red before any mutation — M2 would grade meaningless.',
  );
  process.exit(1);
}
const nc = runSmoke();
console.log(`NC exit=${nc}`);
if (nc !== 0) {
  console.error('ABORT: the harness cannot see green — every mutation below would be meaningless.');
  process.exit(1);
}

const results = [];
for (const m of MUTATIONS) {
  clean(`before ${m.id}`);
  m.apply();
  if (git('status', '--porcelain', '--', ...MUTATED_PATHS).trim() === '') {
    console.error(`ABORT: ${m.id} changed nothing — it would grade for free.`);
    process.exit(1);
  }
  const status =
    m.graded === 'shape'
      ? runSpec(SHAPE_SPEC)
      : m.graded === 'lockstep'
        ? runSpec(LOCKSTEP_SPEC)
        : runSmoke();
  recordMutation();
  m.restore();
  clean(`after ${m.id}`);
  const ok = m.expect === 'red' ? status !== 0 : status === 0;
  results.push({ ...m, status, ok });
  const verdict = ok ? (m.expect === 'red' ? 'KILLED' : 'TOLERATED') : '*** FAILED ***';
  console.log(
    `${m.id} expect=${m.expect} graded=${m.graded ?? 'gate'} exit=${status} ${verdict} — ${m.guard}`,
  );
}

const bad = results.filter((r) => !r.ok);
console.log(
  `\ndeclared=${MUTATIONS.length} run=${results.length} passed=${results.length - bad.length}`,
);
if (results.length !== MUTATIONS.length) {
  console.error('ABORT: a partial run is a FAILURE, not a pass.');
  process.exit(1);
}
if (bad.length > 0) {
  console.error(`FAILED: ${bad.map((b) => `${b.id}(expected ${b.expect})`).join(', ')}`);
  process.exit(1);
}
console.log('every declared mutation graded as expected; tree restored byte-identically');
