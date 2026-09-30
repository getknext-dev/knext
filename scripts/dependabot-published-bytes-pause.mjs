#!/usr/bin/env node
/**
 * dependabot-published-bytes-pause.mjs — #1663's "pause Dependabot for the
 * published packages' dependency manifests while a window is open" leg.
 *
 * WHY AN AUTO-CLOSE WORKFLOW, NOT A `.github/dependabot.yml` EDIT:
 * `.github/dependabot.yml` today has EXACTLY ONE `package-ecosystem` entry —
 * `github-actions` — and no `npm`/`bun` ecosystem block exists in this repo at
 * all (verified by reading the file, not assumed). A config-based "pause"
 * would therefore have NOTHING to disable today, and — worse — would require
 * a REVIEWED PR to toggle the config open/closed around every credential
 * window, which is exactly the manual, easy-to-forget step ADR-0056's own
 * design already tries to avoid for the harness freeze. An auto-close
 * workflow is the LESS BRITTLE choice for a second, related reason: it keys
 * on WHAT a bot PR actually touches (the SAME `decidePublishedBytesScope`
 * used by `scripts/published-bytes-freeze-check.mjs`), not on which
 * ecosystem block happens to exist in `dependabot.yml` on a given day — so it
 * is correct BEFORE an npm/bun ecosystem entry is ever added (a no-op today,
 * proven by the fact that no npm/bun Dependabot PR can exist yet) and
 * requires NO further edit the day one is.
 *
 * WHAT THIS SCRIPT DECIDES: given the SAME pin file + changed-files diff as
 * the freeze check, would this PR's content be disallowed by the freeze
 * check were it a normal PR (`action === 'proceed'`)? If so, it is a
 * dependency bump touching a published package's manifest during an open,
 * un-overridden credential window, and the workflow (job-gated on
 * `github.actor == 'dependabot[bot]'`) closes it. A `skip` decision — no
 * window open, a valid `publishedBytesBumpMarker` override, or (the common
 * case today) a bump that touches no publishable-package path at all — is
 * left alone; NOTHING here re-implements the scope/override rules, they are
 * imported verbatim from `scripts/lib/published-bytes-freeze-check.mjs` so
 * the two mechanisms can never silently disagree about what counts as
 * "reaches a published package".
 *
 * This script ONLY decides; it never calls `gh` itself — the workflow step
 * reads `$GITHUB_OUTPUT`'s `should_close`/`reason` and runs `gh pr close`
 * conditionally, keeping the side effect (closing someone's PR) visible in
 * the workflow YAML rather than buried in a script.
 *
 * `basePin`/`headPin`/`mergeBasePin` are required, same as the sibling
 * `scripts/published-bytes-freeze-check.mjs` (round-2 fix, PR #1680 review):
 * a single ambient pin read cannot tell "was a window open before this bump"
 * from "does this bump's own diff carry an override", which is the exact
 * bypass class that fix closes. See
 * `scripts/lib/published-bytes-freeze-check.mjs`'s "WHICH PIN STATE" header.
 *
 * Usage:
 *   node scripts/dependabot-published-bytes-pause.mjs \
 *     --changed-files-file <path> \
 *     --base-pin-file <path> \
 *     --head-pin-file <path> \
 *     --merge-base-pin-file <path>
 */

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
 * Read + parse the pin file at whatever is currently checked out at
 * `repoRoot`. NOT used by `decide()`'s decision anymore — see the file
 * header. Kept exported as a small utility.
 *
 * @param {string} repoRoot
 */
export function readPin(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, PIN_FILE), 'utf8'));
}

/**
 * @param {object} opts
 * @param {string[]} opts.changedFiles required — the files this bot PR touches.
 * @param {unknown} opts.basePin required — the pin file's content as of this
 *   PR's BASE commit.
 * @param {unknown} opts.headPin required — the pin file's content as of this
 *   PR's HEAD commit.
 * @param {unknown} [opts.mergeBasePin] defaults to `basePin`.
 * @param {string} [opts.repoRoot]
 * @param {(...args: unknown[]) => void} [opts.log]
 * @param {Date} [opts.now]
 * @param {string | undefined} [opts.githubOutputPath] `$GITHUB_OUTPUT`; unset locally.
 * @returns {{ shouldClose: boolean, reason: string }}
 */
export function decide({
  changedFiles,
  basePin,
  headPin,
  mergeBasePin = basePin,
  repoRoot = defaultRepoRoot,
  log = console.log,
  now = new Date(),
  githubOutputPath = process.env.GITHUB_OUTPUT,
}) {
  if (!Array.isArray(changedFiles)) {
    throw new Error('decide() requires changedFiles: string[] — the files this PR touched');
  }
  if (basePin === undefined) {
    throw new Error("decide() requires basePin — the pin file's content at this PR's base commit");
  }
  if (headPin === undefined) {
    throw new Error("decide() requires headPin — the pin file's content at this PR's head commit");
  }
  const packageDirs = publishScopeDirs(repoRoot);
  const decision = decidePublishedBytesScope({
    basePin,
    headPin,
    mergeBasePin,
    changedFiles,
    packageDirs,
    now,
  });

  const shouldClose = decision.action === 'proceed';
  const reason = shouldClose
    ? `${decision.reason} — this is a dependency bump during an open, un-overridden credential ` +
      'window, closing rather than letting it merge and desync the frozen bytes'
    : decision.reason;

  log(shouldClose ? '🚫 CLOSE' : '✅ LEAVE OPEN', reason);
  if (githubOutputPath) {
    appendFileSync(githubOutputPath, `should_close=${shouldClose}\n`);
    // Single-line for $GITHUB_OUTPUT's plain KEY=VALUE form; a reason can
    // legitimately contain characters `gh pr close --comment` still accepts.
    appendFileSync(githubOutputPath, `reason=${reason.replace(/\n/g, ' ')}\n`);
  }
  return { shouldClose, reason };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const changedFilesFile = arg('changed-files-file');
  const basePinFile = arg('base-pin-file');
  const headPinFile = arg('head-pin-file');
  const mergeBasePinFile = arg('merge-base-pin-file');
  if (!changedFilesFile || !basePinFile || !headPinFile || !mergeBasePinFile) {
    console.error(
      'dependabot-published-bytes-pause: --changed-files-file, --base-pin-file, --head-pin-file ' +
        'and --merge-base-pin-file are all required',
    );
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
      `dependabot-published-bytes-pause: could not read ${changedFilesFile}: ${err.message}`,
    );
    process.exit(2);
  }
  const readPinFile = (file, label) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(
        `dependabot-published-bytes-pause: could not read/parse ${label} (${file}): ${err.message}`,
      );
      process.exit(2);
    }
  };
  const basePin = readPinFile(basePinFile, 'base pin file');
  const headPin = readPinFile(headPinFile, 'head pin file');
  const mergeBasePin = readPinFile(mergeBasePinFile, 'merge-base pin file');
  try {
    decide({ changedFiles, basePin, headPin, mergeBasePin });
    // This automation NEVER fails the job — it only ever decides whether to
    // close, and the workflow's own `if:` step reads the output. A non-zero
    // exit here would make an unrelated Dependabot PR (one that leaves scope
    // alone) show a red check for a decision that resolved to "leave open".
    process.exit(0);
  } catch (err) {
    console.error(`[dependabot-published-bytes-pause] ERROR: ${err.message}`);
    process.exit(1);
  }
}
/* c8 ignore stop */
