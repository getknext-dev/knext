#!/usr/bin/env node
/**
 * published-bytes-select-pin.mjs — #2098: pick the pin the published-bytes
 * freeze guard measures a PR against, from git objects.
 *
 * The guard protects the line whose bytes are being CREDENTIALED. Credential
 * runs pack from the rc-tag checkout, never from `main`, so a base branch that
 * is not that line is guarded against nothing. This script answers "which line
 * does this PR's base carry, and which pin (if any) credentials it":
 *
 *   - the line is the major.minor of the BASE COMMIT's `@getknext/core`
 *     version (read as a git blob — never the PR's own head);
 *   - the choice itself is the pure `selectPinFile` in
 *     `scripts/lib/published-bytes-freeze-check.mjs`;
 *   - a per-line pin (`.github/compat-credential-ref-v1.3.json`) is read from
 *     the base commit and, when the base branch does not carry it (an
 *     integration branch predates the file, which lives on `main` because its
 *     credential workflow is read from `main`), from `main`.
 *
 * Prints `PIN_FILE_SELECTED=<path>` and `BASE_VERSION=<version>` (empty when
 * unreadable — the check then fails closed) for `$GITHUB_ENV`, and writes the
 * resolved base pin to `--base-pin-out`.
 *
 * Usage:
 *   node scripts/published-bytes-select-pin.mjs \
 *     --base-sha <sha> --base-ref <branch> --base-pin-out <path> [--main-ref origin/main]
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { PIN_FILE, PIN_FILE_V13, selectPinFile } from './lib/published-bytes-freeze-check.mjs';

const CORE_PACKAGE_JSON = 'packages/kn-next/package.json';

/**
 * @param {string} repoRoot
 * @param {string} rev
 * @param {string} path
 * @returns {string | null} the blob's text, or null when absent at `rev`.
 */
function gitShow(repoRoot, rev, path) {
  const run = (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let listing;
  try {
    listing = run(['ls-tree', rev, '--', path]);
  } catch (err) {
    throw new Error(`cannot inspect ${path} at ${rev}: ${err.message}`);
  }
  // Genuinely absent (valid rev, no such path): the only "no window" case.
  if (listing.trim() === '') return null;
  try {
    return run(['show', `${rev}:${path}`]);
  } catch (err) {
    // Present but unreadable must FAIL, never fall through to another pin.
    throw new Error(`cannot read ${path} at ${rev}: ${err.message}`);
  }
}

/**
 * @param {string} repoRoot
 * @param {string} ref
 * @returns {boolean}
 */
function refResolves(repoRoot, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string | null} text
 * @param {string} what
 * @returns {unknown}
 */
function parseJson(text, what) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Unparseable is not "no window": fail the run (exit 2), as before #2098.
    throw new Error(`${what} is present but is not valid JSON`);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.baseSha
 * @param {string} [opts.baseRef]
 * @param {string} [opts.mainRef] where a per-line pin is read from when the base lacks it.
 * @returns {{ pinFile: string, baseVersion: string | undefined, basePin: unknown }}
 */
export function selectPinFromGit({ repoRoot, baseSha, baseRef, mainRef = 'origin/main' }) {
  let baseVersion;
  try {
    const v = JSON.parse(gitShow(repoRoot, baseSha, CORE_PACKAGE_JSON) ?? 'null')?.version;
    if (typeof v === 'string') baseVersion = v;
  } catch {
    baseVersion = undefined;
  }

  const readPin = (file) => {
    const atBase = gitShow(repoRoot, baseSha, file);
    if (atBase !== null) return parseJson(atBase, `${file} at ${baseSha}`);
    // Only a per-line pin falls back to main; the primary pin absent at base
    // keeps meaning "no window open before this PR".
    if (file === PIN_FILE) return { rcTag: null };
    // An unresolvable fallback ref (main never fetched) reads as absent; a
    // file that exists on it but is broken throws.
    if (!refResolves(repoRoot, mainRef)) return null;
    return parseJson(gitShow(repoRoot, mainRef, file), `${file} at ${mainRef}`);
  };

  const candidates = [PIN_FILE, PIN_FILE_V13].map((file) => ({ file, pin: readPin(file) }));
  const pinFile = selectPinFile({ baseVersion, baseRef, candidates });
  const basePin = candidates.find((c) => c.file === pinFile)?.pin ?? { rcTag: null };
  return { pinFile, baseVersion, basePin: basePin ?? { rcTag: null } };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const baseSha = arg('base-sha');
  if (!baseSha) {
    console.error('published-bytes-select-pin: --base-sha is required');
    process.exit(2);
  }
  let r;
  try {
    r = selectPinFromGit({
      repoRoot: process.cwd(),
      baseSha,
      baseRef: arg('base-ref') ?? undefined,
      mainRef: arg('main-ref') ?? undefined,
    });
  } catch (err) {
    console.error(`published-bytes-select-pin: ${err.message}`);
    process.exit(2);
  }
  const out = arg('base-pin-out');
  if (out) writeFileSync(out, `${JSON.stringify(r.basePin, null, 2)}\n`);
  console.log(`PIN_FILE_SELECTED=${r.pinFile}`);
  console.log(`BASE_VERSION=${r.baseVersion ?? ''}`);
}
/* c8 ignore stop */
