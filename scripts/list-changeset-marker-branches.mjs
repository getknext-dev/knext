#!/usr/bin/env node
/**
 * List the remote branches that still carry the stale 1.0 major changeset
 * marker (#2035, v2 task R0, item e).
 *
 * `.changeset/pre/v1-0-0-release-candidate.md` declares `"@getknext/core": major`.
 * It computed 2.0.0 by accident once, and hundreds of remote branches still carry
 * it. Deleting them is a founder action (`git push origin --delete`, in batches,
 * never force), so this script only READS: `git ls-remote`, a `git fetch` of any
 * tip commit not yet in the local object store (into FETCH_HEAD, no refs
 * written), and `git cat-file -e` per tip.
 *
 * A branch that is a live publish lane is NEVER listed for deletion; if one
 * carries the marker it is reported separately and the script exits 1, because
 * that is a lane that must be fixed, not deleted.
 *
 * Usage:
 *   node scripts/list-changeset-marker-branches.mjs [--remote origin] [--count | --with-dates]
 *
 * Prints one branch name per line (sorted), or just the count with `--count`;
 * `--with-dates` appends a tab and the tip commit's date, so a reviewer can spot
 * a branch someone is still working on before approving its deletion.
 * Exit 0 = listed. Exit 1 = a live lane carries the marker, or git failed.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISH_LANES } from './publish-lane-guard.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every path the marker has been seen at. */
export const MARKER_PATHS = Object.freeze([
  '.changeset/pre/v1-0-0-release-candidate.md',
  '.changeset/v1-0-0-release-candidate.md',
]);

/**
 * Parse `git ls-remote --heads` output into `{sha, ref, branch}` rows.
 *
 * @param {string} text
 */
export function parseLsRemote(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/\s+/);
      if (!/^[0-9a-f]{40}$/.test(sha ?? '') || !ref?.startsWith('refs/heads/')) {
        throw new Error(`unparseable ls-remote line: ${JSON.stringify(line)}`);
      }
      return { sha, ref, branch: ref.slice('refs/heads/'.length) };
    });
}

/**
 * Split marker-carrying heads into the deletion list and the live lanes that
 * must never be deleted.
 *
 * @param {Array<{ref: string, branch: string, carries: boolean}>} heads
 */
export function classify(heads) {
  const carrying = heads.filter((h) => h.carries);
  return {
    deletable: carrying
      .filter((h) => !PUBLISH_LANES.has(h.ref))
      .map((h) => h.branch)
      .sort(),
    liveLanes: carrying
      .filter((h) => PUBLISH_LANES.has(h.ref))
      .map((h) => h.branch)
      .sort(),
  };
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', ...options });
}

function hasObject(spec) {
  try {
    git(['cat-file', '-e', spec], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main(argv) {
  const remote = argv.includes('--remote') ? argv[argv.indexOf('--remote') + 1] : 'origin';
  const countOnly = argv.includes('--count');
  const heads = parseLsRemote(git(['ls-remote', '--heads', remote]));

  const missing = [...new Set(heads.map((h) => h.sha).filter((sha) => !hasObject(sha)))];
  for (let i = 0; i < missing.length; i += 50) {
    git(
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        remote,
        ...missing.slice(i, i + 50),
      ],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
  }
  const unresolved = missing.filter((sha) => !hasObject(sha));
  if (unresolved.length > 0) {
    console.error(`could not fetch ${unresolved.length} tip commit(s); refusing a partial list`);
    return 1;
  }

  const { deletable, liveLanes } = classify(
    heads.map((h) => ({
      ...h,
      carries: MARKER_PATHS.some((path) => hasObject(`${h.sha}:${path}`)),
    })),
  );
  const shaOf = new Map(heads.map((h) => [h.branch, h.sha]));
  const tipDate = (branch) =>
    git(['show', '-s', '--format=%cs', shaOf.get(branch) ?? '']).trim() || '?';
  if (countOnly) console.log(String(deletable.length));
  else if (argv.includes('--with-dates')) {
    for (const branch of deletable) console.log(`${branch}\t${tipDate(branch)}`);
  } else for (const branch of deletable) console.log(branch);
  if (liveLanes.length > 0) {
    console.error(
      `LIVE publish lane(s) carry the marker — fix, never delete: ${liveLanes.join(', ')}`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
