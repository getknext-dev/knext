#!/usr/bin/env node
/**
 * Mutation prover for the publish-lane guard (#2038, v2 R3a). Each mutant edits
 * `scripts/publish-lane-guard.mjs` (anchor must occur EXACTLY ONCE, else abort),
 * runs the guard specs, and must make them EXIT NON-ZERO. The verdict is the exit
 * code, never output text. The file is restored after every mutant; a final
 * `git diff --quiet` proves the tree is clean.
 *
 * A mutant that survives (specs exit 0) means a guard is decoration: exit 1.
 *
 * Usage: node scripts/prove-publish-lane-guard-mutants.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'scripts/publish-lane-guard.mjs');
const SPECS = ['tests/publish-lane-guard.test.ts', 'tests/ensure-published-group.test.ts'];

/** @type {Array<[string, string, string]>} name, anchor, replacement */
const MUTANTS = [
  [
    'drop the non-v2 pre.json rejection',
    "if (pre !== undefined && /** @type {{kind?: string}} */ (lane).kind === 'lane') {",
    'if (false) {',
  ],
  [
    'non-v2 rejection only for main',
    "if (pre !== undefined && /** @type {{kind?: string}} */ (lane).kind === 'lane') {",
    "if (pre !== undefined && lane.ref === 'refs/heads/main') {",
  ],
  [
    'non-v2 rejection never fires for release/1.x',
    "if (pre !== undefined && /** @type {{kind?: string}} */ (lane).kind === 'lane') {",
    "if (pre !== undefined && lane.ref !== 'refs/heads/release/1.x') {",
  ],
  [
    'v2 no longer requires pre.json',
    "if (pre === null || typeof pre !== 'object') {",
    'if (false) {',
  ],
  ['v2 mode comparison dropped', "if (mode !== 'pre') {", 'if (false) {'],
  ['v2 tag comparison dropped', 'if (actualTag !== tag) {', 'if (false) {'],
  [
    'lane map tag changed to rc',
    "new Map([['refs/heads/integration/v2', 'next']])",
    "new Map([['refs/heads/integration/v2', 'rc']])",
  ],
  ['CLI ignores pre problems', 'if (preProblems.length > 0) {', 'if (false) {'],
];

const run = () =>
  spawnSync('bun', ['test', ...SPECS], {
    cwd: ROOT,
    // The real-tree lane test reads GITHUB_BASE_REF; pin the pre-mode lane this tree is.
    env: { ...process.env, GITHUB_BASE_REF: 'integration/v2' },
    stdio: 'ignore',
  }).status;

const original = readFileSync(TARGET, 'utf8');
let survived = 0;
try {
  if (run() !== 0) {
    console.error('baseline specs are not green; refusing to mutate');
    process.exit(2);
  }
  for (const [name, anchor, replacement] of MUTANTS) {
    const hits = original.split(anchor).length - 1;
    if (hits !== 1) {
      console.error(`ABORT: anchor for "${name}" occurs ${hits} times (need exactly 1)`);
      process.exit(2);
    }
    writeFileSync(
      TARGET,
      original.replace(anchor, () => replacement),
    );
    const status = run();
    writeFileSync(TARGET, original);
    const killed = status !== 0;
    if (!killed) survived++;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${name} (exit ${status})`);
  }
} finally {
  writeFileSync(TARGET, original);
}
const clean = spawnSync('git', ['diff', '--quiet', '--', TARGET], { cwd: ROOT }).status === 0;
console.log(
  `restored: ${clean ? 'git diff clean' : 'DIRTY (expected only if the file has uncommitted edits)'}`,
);
process.exit(survived === 0 ? 0 : 1);
