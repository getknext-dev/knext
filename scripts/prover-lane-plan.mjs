#!/usr/bin/env node
/**
 * Plan the multi-ref, sharded mutation-prover lane (#2499 / #2208).
 *
 * Resolves each ref to a SHA ONCE, so every shard of a ref proves the same tree
 * (a moving branch name would let a push land between two legs' checkouts, and
 * the aggregate could not tell that from a bug), and emits the matrix.
 *
 * FAIL-LOUD: an unresolvable ref exits non-zero. A ref that cannot be resolved
 * is a ref whose provers did not run, and dropping it from the matrix would turn
 * "integration/v2 was deleted/renamed" into a green lane.
 *
 * Inputs are ENV, never argv, so a dispatch input cannot reach a shell:
 *   LANE_REFS        space/comma separated refs   (default: main integration/v2)
 *   LANE_SHARDS      shard count                  (required)
 *   LANE_ONLY_SHARD  run only this shard, 1-based (optional; manual dispatch)
 *   LANE_REPO_URL    where to resolve refs        (default: origin)
 *   GITHUB_OUTPUT    receives `matrix=` and `expected=`
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildMatrix, LANE_REFS } from './lib/prover-shard.mjs';

export function parseRefs(raw) {
  const refs = String(raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  return refs.length > 0 ? refs : [...LANE_REFS];
}

export function resolveRef(ref, repo) {
  const out = execFileSync('git', ['ls-remote', '--exit-code', repo, `refs/heads/${ref}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = out.split('\n').find((l) => l.endsWith(`\trefs/heads/${ref}`));
  if (!line) throw new Error(`ref ${ref} did not resolve to a branch head`);
  return line.split('\t')[0];
}

function main() {
  const shards = Number(process.env.LANE_SHARDS);
  const onlyShardRaw = process.env.LANE_ONLY_SHARD;
  const onlyShard = onlyShardRaw ? Number(onlyShardRaw) : undefined;
  const repo = process.env.LANE_REPO_URL || 'origin';
  const names = parseRefs(process.env.LANE_REFS);
  // Validate BEFORE any network call: buildMatrix rejects an unsafe ref name.
  buildMatrix({ refs: names.map((ref) => ({ ref, sha: '0'.repeat(40) })), shards, onlyShard });
  const refs = names.map((ref) => ({ ref, sha: resolveRef(ref, repo) }));
  const matrix = buildMatrix({ refs, shards, onlyShard });
  const planned = refs.map((r) => `${r.ref}@${r.sha.slice(0, 9)}`).join(', ');
  console.log(`planned ${matrix.include.length} leg(s) over ${planned}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `matrix=${JSON.stringify(matrix)}\n`);
    appendFileSync(out, `expected=${JSON.stringify(matrix.include)}\n`);
  } else {
    console.log(JSON.stringify(matrix, null, 2));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
