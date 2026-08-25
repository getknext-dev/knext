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
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = join(WT, 'scripts', 'install-smoke.mjs');
const CHANGESET = join(WT, '.changeset', 'config.json');
const ALIAS_DIR = join(WT, 'packages', 'kn-next-alias');
const ALIAS_PKG = join(ALIAS_DIR, 'package.json');
const ALIAS_BIN = join(ALIAS_DIR, 'bin', 'kn-next.js');
const STASH = join(tmpdir(), 'knext-alias-shim-stash.js');

const git = (...a) => execFileSync('git', a, { cwd: WT, encoding: 'utf8' });

function clean(when) {
  const st = git('status', '--porcelain').trim();
  if (st !== '') {
    console.error(`ABORT: tree not clean ${when}:\n${st}`);
    process.exit(1);
  }
}

/** Exactly-once anchored substitution. A miss ABORTS — a silent no-op would grade green. */
function mutate(file, anchor, replacement) {
  const s = readFileSync(file, 'utf8');
  const n = s.split(anchor).length - 1;
  if (n !== 1) {
    console.error(`ABORT: anchor occurs ${n}x in ${file} (expected 1)`);
    process.exit(1);
  }
  writeFileSync(file, s.replace(anchor, replacement));
}

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    guard: 'derived coverage — a `fixed` member this gate does not pack',
    apply: () => mutate(SMOKE, '    [aliasTarball, aliasPkgDir],\n', ''),
    restore: () => git('checkout', '--', '.'),
  },
  {
    id: 'M2',
    expect: 'red',
    guard: 'derived coverage — a packed package the release set does not publish',
    apply: () => mutate(CHANGESET, ', "kn-next"]]', ']]'),
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
];

const runSmoke = () =>
  spawnSync('node', ['scripts/install-smoke.mjs'], {
    cwd: WT,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  }).status;

clean('before the negative control');
console.log('=== negative control: unmutated tree must EXIT 0 ===');
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
  if (git('status', '--porcelain').trim() === '') {
    console.error(`ABORT: ${m.id} changed nothing — it would grade for free.`);
    process.exit(1);
  }
  const status = runSmoke();
  m.restore();
  clean(`after ${m.id}`);
  const ok = m.expect === 'red' ? status !== 0 : status === 0;
  results.push({ ...m, status, ok });
  const verdict = ok ? (m.expect === 'red' ? 'KILLED' : 'TOLERATED') : '*** FAILED ***';
  console.log(`${m.id} expect=${m.expect} exit=${status} ${verdict} — ${m.guard}`);
}

const bad = results.filter((r) => !r.ok);
console.log(`\ndeclared=${MUTATIONS.length} run=${results.length} passed=${results.length - bad.length}`);
if (results.length !== MUTATIONS.length) {
  console.error('ABORT: a partial run is a FAILURE, not a pass.');
  process.exit(1);
}
if (bad.length > 0) {
  console.error(`FAILED: ${bad.map((b) => `${b.id}(expected ${b.expect})`).join(', ')}`);
  process.exit(1);
}
console.log('every declared mutation graded as expected; tree restored byte-identically');
