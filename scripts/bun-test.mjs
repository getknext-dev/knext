#!/usr/bin/env node
/**
 * Run the suite under `bun test`, one PROCESS per test file.
 *
 * ## Why not just `bun test`
 *
 * Bun registers module mocks for the whole RUN, not per file, and they cannot
 * be unregistered — `mock.restore()` restores spies, not `mock.module`. So one
 * file's fake `pg` is still installed when a later file needs the real driver,
 * and that file passes or fails depending only on collection order. Measured:
 * `db-pool-chaos.test.ts` passes alone and fails when it runs after
 * `db-ro-fallback.test.ts`, which mocks `pg`.
 *
 * vitest isolated per file, so nothing in this suite was written to expect
 * otherwise. Rather than rewrite 55 mocking files to avoid each other — a
 * constraint that would have to be re-checked on every new test — the runner
 * gives each file the isolation the tests assume.
 *
 * ## Coverage
 *
 * `bunfig.toml` deliberately does NOT set `coverage = true`. A global 0.8
 * threshold applied to a single file is meaningless and fails every run, which
 * is what blocked per-file isolation in the first place. Pass `--coverage` here
 * and it is applied once, to the whole set.
 *
 * Usage:
 *   node scripts/bun-test.mjs [path...] [--coverage] [--concurrency=N] [--bun=PATH]
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { importsFrom } from './lib/test-framework-import.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const withCoverage = argv.includes('--coverage');
const bunBin = flag('bun', process.env.KNEXT_BUN ?? 'bun');
const concurrency = Number(flag('concurrency', String(Math.max(2, cpus().length - 2))));
const targets = argv.filter((a) => !a.startsWith('--'));

/**
 * Warn when the local bun differs from the one `packageManager` names.
 *
 * bun does NOT enforce its own version pin — measured: 1.3.5 installs happily
 * against both `packageManager: "bun@1.4.0"` and a `.bun-version` file. So a
 * contributor on an older bun meets this instead:
 *
 *   error: lockfile had changes, but lockfile is frozen
 *   note: try re-running without --frozen-lockfile and commit the updated lockfile
 *
 * Following that note halves the dependency tree and drops security overrides
 * (#879). `tests/bun-lockfile-integrity.test.ts` catches the result at commit
 * time; this says it earlier, while the fix is still "use the right bun".
 *
 * A WARNING, not a refusal: the version that wrote the lockfile is not
 * necessarily the only one that can run the tests, and blocking a whole suite on
 * a patch-level difference would get this deleted rather than heeded.
 */
function warnOnBunVersionSkew() {
  try {
    const pinned = JSON.parse(readFileSync('package.json', 'utf8')).packageManager ?? '';
    const want = /^bun@(\d+\.\d+\.\d+)$/.exec(pinned)?.[1];
    if (want === undefined) return;
    const have = execFileSync(bunBin, ['--version'], { encoding: 'utf8' }).trim();
    if (have === want) return;
    console.warn(
      `\n  warning: running bun ${have}, but package.json pins bun@${want}.\n` +
        '  Tests should still pass. Do NOT run a bare `bun install` on this version:\n' +
        '  it rewrites bun.lock to an older format, halving the dependency tree and\n' +
        '  dropping security overrides (#879).\n',
    );
  } catch {
    // Never let a version probe break the run it is advising on.
  }
}

warnOnBunVersionSkew();

const files = execFileSync('git', ['ls-files', ...(targets.length ? targets : ['.'])], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((f) => /\.test\.tsx?$/.test(f))
  // Mirror `vitest.config.ts`'s exclusion of docker-dependent e2e suites. They
  // fail on a machine without a running daemon for environmental reasons, not
  // porting ones, and a runner that reports those as migration failures buries
  // the real ones. They still run — in the job that provides a daemon.
  .filter((f) => !/\.docker-e2e\.test\.tsx?$/.test(f))
  // The OTHER half of the partition `vitest.config.ts` derives.
  //
  // A file importing `vitest` cannot run here, exactly as a file importing
  // `bun:test` cannot run there. vitest already excludes itself from bun files
  // by scanning; without the mirror image, every not-yet-ported file in a
  // half-migrated package is reported as a bun FAILURE — which buries the real
  // ones and makes the migration look like it is going backwards.
  //
  // Derived, not listed, for the same reason: the partition then has exactly one
  // definition per side and no list to keep in sync.
  .filter((f) => {
    try {
      // ONE definition of the partition — see `vitest.config.ts` and
      // `scripts/lib/test-framework-import.mjs`.
      return !importsFrom(readFileSync(f, 'utf8'), 'vitest');
    } catch {
      // Unreadable: run it. A file this runner skips silently is coverage lost
      // with nothing to notice, which is worse than a loud failure.
      return true;
    }
  });

if (files.length === 0) {
  console.error('no test files matched');
  process.exit(1);
}

console.log(`bun test — ${files.length} file(s), ${concurrency} at a time, isolated per process\n`);

const failures = [];
let done = 0;

/**
 * The happy-dom registration + testing-library cleanup, as a bun preload.
 *
 * ABSOLUTE, resolved from this script rather than from a cwd. bun resolves
 * `--preload` relative to the test file's own directory, not the process cwd,
 * so a repo-relative path is "not found" for every file outside the repo root.
 */
const DOM_PRELOAD = fileURLToPath(new URL('../tests/helpers/bun-dom-preload.ts', import.meta.url));

/**
 * Does this file need a DOM?
 *
 * Decided by CONTENT, not by extension. `.tsx` is a good hint and a bad rule: a
 * `.ts` file can render a component, and a `.tsx` file can be a pure type-level
 * or server-side test that must not receive browser globals. Reading the imports
 * answers the question that actually matters.
 */
function needsDom(file) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  return /@testing-library\/react|\bdocument\.|\bwindow\./.test(src);
}

/** Run one file; resolve with its outcome rather than rejecting, so one red file does not abort the sweep. */
function runFile(file) {
  return new Promise((resolve) => {
    const args = ['test', file];
    // DOM tests need a `document` before their modules evaluate.
    // `@testing-library/react` reads it at module scope, so an import inside the
    // test file is already too late — a preload is the only ordering that works.
    // Applied per-file rather than globally: giving a server-side test a browser
    // global would let a `typeof document` probe take the browser branch, which
    // is exactly the kind of pass that means nothing.
    if (needsDom(file)) args.push('--preload', DOM_PRELOAD);
    if (withCoverage) args.push('--coverage');
    const child = spawn(bunBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      done++;
      const ok = code === 0;
      if (!ok) failures.push({ file, output });
      process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} [${done}/${files.length}] ${file}\n`);
      resolve(ok);
    });
    child.on('error', (err) => {
      done++;
      failures.push({ file, output: String(err.message) });
      process.stdout.write(`  FAIL [${done}/${files.length}] ${file} (spawn error)\n`);
      resolve(false);
    });
  });
}

const queue = [...files];
const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (;;) {
    const next = queue.shift();
    if (next === undefined) return;
    await runFile(next);
  }
});

await Promise.all(workers);

if (failures.length > 0) {
  console.log(`\n${failures.length} file(s) failed:\n`);
  for (const { file, output } of failures) {
    console.log(`──────── ${file}`);
    // Only the tail: the interesting part of a bun test failure is at the end.
    console.log(
      output
        .split('\n')
        .filter((l) => l.trim())
        .slice(-12)
        .join('\n'),
    );
    console.log();
  }
  process.exit(1);
}

console.log(`\nall ${files.length} test file(s) green`);
