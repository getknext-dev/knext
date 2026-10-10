#!/usr/bin/env node
/**
 * Merged-SHA check: after a PR merges, the commit that landed must contain the
 * PR's final head. A stale-head merge (a fix pushed after the merge SHA was
 * locked) lands without that fix and nothing else notices.
 *
 * Two modes, one verdict (EXIT CODE: 0 contained, 1 NOT contained or unverifiable):
 *   --head <sha> --merge <sha> [--paths a,b] [--repo dir]   git-only core
 *   --pr <N> --merge <sha> [--gh-repo owner/name]           resolves the PR's
 *        final head + changed files through `gh`, fetches refs/pull/N/head.
 *
 * Containment is (1) head is an ancestor of the merge commit (merge / rebase
 * merges), else (2) for squash merges, where ancestry can never hold, every
 * file the PR touched has the head's blob in the merge commit. With no
 * --paths and no ancestry there is nothing to compare, so it FAILS CLOSED.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** @returns {{ok: boolean, reason: string}} */
export function checkContained({ repo, head, merge, paths = [] }) {
  for (const sha of [head, merge]) {
    if (!git(repo, ['cat-file', '-e', `${sha}^{commit}`]).ok) {
      return { ok: false, reason: `commit ${sha} not found in ${repo} (fetch it first)` };
    }
  }
  if (git(repo, ['merge-base', '--is-ancestor', head, merge]).ok) {
    return { ok: true, reason: `head ${head} is an ancestor of ${merge}` };
  }
  if (paths.length === 0) {
    return {
      ok: false,
      reason: `head ${head} is not an ancestor of ${merge} and no --paths given`,
    };
  }
  const drifted = paths.filter((p) => {
    const h = git(repo, ['rev-parse', '-q', '--verify', `${head}:${p}`]);
    const m = git(repo, ['rev-parse', '-q', '--verify', `${merge}:${p}`]);
    return h.out !== m.out; // both missing (deleted) => both '' => equal
  });
  if (drifted.length > 0) {
    return {
      ok: false,
      reason: `STALE-HEAD MERGE: ${merge} does not contain head ${head}; differing: ${drifted.join(', ')}`,
    };
  }
  return { ok: true, reason: `squash: all ${paths.length} PR file(s) match head ${head}` };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  return o;
}

function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const repo = a.repo ?? '.';
  let head = a.head;
  let paths = a.paths ? a.paths.split(',').filter(Boolean) : [];
  if (a.pr) {
    const ghRepo = a['gh-repo'] ?? process.env.GITHUB_REPOSITORY;
    const view = ghJson(['pr', 'view', a.pr, '--repo', ghRepo, '--json', 'headRefOid,files']);
    head = view.headRefOid;
    paths = view.files.map((f) => f.path);
    git(repo, ['fetch', '-q', 'origin', `refs/pull/${a.pr}/head`]);
  }
  if (!head || !a.merge) {
    console.error('usage: merged-sha-check (--head <sha> | --pr <N>) --merge <sha> [--paths a,b]');
    return 1;
  }
  const v = checkContained({ repo, head, merge: a.merge, paths });
  console[v.ok ? 'log' : 'error'](`${v.ok ? 'OK' : 'FAIL'}: ${v.reason}`);
  return v.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
}
