#!/usr/bin/env node
/**
 * `bun run prepush` — run, locally and in order, what CI's Lint & Test and the
 * root typecheck job run first. Those three gates are the ones agents kept
 * skipping and then reddening PRs on. Runs ALL of them (no short-circuit, so
 * one pass shows every failure) and exits 1 if any failed.
 *
 *  1. biome check at error level   (ci.yml "Run Biome lint & format check")
 *  2. D9 temp-dir leak guard       (part of the bun suite in ci.yml)
 *  3. root typecheck               (ci.yml "Typecheck root tests/")
 */
import { spawnSync } from 'node:child_process';

const STEPS = [
  ['biome check (error level)', 'bunx', ['biome', 'check', '.', '--diagnostic-level=error']],
  [
    'D9 temp-dir leak guard',
    'node',
    ['scripts/bun-test.mjs', 'tests/temp-dirs-outside-the-repo.test.ts'],
  ],
  ['typecheck', 'bun', ['run', 'typecheck']],
];

const failed = [];
for (const [name, cmd, args] of STEPS) {
  console.log(`\n=== prepush: ${name} ===`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) failed.push(name);
}

if (failed.length > 0) {
  console.error(`\nprepush FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nprepush OK');
process.exit(0);
