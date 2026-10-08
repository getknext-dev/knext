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
 * `scripts/check-coverage.mjs` merges all of them (and folds in a 0% entry for
 * every untested source file — the honest denominator) before checking any
 * floor. Two measured facts hold that together:
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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from './lib/blank-non-code.mjs';
import { skipViolation } from './lib/bun-test-no-skip.mjs';
import { BUN_COVERAGE_DIR } from './lib/coverage-policy.mjs';
import { killAllProcessTrees, killProcessTree } from './lib/kill-process-tree.mjs';
import { importsFrom } from './lib/test-framework-import.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const withCoverage = argv.includes('--coverage');
/**
 * `--no-skip`: a file that reports ANY skipped or todo test FAILS (see
 * `lib/bun-test-no-skip.mjs` for why a green `bun test` is not enough).
 */
const noSkip = argv.includes('--no-skip');
const bunBin = flag('bun', process.env.KNEXT_BUN ?? 'bun');
/**
 * `--junit-dir=<dir>`: each file's child also writes bun's JUnit report to
 * `<dir>/<file slug>.xml`. This is the STRUCTURED per-test outcome a mutation
 * prover needs to attribute a red run to the one named test it targets
 * (`scripts/mutation-prove-compat-credential-line.mjs`), instead of reading
 * pass/fail off human-facing console text. A file that fails to load writes no
 * report at all, which a caller must treat as "no test outcome", not as proof.
 */
const junitDir = flag('junit-dir', undefined);

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
/**
 * A hard OUTER bound per spawned file (#1241). `coverage-margin.test.ts` was
 * observed to hang 27+ minutes under `--coverage`, orphaned — nothing here
 * bounded a single file's runtime beyond bun's own PER-TEST default (5000ms,
 * which a genuinely-stuck event loop can also fail to enforce), and nothing
 * killed a file that overran. Generous by design: legitimate files carry
 * their own up-to-90s per-test timeouts (e.g.
 * `tests/bytecode-liveness-wiring.test.ts`) and `--coverage` measurably slows
 * every file down, so this must never fire on a merely-slow file — only on
 * one that is actually stuck. 10 minutes is comfortably above the slowest
 * observed legitimate file and comfortably below "left running for the rest
 * of the day".
 */
const fileTimeoutMs = Number(flag('file-timeout', String(10 * 60_000)));
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
  .filter((f) => targets.length > 0 || !/(^|\/)examples\//.test(f));
// #871: the whole suite runs under `bun test`. There is no longer a vitest half
// to partition away — `tests/runner-partition.test.ts` asserts that every tracked
// test file imports `bun:test`, so a file that somehow imports `vitest` fails
// loudly here rather than being silently skipped.

// An explicitly-named target that IS an existing test file must run even if it
// is UNTRACKED (#1073). `git ls-files` lists only tracked files, so a
// freshly-written file — the mutation provers' green canary — matched nothing and
// the runner exited 1 for a discovery reason, aborting the provers' RED-vs-GREEN
// self-check. This honours the runner's own contract ("Naming a path is an
// explicit request") for untracked files, in one place, rather than each prover
// polluting the index with `git add`. Only a named FILE is unioned in — a named
// directory is not a file to include directly, so it still expands via
// `git ls-files` above. A genuinely-absent path matches nothing and still falls
// through to the exit-1 guard the #879/#902 tests depend on.
const named = new Set(files);
for (const t of targets) {
  const rel = resolve(REPO_ROOT, t);
  if (!named.has(t) && existsSync(rel) && /\.test\.tsx?$/.test(t)) {
    files.push(t);
    named.add(t);
  }
}

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
// Sibling to COVERAGE_OUT, deliberately NOT inside it — wiping the directory
// below must never also delete the lock protecting that wipe.
const COVERAGE_LOCK = `${COVERAGE_OUT}.lock`;

/**
 * Is `pid` a live process? `process.kill(pid, 0)` sends no signal, only
 * probes. ESRCH means no such process; EPERM means it exists but is owned by
 * someone else — still alive, from this check's point of view.
 */
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Exclusive lock on COVERAGE_OUT for the life of this `--coverage` run
 * (#1242). Before this, the runner unconditionally `rmSync`'d then
 * `mkdirSync`'d the shared pile — two overlapping coverage runs in the same
 * (non-worktree) checkout would race on that wipe, and whichever started
 * second could silently delete the first's in-flight per-file reports
 * mid-merge, producing a wrong coverage number with no error at all.
 *
 * A run that cannot acquire the lock FAILS LOUDLY and leaves the directory
 * untouched — proceeding anyway is exactly the silent clobber this closes.
 * Acquisition is atomic (`wx`: `O_CREAT|O_EXCL`), so two processes racing to
 * create the SAME lock file can never both believe they won it — the OS
 * guarantees exactly one `wx` create succeeds even when both attempts land
 * in the same instant. A lock recorded by a PID that is no longer alive (a
 * crashed prior run — e.g. SIGKILLed by this very runner's #1241 file
 * timeout) is reclaimed rather than blocking every future run permanently.
 */
function acquireCoverageLock() {
  for (;;) {
    try {
      writeFileSync(COVERAGE_LOCK, String(process.pid), { flag: 'wx' });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let heldBy;
    try {
      heldBy = Number(readFileSync(COVERAGE_LOCK, 'utf8').trim());
    } catch {
      // Vanished between our failed create and this read — the holder
      // released it (or another racer reclaimed it) in that window. Retry
      // the atomic create rather than treating a read failure as a hold.
      continue;
    }
    if (Number.isInteger(heldBy) && pidIsAlive(heldBy)) {
      console.error(
        `\nerror: another --coverage run (pid ${heldBy}) already owns ${COVERAGE_OUT}.\n` +
          "Two coverage runs in the same checkout would silently clobber each other's " +
          'in-flight output (#1242) — refusing rather than wiping it. Wait for the other ' +
          'run to finish, or point KNEXT_BUN_COVERAGE_DIR at a different directory (e.g. ' +
          'a separate worktree) to run coverage concurrently.\n',
      );
      process.exit(1);
    }
    // Stale — the recorded PID is gone. Reclaim (best-effort: a concurrent
    // reclaimer's ENOENT here is not fatal) and retry the atomic create.
    rmSync(COVERAGE_LOCK, { force: true });
  }
}

if (withCoverage) {
  acquireCoverageLock();
  // Released on every exit path THIS PROCESS controls — including an
  // uncaught throw, and an explicit `process.exit()` from anywhere in this
  // script, such as the SIGINT/SIGTERM handlers below — never a `finally`
  // that a throw could skip.
  //
  // NOT released on an unhandled SIGINT/SIGTERM: `process.on('exit', ...)`
  // does not fire when a signal's default action terminates the process —
  // only when something in this process calls `process.exit()` (or falls off
  // the end of the event loop). That gap is why the SIGINT/SIGTERM handlers
  // below exist at all: they turn "unhandled signal kills the process" into
  // "this process notices the signal and calls process.exit() itself",
  // which DOES run this handler. The one case that still bypasses it
  // entirely is an external SIGKILL of THIS runner (uncatchable by design) —
  // `acquireCoverageLock`'s stale-PID reclaim above is what recovers from
  // that, not this handler.
  process.on('exit', () => rmSync(COVERAGE_LOCK, { force: true }));
  if (existsSync(COVERAGE_OUT)) rmSync(COVERAGE_OUT, { recursive: true, force: true });
  mkdirSync(COVERAGE_RAW, { recursive: true });
}

// `killProcessTree` (whole-process-GROUP SIGKILL, tolerant of ESRCH/EPERM
// races) and `killAllProcessTrees` (the isolated per-pid sweep the
// SIGINT/SIGTERM handler below uses) now live in `./lib/kill-process-tree.mjs`
// — extracted so the isolation behaviour is unit-testable with an injected
// kill function (review round 3 on #1241; see
// `tests/kill-process-tree-sweep-isolation.test.ts`).

/** Every currently-running spawned file's pid, so a signal to THIS runner can reap them all. */
const activeChildPids = new Set();

/**
 * Without this, `Ctrl-C` (or CI cancelling the job) on the runner itself
 * leaves every in-flight spawned file's process group running — the same
 * orphan class #1241 fixed for the per-file timeout, just triggered by the
 * runner's own death instead of one file overrunning. `process.exit()` here
 * (rather than letting the signal's default action terminate the process) is
 * also what makes the coverage-lock `exit` handler above actually run.
 *
 * The sweep is ISOLATED per pid (`killAllProcessTrees`, review round 3 on
 * #1241): a bare `for (const pid of activeChildPids) killProcessTree(pid);`
 * loop let ONE pid's uncaught error — a racy `EPERM` from
 * `process.kill(-pid, 'SIGKILL')` under a pid-recycling race, reproduced
 * live at 1-in-6 under `--coverage` with 3 concurrent files — abort the
 * whole sweep and orphan every OTHER in-flight file's process tree too.
 */
let interrupted = false;
function handleTerminationSignal() {
  if (interrupted) return;
  interrupted = true;
  killAllProcessTrees(activeChildPids);
  process.exit(1);
}
process.on('SIGINT', handleTerminationSignal);
process.on('SIGTERM', handleTerminationSignal);

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
    if (junitDir !== undefined) {
      args.push('--reporter=junit', `--reporter-outfile=${join(junitDir, `${slug}.xml`)}`);
    }
    // `detached: true`: makes this child the leader of its own process
    // GROUP (see `killProcessTree`), so a kill can reach a real grandchild
    // the file itself spawns (#1241 recurrence) — not merely this one pid.
    const child = spawn(bunBin, args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    activeChildPids.add(child.pid);
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    // #1241: an OUTER kill — bun's own per-test timeout lives INSIDE the
    // child and cannot help if the child's event loop is the thing stuck.
    // SIGKILL, not SIGTERM: a truly-hung process is exactly the case a
    // handler-based graceful exit cannot be trusted to run. The whole process
    // GROUP, not just this pid — see `killProcessTree`.
    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, fileTimeoutMs);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      activeChildPids.delete(child.pid);
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
      if (timedOut) {
        output += `\n[bun-test.mjs] killed after exceeding the ${fileTimeoutMs}ms per-file timeout — treated as a hang, not a slow test. Raise --file-timeout if this file is legitimately slow.\n`;
      }
      const violation = noSkip && code === 0 ? skipViolation(output) : null;
      if (violation) output += `\n${violation}\n`;
      // timedOut overrides everything else: a killed process's exit code
      // (whatever SIGKILL happens to report) must never read as success.
      const ok = !timedOut && code === 0 && violation === null;
      if (!ok) failures.push({ file, output });
      process.stdout.write(
        `  ${ok ? 'ok  ' : timedOut ? 'KILL' : 'FAIL'} [${done}/${files.length}] ${file}\n`,
      );
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
      clearTimeout(killTimer);
      activeChildPids.delete(child.pid);
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
