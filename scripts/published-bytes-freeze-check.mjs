#!/usr/bin/env node
/**
 * published-bytes-freeze-check.mjs — the PR-time half of #1663.
 *
 * WHY, and how this divides from the release-time gate: see
 * `scripts/lib/published-bytes-freeze-check.mjs`'s header. In one line —
 * `scripts/ga-tarball-diff-gate.mjs` proves a GA cut differs from its
 * credentialed rc only in version fields; THIS proves every PR merged while
 * that rc's credential window is still open keeps agreeing with it, so the
 * eventual GA cut never discovers a mismatch 14 nights too late.
 *
 * THREE OUTCOMES, always announced (never a silent green — same discipline as
 * `ga-tarball-diff-gate.mjs`):
 *   - SKIP: no window open, a valid `publishedBytesBumpMarker` override, or
 *     this PR touches no path that can reach a published package. Exits 0
 *     without ever packing anything.
 *   - FAIL: a window is open, this PR touches publishable scope, and the
 *     pinned `rcTag` does not resolve to a real git tag in this checkout —
 *     fails closed rather than silently skipping an unanswerable question.
 *     Packing/diff failures (a build error, a real byte mismatch) also FAIL,
 *     because `scripts/ga-tarball-diff.mjs` itself exits non-zero on both and
 *     this script propagates that exit code verbatim.
 *   - RUN: packs the publishable group at HEAD (the PR's merge ref, since
 *     this always runs against whatever is actually checked out) and diffs
 *     it against the pinned rc tag, using the EXACT SAME comparison rules as
 *     the release-time gate (`scripts/ga-tarball-diff.mjs`, imported by
 *     neither this script nor the decision module at module scope — see
 *     `defaultRunDiff` below for why it is spawned as a child process).
 *
 * `changedFiles` is REQUIRED and always injected (never computed by this
 * script) — the CLI entrypoint reads it from a plain `--changed-files-file`
 * (one path per line), the same shape `compat-credential-freeze-guard.mjs`
 * already uses, so both guards share one workflow-side "diff the PR" step
 * shape without this script needing to shell to `git diff` itself.
 *
 * Usage:
 *   node scripts/published-bytes-freeze-check.mjs --changed-files-file <path>
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decidePublishedBytesScope,
  PIN_FILE,
  publishScopeDirs,
} from './lib/published-bytes-freeze-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(__dirname, '..');

/**
 * Read + parse the pin file. Throws on a missing/unparsable file — mirrors
 * `ga-tarball-diff-gate.mjs`'s `readCredentialRcTag`: an unreadable answer
 * must never be mistaken for "nothing credentialed" (that would be fail-OPEN
 * on a corrupt file, the opposite of what a freeze check is for).
 *
 * @param {string} repoRoot
 * @returns {unknown}
 */
export function readPin(repoRoot) {
  const path = join(repoRoot, PIN_FILE);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Does `tag` resolve to a real git tag in this checkout? `execFileSync`
 * throws on a non-zero exit (no such tag, or an unannotated/annotated
 * resolution failure) — caught and turned into `false`, never re-thrown, so
 * the caller's fail-closed branch is a plain `if`, not a `try/catch` at the
 * call site.
 *
 * @param {string} repoRoot
 * @param {string} tag
 * @returns {boolean}
 */
export function defaultTagResolves(repoRoot, tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// `./ga-tarball-diff.mjs` is deliberately NOT imported at module scope — see
// `ga-tarball-diff-gate.mjs`'s own header for the identical reasoning: it
// pulls in `lib/tar-entries.mjs` -> the `tar` npm devDependency, and a SKIP
// decision (the common case for most PRs) must never need it installed.
// Spawned as a separate `node` process only on a RUN decision.
/**
 * @param {string[]} argv forwarded verbatim to `ga-tarball-diff.mjs`'s CLI.
 * @param {{ log?: typeof console.log, repoRoot?: string }} [opts]
 * @returns {number} the child process's exit code
 */
export function defaultRunDiff(argv, { log = console.log, repoRoot = defaultRepoRoot } = {}) {
  const diffScript = join(__dirname, 'ga-tarball-diff.mjs');
  const result = spawnSync(process.execPath, [diffScript, ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.stdout) log(result.stdout.replace(/\n$/, ''));
  if (result.stderr) log(result.stderr.replace(/\n$/, ''));
  if (result.status === null) {
    throw new Error(`ga-tarball-diff.mjs was terminated by signal ${result.signal}`);
  }
  return result.status;
}

const TITLE = 'Published-bytes freeze check';

/**
 * @param {object} opts
 * @param {string[]} opts.changedFiles required — the files this PR touched.
 * @param {string} [opts.repoRoot]
 * @param {(...args: unknown[]) => void} [opts.log]
 * @param {Date} [opts.now]
 * @param {(repoRoot: string, tag: string) => boolean} [opts.tagResolves] injectable tag resolver.
 * @param {(argv: string[], opts?: { log?: typeof console.log, repoRoot?: string }) => number} [opts.runDiff]
 *   injectable so unit tests never spawn `git worktree`/`bun`/a child `node` process.
 * @param {string | undefined} [opts.summaryPath] `$GITHUB_STEP_SUMMARY`; unset locally.
 * @returns {number} process exit code
 */
export function main({
  changedFiles,
  repoRoot = defaultRepoRoot,
  log = console.log,
  now = new Date(),
  tagResolves = defaultTagResolves,
  runDiff = defaultRunDiff,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
}) {
  if (!Array.isArray(changedFiles)) {
    throw new Error('main() requires changedFiles: string[] — the files this PR touched');
  }

  const announce = (level, verdict, reason) => {
    log(`::${level} title=${TITLE}::${verdict}: ${reason}`);
    if (summaryPath) appendFileSync(summaryPath, `- **${TITLE} — ${verdict}**: ${reason}\n`);
  };

  const pin = readPin(repoRoot);
  const packageDirs = publishScopeDirs(repoRoot);
  const decision = decidePublishedBytesScope({ pin, changedFiles, packageDirs, now });

  if (decision.action === 'skip') {
    announce('notice', 'SKIP', decision.reason);
    return 0;
  }

  if (!tagResolves(repoRoot, decision.rcTag)) {
    announce(
      'error',
      'FAIL',
      `${PIN_FILE}'s rcTag ${JSON.stringify(decision.rcTag)} does not resolve to a git tag in ` +
        'this checkout — failing closed rather than skipping an unanswerable freeze question ' +
        '(a shallow/tagless checkout must never read as "nothing to compare")',
    );
    return 1;
  }

  announce('notice', 'RUN', `${decision.reason} — comparing HEAD against ${decision.rcTag}`);
  const code = runDiff(['--rc-ref', decision.rcTag, '--ga-ref', 'HEAD'], { log, repoRoot });
  if (code === 0) {
    announce(
      'notice',
      'PASS',
      `HEAD differs from ${decision.rcTag} only in version fields — published bytes are still frozen`,
    );
  } else {
    announce(
      'error',
      'FAIL',
      `HEAD differs from ${decision.rcTag} beyond version fields while a credential window is ` +
        'open (see the log above). This change belongs to the next release, or needs a new rc — ' +
        `add a dated, reviewed \`publishedBytesBumpMarker\` to ${PIN_FILE} if this IS an ` +
        'intentional rc.N+1.',
    );
  }
  return code;
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const changedFilesFile = arg('changed-files-file');
  if (!changedFilesFile) {
    console.error('published-bytes-freeze-check: --changed-files-file is required');
    process.exit(2);
  }
  let changedFiles;
  try {
    changedFiles = readFileSync(changedFilesFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch (err) {
    console.error(
      `published-bytes-freeze-check: could not read ${changedFilesFile}: ${err.message}`,
    );
    process.exit(2);
  }
  try {
    process.exit(main({ changedFiles }));
  } catch (err) {
    console.error(`[published-bytes-freeze-check] ERROR: ${err.message}`);
    process.exit(1);
  }
}
/* c8 ignore stop */
