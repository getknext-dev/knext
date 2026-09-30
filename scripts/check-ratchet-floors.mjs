#!/usr/bin/env node
/**
 * PR-time ratchet-floor guard (#1253).
 *
 * Reads every `@ratchet-floor`-marked constant (see `scripts/lib/ratchet-floors.mjs`
 * for the marker contract) at HEAD and at the merge base, and fails if any
 * floor went DOWN — unless `ratchet-lowering-allowlist.json` carries an entry
 * for that exact `{file, path}` that was INTRODUCED by this PR (present at
 * HEAD, absent at the merge base; an inherited entry exempts nothing, mirroring
 * `rcBumpMarker` / `publishedBytesBumpMarker`).
 *
 * Scope: every tracked `.ts` / `.mjs` / `.js` file under the repo (excluding
 * `node_modules` and build output) is scanned for the marker — never an
 * enumerated file list, so a new ratchet is covered the moment it's written.
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

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

function resolveMergeBase() {
  if (process.env.RATCHET_FLOOR_BASE_REF) return process.env.RATCHET_FLOOR_BASE_REF.trim();
  try {
    git('rev-parse', '--verify', 'origin/main');
  } catch {
    return 'HEAD'; // no remote reachable (e.g. isolated test fixture) — nothing to compare
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
    .filter((p) => !p.includes('node_modules/') && !p.includes('/dist/') && !p.startsWith('dist/'));
}

/** @param {string} ref @param {string} path @returns {string|null} */
function readAtRef(ref, path) {
  try {
    return git('show', `${ref}:${path}`);
  } catch {
    return null; // file doesn't exist at that ref
  }
}

/** @param {string} ref @returns {Record<string, number>} */
function collectFloors(ref) {
  /** @type {Record<string, number>} */
  const all = {};
  for (const file of trackedSourceFiles(ref)) {
    const source = readAtRef(ref, file);
    if (source === null || !source.includes(RATCHET_FLOOR_MARKER)) continue;
    Object.assign(all, extractRatchetFloors(source, file));
  }
  return all;
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
  const headFloors = collectFloors('HEAD');
  const baseFloors = collectFloors(baseRef);
  const headAllowlist = collectAllowlist('HEAD');
  const baseAllowlist = collectAllowlist(baseRef);

  const violations = findLoweredFloors(baseFloors, headFloors, headAllowlist, baseAllowlist);

  if (violations.length === 0) {
    console.log(
      `ratchet-floor guard: ${Object.keys(headFloors).length} floor(s) checked against ${baseRef}, none lowered.`,
    );
    process.exit(0);
  }

  console.error('ratchet-floor guard: FLOOR(S) LOWERED without a PR-introduced allowlist entry:\n');
  for (const v of violations) {
    console.error(`  ${v.key}: ${v.base} -> ${v.head}`);
  }
  console.error(
    `\nRaise a ratchet floor; never lower one to get green. If this lowering is deliberate and ` +
      `reviewed, add a dated entry to ${ALLOWLIST_FILE} naming the exact file+path in THIS PR.`,
  );
  process.exit(1);
}

const isEntrypoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) main();

export { collectFloors, collectAllowlist, resolveMergeBase };
