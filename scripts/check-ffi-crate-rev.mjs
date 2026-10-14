#!/usr/bin/env node
/**
 * crateRev drift guard (#2364).
 *
 * `knext ffi init` writes a crate whose `knext-ffi` git dependency is pinned to
 * `packages/ffi/package.json` `knextFfi.crateRev`. A change under
 * `crates/knext-ffi/` or `crates/knext-ffi-macros/` that lands without moving
 * that pin reaches the generator but not the crates init'd zones build — the
 * #2363 non-finite float refusal shipped exactly half-applied that way.
 *
 * The rule. A PR cannot pin its own merge commit (it does not exist yet), so
 * failing on the PR's OWN crate changes would make every crate PR permanently
 * red. Instead:
 *
 *   PR mode (base ref from FFI_CRATE_REV_BASE_REF, else origin/$GITHUB_BASE_REF):
 *     - the crates at the MERGE BASE differ from the crates at the pin
 *       -> an earlier crate change merged without a bump -> exit 1, naming the
 *          first-parent commit on the base that last touched them (the pin to set);
 *     - the crates differ between the merge base and HEAD (this PR changes
 *       them) -> ::warning:: asking for the follow-up bump once it merges;
 *       the NEXT PR on this lane fails until that bump lands.
 *   Push mode (GITHUB_EVENT_NAME=push): pin-vs-HEAD drift is a ::warning::
 *     naming the commit to pin (the merge that just landed is that commit).
 *
 * Always, in both modes: the pin must be a full 40-hex SHA and an ancestor of
 * HEAD (exit 1 otherwise).
 *
 * FAIL CLOSED (exit 2), never a pass: the pinned commit is absent from local
 * history (a shallow checkout — the job needs `fetch-depth: 0`), the base ref
 * or merge base does not resolve, or there is neither a base ref nor a push
 * event (the guard refuses to compare HEAD with itself).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = 'packages/ffi/package.json';
/** Trailing slash: a directory boundary, so `knext-ffi-fixture/` never matches. */
const CRATE_PATHS = ['crates/knext-ffi/', 'crates/knext-ffi-macros/'];

const git = (...args) =>
  execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function gitOk(...args) {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
}

function fail(code, message) {
  console.error(`::error::${message}`);
  process.exit(code);
}

const changed = (from, to) =>
  git('diff', '--name-only', from, to, '--', ...CRATE_PATHS)
    .split('\n')
    .filter(Boolean);

const lastCrateCommit = (ref) =>
  git('log', '--first-parent', '-1', '--format=%H', ref, '--', ...CRATE_PATHS);

let rev;
try {
  rev = JSON.parse(readFileSync(resolve(REPO_ROOT, PIN_FILE), 'utf8'))?.knextFfi?.crateRev;
} catch (err) {
  fail(2, `cannot read ${PIN_FILE}: ${err.message}`);
}
if (typeof rev !== 'string' || !/^[0-9a-f]{40}$/.test(rev)) {
  fail(
    1,
    `${PIN_FILE} knextFfi.crateRev must be a full 40-hex commit SHA, got ${JSON.stringify(rev)}`,
  );
}
if (!gitOk('cat-file', '-e', `${rev}^{commit}`)) {
  fail(
    2,
    `pinned crateRev ${rev} is not in the local history — a shallow checkout? The job needs fetch-depth: 0. Refusing to pass without comparing.`,
  );
}
if (!gitOk('merge-base', '--is-ancestor', rev, 'HEAD')) {
  fail(
    1,
    `pinned crateRev ${rev} is not an ancestor of HEAD — pin a commit on this branch's history`,
  );
}

const isPush = process.env.GITHUB_EVENT_NAME === 'push';
const baseRef =
  process.env.FFI_CRATE_REV_BASE_REF ||
  (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '');

if (isPush && !process.env.FFI_CRATE_REV_BASE_REF) {
  const drift = changed(rev, 'HEAD');
  if (drift.length > 0) {
    console.log(
      `::warning::crates/knext-ffi* changed after the pinned crateRev ${rev}: ${drift.join(', ')}. ` +
        `Open a PR setting ${PIN_FILE} knextFfi.crateRev to ${lastCrateCommit('HEAD')}.`,
    );
  } else {
    console.log(`crateRev ${rev} covers the crates at HEAD.`);
  }
  process.exit(0);
}

if (!baseRef) {
  fail(
    2,
    'no base ref: set FFI_CRATE_REV_BASE_REF (or GITHUB_BASE_REF in a PR), or GITHUB_EVENT_NAME=push',
  );
}
if (!gitOk('rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`)) {
  fail(2, `base ref ${baseRef} does not resolve — the job needs fetch-depth: 0`);
}
let mergeBase;
try {
  mergeBase = git('merge-base', 'HEAD', baseRef);
} catch {
  fail(2, `no merge base between HEAD and ${baseRef} — the job needs fetch-depth: 0`);
}

const inherited = changed(rev, mergeBase);
if (inherited.length > 0) {
  fail(
    1,
    `crates/knext-ffi* changed on ${baseRef} after the pinned crateRev ${rev}, and the pin was never moved: ` +
      `${inherited.join(', ')}. Set ${PIN_FILE} knextFfi.crateRev to ${lastCrateCommit(mergeBase)} ` +
      '(the commit that landed them) so `knext ffi init` crates get the change.',
  );
}

const own = changed(mergeBase, 'HEAD');
if (own.length > 0) {
  console.log(
    `::warning::this PR changes ${own.join(', ')}. A PR cannot pin its own merge commit: once it merges, ` +
      `open a follow-up setting ${PIN_FILE} knextFfi.crateRev to the merge commit — the next PR on this lane fails until then.`,
  );
}
console.log(`crateRev ${rev} covers the crates at the merge base with ${baseRef}.`);
