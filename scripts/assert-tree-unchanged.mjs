#!/usr/bin/env node
/**
 * #1989 — fail a CI run whose test suite leaves files in the working tree.
 *
 *   node scripts/assert-tree-unchanged.mjs snapshot <file>   # before the suite
 *   node scripts/assert-tree-unchanged.mjs check <file>      # after the suite
 *
 * `snapshot` records `git status --porcelain --untracked-files=all`; `check`
 * re-runs it and exits 1 listing every entry that was not in the snapshot.
 * Ignored files are invisible to git status by design, so this catches the
 * leak class that bit us (a test staging `Dockerfile.standalone` /
 * `knext-standalone-entry.mjs` into the repo root), not every stray byte.
 *
 * The repo is the process CWD, or `KNEXT_TREE_GUARD_REPO` (used by the test to
 * point it at a throwaway repo).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function status() {
  const cwd = process.env.KNEXT_TREE_GUARD_REPO ?? process.cwd();
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

const [mode, file] = process.argv.slice(2);
if ((mode !== 'snapshot' && mode !== 'check') || !file) {
  console.error('usage: assert-tree-unchanged.mjs <snapshot|check> <file>');
  process.exit(2);
}

if (mode === 'snapshot') {
  writeFileSync(file, `${status().join('\n')}\n`);
  process.exit(0);
}

const before = new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean));
const leaked = status().filter((l) => !before.has(l));
if (leaked.length > 0) {
  console.error(
    'The test run left files in the repository working tree (a test is ' +
      'staging into the repo instead of a registered temp dir):',
  );
  for (const l of leaked) console.error(`  ${l}`);
  process.exit(1);
}
console.log('working tree unchanged by the test run');
