#!/usr/bin/env node
/**
 * Mutation proof for the N2 (#1457) "no node_modules in the self-contained
 * stage" guard (`runtime-image-selection.test.ts`, describe block
 * "Dockerfile.standalone.hbs — self-contained stage ships no node_modules").
 *
 * Per .claude/rules/workflow.md: "Mutation-prove every new guard. Delete the
 * behaviour it protects and watch it go red." and "Never mutate with perl for
 * that proof... use a script that asserts the anchor occurs exactly once and
 * aborts otherwise." This is that script — plain Node fs, no perl/sed, and it
 * asserts its anchor occurs EXACTLY ONCE before mutating, and restores the
 * file BYTE-EXACT (from a backup, not from a re-render) afterward regardless
 * of outcome.
 *
 * Usage: node scripts/mutate-self-contained-dockerfile-proof.mjs
 * Exit 0 only if: the guard test is green before, RED after reintroducing a
 * node_modules COPY into the self-contained stage, and green again after the
 * byte-exact restore.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCKERFILE = resolve(
  import.meta.dirname,
  '..',
  'packages/kn-next/templates/runtime-standalone/Dockerfile.standalone.hbs',
);
const BACKUP = `${DOCKERFILE}.mutation-backup`;
const TEST_FILE = 'packages/kn-next/src/__tests__/runtime-image-selection.test.ts';
const TEST_FILTER = 'self-contained';

const ANCHOR =
  'COPY knext-standalone-exec-linux-x64 /app/knext-standalone-exec\n\nUSER 65532:65532\n\nENV PORT=3000 \\\n    HOSTNAME=0.0.0.0 \\\n    NODE_ENV=production\n\nEXPOSE 3000\n\n# No shell, no supervisor, no spawned child — the compiled executable IS the\n# server, and (per the fold decision above) also owns its own SIGTERM drain and\n# `:9464` metrics endpoint directly.\nENTRYPOINT ["/app/knext-standalone-exec"]';

function runTests(label) {
  console.log(`\n--- ${label} ---`);
  try {
    execFileSync('bun', ['test', TEST_FILE, '--test-name-pattern', TEST_FILTER], {
      cwd: resolve(import.meta.dirname, '..'),
      stdio: 'inherit',
    });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

const original = readFileSync(DOCKERFILE, 'utf8');
const occurrences = original.split(ANCHOR).length - 1;
if (occurrences !== 1) {
  console.error(
    `ABORT: anchor occurs ${occurrences} time(s) in ${DOCKERFILE}, expected exactly 1. Refusing to mutate.`,
  );
  process.exit(1);
}

copyFileSync(DOCKERFILE, BACKUP);

let exitCode = 1;
try {
  const before = runTests('BEFORE mutation (must be green)');
  if (before !== 0) {
    console.error('ABORT: the guard is not green before mutation — fix it first.');
    process.exit(1);
  }

  const mutated = original.replace(
    ANCHOR,
    `COPY --from=standalone-deps /deps/node_modules /app/node_modules\n${ANCHOR}`,
  );
  if (mutated === original) {
    console.error('ABORT: mutation replace was a no-op.');
    process.exit(1);
  }
  writeFileSync(DOCKERFILE, mutated, 'utf8');

  const after = runTests('AFTER reintroducing a node_modules COPY (must be RED)');
  if (after === 0) {
    console.error(
      'MUTATION PROOF FAILED: the guard stayed green after a node_modules COPY was reintroduced. It is decoration.',
    );
    exitCode = 1;
  } else {
    console.log(
      '\nMUTATION PROOF PASSED: the guard went red when a node_modules COPY was reintroduced.',
    );
    exitCode = 0;
  }
} finally {
  // Byte-exact restore from the backup, never from re-rendering the diff.
  copyFileSync(BACKUP, DOCKERFILE);
  const restored = readFileSync(DOCKERFILE, 'utf8');
  if (restored !== original) {
    console.error('FATAL: restore did not reproduce the original file byte-for-byte.');
    process.exit(1);
  }
  const restoredGreen = runTests('AFTER byte-exact restore (must be green again)');
  if (restoredGreen !== 0) {
    console.error('FATAL: restored file is not green — do not trust this worktree.');
    process.exit(1);
  }
}

process.exit(exitCode);
