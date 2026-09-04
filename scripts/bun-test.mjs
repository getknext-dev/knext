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
 * `--coverage` is applied PER FILE, because that is the only place it can go in
 * a one-process-per-file runner — each spawn measures only what it loaded. The
 * previous version of this paragraph claimed the opposite ("applied once, to the
 * whole set"), which is what let the gate rot unnoticed (#884).
 *
 * So each spawn writes its own lcov into `coverage-bun/<n>-<file>.info`, and
 * `scripts/check-coverage.mjs` merges all of them with vitest's report before
 * checking any floor. Two measured facts hold that together:
 *
 *   - bun writes `lcov.info` into ONE directory per process, so parallel spawns
 *     sharing a directory silently overwrite each other — hence a unique
 *     `--coverage-dir` per spawn;
 *   - `coverageDir` in `bunfig.toml` SILENTLY OVERRIDES `--coverage-dir` (bun
 *     1.4.0: the flag is accepted, ignored, and no error is printed). That key
 *     is therefore absent from `bunfig.toml`, and
 *     `tests/bun-test-coverage-emission.test.ts` fails if it comes back.
 *
 * `bunfig.toml` also sets no `coverage = true` and no `coverageThreshold`: a
 * global threshold applied to a single file is meaningless and fails every run,
 * which is what blocked per-file isolation in the first place. The floors are
 * the merged gate's.
 *
 * Usage:
 *   node scripts/bun-test.mjs [path...] [--coverage] [--concurrency=N] [--bun=PATH]
 */

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from './lib/blank-non-code.mjs';
import { BUN_COVERAGE_DIR } from './lib/coverage-policy.mjs';
import { importsFrom } from './lib/test-framework-import.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const withCoverage = argv.includes('--coverage');
const bunBin = flag('bun', process.env.KNEXT_BUN ?? 'bun');

/**
 * Everything here is anchored on the REPO ROOT, not the caller's cwd.
 *
 * `examples/bun-exec`'s own `test` script is
 * `node ../../scripts/bun-test.mjs examples/bun-exec` — a repo-root-relative
 * path, run from inside the example. With `git ls-files` inheriting that cwd it
 * looked for `examples/bun-exec/examples/bun-exec`, matched nothing, and exited
 * 1 with "no test files matched". Three CI jobs run that script.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const concurrency = Number(flag('concurrency', String(Math.max(2, cpus().length - 2))));
// `-t <name>` filters test titles, forwarded to every bun child (#902 — the
// prover lane runs single tests through this runner). Extracted BEFORE target
// collection: `-t` starts with one dash, so the filter below would otherwise
// swallow the flag and treat the name as a test file.
let testNameFilter;
const tIdx = argv.indexOf('-t');
if (tIdx !== -1) {
  testNameFilter = argv[tIdx + 1];
  argv.splice(tIdx, 2);
}
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
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((f) => /\.test\.tsx?$/.test(f))
  // Mirror `vitest.config.ts`'s exclusion of docker-dependent e2e suites. They
  // fail on a machine without a running daemon for environmental reasons, not
  // porting ones, and a runner that reports those as migration failures buries
  // the real ones. They still run — in the job that provides a daemon.
  // ...unless the FILE ITSELF was named. The container e2e has to be runnable
  // by name — it imports `bun:test`, so vitest cannot collect it, and
  // `examples/bun-exec`'s `test:image` is the job that runs it.
  //
  // Keyed on the exact path, not on `targets.length`: the example's own `test`
  // script names a DIRECTORY, and a blanket "any target lifts the exclusion"
  // swept the ~100 MB container build into the fast suite. The contract test
  // `bun-exec-example-suite-collection` caught that, which is what it is for.
  .filter((f) => !/\.docker-e2e\.test\.tsx?$/.test(f) || targets.includes(f))
  // `examples/**` is NOT part of this workspace. It carries its own bun.lock,
  // pinning vinext/nitro prereleases the workspace must not inherit, and its
  // guards run via `bun run test` INSIDE the example — a contract
  // `tests/bun-exec-example-suite-collection.test.ts` asserts behaviourally, and
  // three dedicated CI jobs provide.
  //
  // Collecting them from the repo root resolves imports against the ROOT
  // node_modules, where the example's deps do not exist:
  //   error: Cannot find module 'srvx/bun' from examples/bun-exec/test/...
  // It passes locally only because a developer has run `bun install` in the
  // example at some point. Excluding it here is not lost coverage — those files
  // still run, in the job that installs what they need.
  // ...but ONLY when sweeping the repo. Naming a path is an explicit request,
  // and the example's own `test` script does exactly that
  // (`node ../../scripts/bun-test.mjs examples/bun-exec`) — excluding it there
  // made that script exit 1 with "no test files matched", which is how this
  // filter first went in and immediately broke the job it was protecting.
  .filter((f) => targets.length > 0 || !/(^|\/)examples\//.test(f))
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
      return !importsFrom(readFileSync(resolve(REPO_ROOT, f), 'utf8'), 'vitest');
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

/**
 * Per-file lcov, collected for `scripts/check-coverage.mjs` to merge.
 *
 * WIPED at the start of a coverage run. Stale reports from a previous run would
 * keep crediting lines of files that no longer exist, which raises the number
 * without covering anything — the same dishonesty as a shrinking denominator,
 * from the other end.
 */
// `KNEXT_BUN_COVERAGE_DIR` redirects the pile. Not a convenience: a test that
// exercises this runner is itself part of the suite, so a nested `--coverage`
// run would otherwise WIPE the outer run's reports halfway through it.
const COVERAGE_OUT = resolve(REPO_ROOT, process.env.KNEXT_BUN_COVERAGE_DIR ?? BUN_COVERAGE_DIR);
const COVERAGE_RAW = join(COVERAGE_OUT, '.raw');
if (withCoverage) {
  if (existsSync(COVERAGE_OUT)) rmSync(COVERAGE_OUT, { recursive: true, force: true });
  mkdirSync(COVERAGE_RAW, { recursive: true });
}

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
  // TWO probes, because one does not work for both halves.
  //
  // The import is matched with `importsFrom`, which handles the trap that a
  // module specifier IS a string: blanking `from '@testing-library/react'`
  // erases the specifier and the match with it.
  //
  // `document.` / `window.` are matched against BLANKED code, because raw source
  // matches prose. `asset-prune.test.ts` — a pure server-side test — was given
  // browser globals by the comment "Aged out of every window.", and under bun
  // 1.4 that made pino take its browser branch and throw at first use. This
  // function's own docstring warns about exactly that outcome; it just did not
  // guard against it. Fifteen files were misclassified this way.
  if (importsFrom(src, '@testing-library/react')) return true;
  return /\bdocument\.|\bwindow\./.test(blankNonCode(src));
}

/** Run one file; resolve with its outcome rather than rejecting, so one red file does not abort the sweep. */
function runFile(file) {
  return new Promise((resolve) => {
    const args = ['test', file];
    if (testNameFilter !== undefined) args.push('-t', testNameFilter);
    // DOM tests need a `document` before their modules evaluate.
    // `@testing-library/react` reads it at module scope, so an import inside the
    // test file is already too late — a preload is the only ordering that works.
    // Applied per-file rather than globally: giving a server-side test a browser
    // global would let a `typeof document` probe take the browser branch, which
    // is exactly the kind of pass that means nothing.
    if (needsDom(file)) args.push('--preload', DOM_PRELOAD);
    // One coverage directory PER SPAWN: bun always names its report `lcov.info`,
    // so concurrent spawns sharing a directory overwrite each other and the
    // merge silently loses every file but the last writer.
    const slug = file.replace(/[/\\]/g, '__');
    const covDir = join(COVERAGE_RAW, slug);
    if (withCoverage) {
      args.push('--coverage', '--coverage-reporter=lcov', `--coverage-dir=${covDir}`);
    }
    const child = spawn(bunBin, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      done++;
      // Flatten each spawn's report to `coverage-bun/<slug>.info`, so the
      // directory is a readable pile of per-file lcov rather than a tree of
      // identically-named files.
      if (withCoverage) {
        const produced = join(covDir, 'lcov.info');
        if (existsSync(produced)) {
          cpSync(produced, join(COVERAGE_OUT, `${slug}.info`));
          rmSync(covDir, { recursive: true, force: true });
        }
      }
      const ok = code === 0;
      if (!ok) failures.push({ file, output });
      process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} [${done}/${files.length}] ${file}\n`);
      // Under a -t filter (#902: the prover lane runs single tests through this
      // runner) the caller needs the CHILD's pass/fail counts — a filter that
      // matches nothing is a green file with zero tests, which a prover must
      // treat as "nothing ran", not as proof. Forward the summary lines.
      if (testNameFilter !== undefined) {
        for (const line of output.split('\n')) {
          if (/^\s*\d+ (pass|fail|skip)\b/.test(line)) process.stdout.write(`${line}\n`);
        }
      }
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
    //
    // 40, not 12. A test whose assertion message carries diagnostic context —
    // a spawned server's log, a captured stderr — pushed its own label out of a
    // 12-line window, so CI showed the failure with the reason cut off and the
    // only way to learn anything was to reproduce locally. That is the opposite
    // of what this output is for.
    console.log(
      output
        .split('\n')
        .filter((l) => l.trim())
        .slice(-40)
        .join('\n'),
    );
    console.log();
  }
  process.exit(1);
}

console.log(`\nall ${files.length} test file(s) green`);
