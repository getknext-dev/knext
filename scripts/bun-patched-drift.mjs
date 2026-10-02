#!/usr/bin/env node
// Bun drift check for the opt-in knext-patched Bun toolchain (deploy/bun-patched/).
//
// The patched toolchain is stock Bun <pinned> + one patch. When a NEWER stock Bun ships, the
// toolchain is stale until the patch is refreshed, rebuilt, re-pinned and re-released — and
// nothing else tells anyone. This reds (exit 1) in exactly that case. It also reports, as a
// warning, when the upstream PR the patch carries has merged (time to retire the toolchain).
//
// Informational lane (.github/workflows/bun-patched-drift-nightly.yml): nightly, NOT a required
// check. An unreachable API is a FAILURE, never a pass — a drift check that goes green when it
// cannot see upstream is worse than none.
//
// Usage: node scripts/bun-patched-drift.mjs            (reads gh api; needs GH_TOKEN)
//        node scripts/bun-patched-drift.mjs --latest bun-v1.4.3 [--upstream-merged true]
//
// RETIREMENT: delete with deploy/bun-patched/.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UPSTREAM_PR = 'oven-sh/bun#44059';

/** The stock Bun version the pinned patched toolchain is built from (bun-toolchain.ts). */
export function pinnedBunVersion(src) {
  const m = [...src.matchAll(/^\s*bunVersion: "(\d+\.\d+\.\d+)",$/gm)];
  if (m.length !== 1) throw new Error(`expected exactly one bunVersion pin, found ${m.length}`);
  return m[0][1];
}

/** `bun-v1.4.3` → `1.4.3`; anything else throws (a malformed answer is not "no drift"). */
export function stockVersionFromTag(tag) {
  const m = /^bun-v(\d+\.\d+\.\d+)$/.exec(String(tag ?? '').trim());
  if (!m) throw new Error(`unexpected oven-sh/bun latest release tag: ${JSON.stringify(tag)}`);
  return m[1];
}

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

/**
 * @param {{ pinned: string, latestTag: string, upstreamMerged?: boolean }} input
 * @returns {{ drift: boolean, messages: string[] }}
 */
export function driftVerdict({ pinned, latestTag, upstreamMerged = false }) {
  const latest = stockVersionFromTag(latestTag);
  const messages = [];
  const drift = cmp(latest, pinned) > 0;
  if (drift) {
    messages.push(
      `stock Bun ${latest} has shipped, but the knext-patched toolchain is still built from ${pinned}: ` +
        'refresh the patch, rebuild on Cloud Build, re-pin and re-release (deploy/bun-patched/README.md).',
    );
  } else {
    messages.push(
      `no drift: the latest stock Bun is ${latest}; the patched toolchain is built from ${pinned}.`,
    );
  }
  if (upstreamMerged) {
    messages.push(
      `${UPSTREAM_PR} has merged upstream: once a stock Bun release carries it, retire the patched toolchain.`,
    );
  }
  return { drift, messages };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pinned = pinnedBunVersion(
      readFileSync(resolve(REPO_ROOT, 'packages/kn-next/src/cli/bun-toolchain.ts'), 'utf8'),
    );
    const latestTag =
      arg('--latest') ?? gh(['api', 'repos/oven-sh/bun/releases/latest', '--jq', '.tag_name']);
    const mergedRaw =
      arg('--upstream-merged') ?? gh(['api', 'repos/oven-sh/bun/pulls/44059', '--jq', '.merged']);
    if (mergedRaw !== 'true' && mergedRaw !== 'false')
      throw new Error(`unexpected merged flag: ${mergedRaw}`);
    const { drift, messages } = driftVerdict({
      pinned,
      latestTag,
      upstreamMerged: mergedRaw === 'true',
    });
    for (const m of messages) console.log(m);
    process.exit(drift ? 1 : 0);
  } catch (err) {
    console.error(
      `bun-patched drift check could not decide: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
}
