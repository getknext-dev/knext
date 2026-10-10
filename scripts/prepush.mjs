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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STEPS = [
  ['biome check (error level)', 'bunx', ['biome', 'check', '.', '--diagnostic-level=error']],
  [
    'D9 temp-dir leak guard',
    'node',
    ['scripts/bun-test.mjs', 'tests/temp-dirs-outside-the-repo.test.ts'],
  ],
  ['typecheck', 'bun', ['run', 'typecheck']],
];

/** Runs every step (no short-circuit); returns the exit code (1 if any failed, else 0). */
export function runSteps(steps) {
  const failed = [];
  for (const [name, cmd, args] of steps) {
    console.log(`\n=== prepush: ${name} ===`);
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.status !== 0) failed.push(name);
  }
  if (failed.length > 0) {
    console.error(`\nprepush FAILED: ${failed.join(', ')}`);
    return 1;
  }
  console.log('\nprepush OK');
  return 0;
}

// Only the CLI entry runs the fixed gate list. No env var may alter it.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runSteps(DEFAULT_STEPS));
}
