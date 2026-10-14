#!/usr/bin/env node
/**
 * collect-merged-in-pins.mjs — #2342: write the markers found at every
 * merged-in parent in a PR's range to a JSON array, for a freeze guard's
 * `--inherited-pins-file`. The logic is `scripts/lib/merged-in-pins.mjs`
 * (see its header); this is only the CLI the workflow step calls.
 *
 * Usage:
 *   node scripts/collect-merged-in-pins.mjs \
 *     --base-sha <sha> --head-sha <sha> --event-name <pull_request|merge_group> \
 *     --pin-file <path> --field <markerField> --out <file>
 *
 * Exits 2 on a missing argument or any git failure: the guard then has no
 * file and fails closed, never reading "no merges".
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { collectMergedInPins } from './lib/merged-in-pins.mjs';

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const opts = {
    baseSha: arg('base-sha'),
    headSha: arg('head-sha'),
    pinFile: arg('pin-file'),
    field: arg('field'),
  };
  const out = arg('out');
  const missing = Object.entries({ ...opts, out })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(`collect-merged-in-pins: missing required argument(s): ${missing.join(', ')}`);
    process.exit(2);
  }
  const git = (...a) =>
    execFileSync('git', a, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    const pins = collectMergedInPins({ ...opts, git, eventName: arg('event-name') ?? undefined });
    writeFileSync(out, JSON.stringify(pins));
  } catch (err) {
    console.error(`collect-merged-in-pins: ${err.message}`);
    process.exit(2);
  }
}
/* c8 ignore stop */
