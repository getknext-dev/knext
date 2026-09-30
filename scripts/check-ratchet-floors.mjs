#!/usr/bin/env node
/**
 * PR-time ratchet-floor guard (#1253).
 *
 * Reads every `@ratchet-floor`-marked constant (see `scripts/lib/ratchet-floors.mjs`
 * for the marker contract) at HEAD and at the merge base, and fails if any
 * floor went DOWN — unless `ratchet-lowering-allowlist.json` carries an entry
 * for that exact `{file, path}` that was INTRODUCED by this PR (present at
 * HEAD, absent at the merge base; an inherited entry exempts nothing, mirroring
 * `rcBumpMarker` / `publishedBytesBumpMarker`). A floor whose marker or
 * declaration disappeared entirely at HEAD counts as lowered too (see
 * `findLoweredFloors`'s doc) — deleting the marker is not an escape hatch.
 *
 * Scope: every tracked `.ts` / `.mjs` / `.js` file under the repo (excluding
 * `node_modules` and build output) is scanned for the marker — never an
 * enumerated file list, so a new ratchet is covered the moment it's written.
 *
 * FAIL CLOSED (review round 2, #1253). Two distinct failure classes, both
 * fatal, both reported with a clear message rather than a raw stack trace:
 *
 *   1. the merge base cannot be resolved (e.g. `origin/main` unreachable —
 *      the CI job forgot `fetch-depth: 0` / an explicit base fetch). This
 *      guard refuses to silently compare HEAD to itself, which would report
 *      "0 violations" for a reason that has nothing to do with the PR.
 *   2. a marked declaration cannot be evaluated at EITHER ref (see
 *      `extractRatchetFloors`'s `errors`). Reported the same way a real
 *      lowering is — never a bypass.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRatchetFloors,
  findLoweredFloors,
  RATCHET_FLOOR_MARKER,
} from './lib/ratchet-floors.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_FILE = 'ratchet-lowering-allowlist.json';

/**
 * This guard's own test fixtures embed marker-line EXAMPLES (`// @ratchet-floor`)
 * inside template-literal source strings to exercise the parser — those are not
 * real declarations and must not be scanned as if they were, the same
 * "small, necessarily hardcoded, documented" exclusion already used by
 * `compat-credential-freeze-guard.mjs`'s `GUARD_SELF_FILES`.
 */
const GUARD_SELF_FILES = Object.freeze(['tests/ratchet-floor-guard.test.ts']);

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
// Same as `git`, but with stderr swallowed — used only where a non-zero exit
// (e.g. "path exists on disk, but not in <ref>") is an EXPECTED outcome the
// caller already handles via try/catch, so git's own fatal: text would just
// be noise on every run that touches a file added in the working PR.
const gitQuiet = (...args) =>
  execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });

class RatchetFloorGuardError extends Error {}

/**
 * FAILS CLOSED: throws `RatchetFloorGuardError` rather than falling back to
 * comparing HEAD against itself when `origin/main` is unreachable — a
 * silent "nothing to compare against" must never read as "no violations".
 * `RATCHET_FLOOR_BASE_REF` remains the explicit override for callers that
 * legitimately have no `origin` remote (this guard's own e2e test, run
 * inside a throwaway repo with no remote at all).
 */
function resolveMergeBase() {
  if (process.env.RATCHET_FLOOR_BASE_REF) return process.env.RATCHET_FLOOR_BASE_REF.trim();
  try {
    git('rev-parse', '--verify', 'origin/main');
  } catch {
    throw new RatchetFloorGuardError(
      'cannot resolve origin/main — the checkout is missing history (needs fetch-depth: 0 or an ' +
        'explicit fetch of the base ref) or has no origin remote. Refusing to compare HEAD ' +
        'against itself; set RATCHET_FLOOR_BASE_REF to override explicitly.',
    );
  }
  return git('merge-base', 'HEAD', 'origin/main').trim();
}

/**
 * @param {string} ref
 * @returns {string[]} repo-relative paths, `.ts`/`.mjs`/`.js`, excluding node_modules/dist
 */
function trackedSourceFiles(ref) {
  const out = git('ls-tree', '-r', '--name-only', ref);
  return out
    .split('\n')
    .filter(Boolean)
    .filter((p) => /\.(ts|mjs|js)$/.test(p))
    .filter((p) => !p.includes('node_modules/') && !p.includes('/dist/') && !p.startsWith('dist/'))
    .filter((p) => !GUARD_SELF_FILES.includes(p));
}

/** @param {string} ref @param {string} path @returns {string|null} */
function readAtRef(ref, path) {
  try {
    return gitQuiet('show', `${ref}:${path}`);
  } catch {
    return null; // file doesn't exist at that ref
  }
}

/** @param {string} ref @returns {{ floors: Record<string, number>, errors: string[] }} */
function collectFloors(ref) {
  /** @type {Record<string, number>} */
  const floors = {};
  /** @type {string[]} */
  const errors = [];
  for (const file of trackedSourceFiles(ref)) {
    const source = readAtRef(ref, file);
    if (source === null || !source.includes(RATCHET_FLOOR_MARKER)) continue;
    const extracted = extractRatchetFloors(source, file);
    Object.assign(floors, extracted.floors);
    errors.push(...extracted.errors);
  }
  return { floors, errors };
}

/** @param {string} ref @returns {import('./lib/ratchet-floors.mjs').AllowlistEntry[]} */
function collectAllowlist(ref) {
  const source = readAtRef(ref, ALLOWLIST_FILE);
  if (source === null) return [];
  try {
    const parsed = JSON.parse(source);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function main() {
  const baseRef = resolveMergeBase();
  const head = collectFloors('HEAD');
  const base = collectFloors(baseRef);
  const headAllowlist = collectAllowlist('HEAD');
  const baseAllowlist = collectAllowlist(baseRef);

  const evalErrors = [...head.errors, ...base.errors];
  if (evalErrors.length > 0) {
    console.error(
      'ratchet-floor guard: UNRESOLVABLE marked declaration(s) — treated as violations:\n',
    );
    for (const e of evalErrors) console.error(`  ${e}`);
    console.error('\nFix the declaration so it evaluates as a plain literal, or drop the marker.');
    process.exitCode = 1;
    return;
  }

  const violations = findLoweredFloors(base.floors, head.floors, headAllowlist, baseAllowlist);

  if (violations.length === 0) {
    console.log(
      `ratchet-floor guard: ${Object.keys(head.floors).length} floor(s) checked against ${baseRef}, none lowered.`,
    );
    process.exitCode = 0;
    return;
  }

  console.error('ratchet-floor guard: FLOOR(S) LOWERED without a PR-introduced allowlist entry:\n');
  for (const v of violations) {
    console.error(`  ${v.key}: ${v.base} -> ${v.head === null ? 'REMOVED' : v.head}`);
  }
  console.error(
    '\nRaise a ratchet floor; never lower one to get green, and never delete its marker or ' +
      `declaration to escape this check. If this lowering is deliberate and reviewed, add a ` +
      `dated entry to ${ALLOWLIST_FILE} naming the exact file+path in THIS PR.`,
  );
  process.exitCode = 1;
}

const isEntrypoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  try {
    main();
  } catch (err) {
    console.error(
      `ratchet-floor guard: FAILED CLOSED — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

export { collectFloors, collectAllowlist, resolveMergeBase, RatchetFloorGuardError };
