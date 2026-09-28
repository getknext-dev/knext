#!/usr/bin/env node
/**
 * compat-disk-floor-check — the free-disk-floor half of #1530's credential-
 * window risk guards.
 *
 * WHY. A credential shard's own steps (`next.js` checkout, a musl-native
 * rebuild per fixture, a `next build` + server boot per deploy-test file) are
 * disk-heavy, and a GitHub-hosted runner that fills its disk mid-shard does
 * not throw a clean error — `npm install`/`next build` fail with whatever
 * partial-write error the OS happens to surface, indistinguishable from a
 * REAL assertion regression once it lands in the ledger (`kind: 'assertion'`
 * — exactly the miscategorization #1520 already fixed once for deploy-script
 * failures, on a different root cause).
 *
 * So this runs BEFORE the shard's real test-running step, as a runner-side
 * precondition check, not a test. On a floor breach the workflow step (not
 * this script — see the header of `.github/workflows/test-e2e-deploy.yml`'s
 * "Free disk floor" step) writes the shard's OWN summary JSON directly,
 * synthesizing a `kind: 'infra'` failure so the shard:
 *   - still FAILS the job (never a silent pass — a disk-exhausted shard
 *     proves nothing about the knext ref under test, and #1530 requires it
 *     never read as green);
 *   - is LABELLED distinctly from `kind: 'assertion'` in the ledger
 *     (`scripts/compat-window-audit.mjs`'s `isInfraOnlyRedShard`), so triage
 *     is not misdirected at a phantom regression.
 *
 * Usage:
 *   node scripts/compat-disk-floor-check.mjs --path /path/to/check [--floor-gb 5]
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {object} DiskFloorVerdict
 * @property {boolean} ok
 * @property {'ok'|'below-floor'|'unreadable'} state
 * @property {string} message
 */

/**
 * The pure decision: is `freeBytes` at or above `floorBytes`? Fails closed on
 * an unreadable (non-finite / negative) `freeBytes` — never treated as "plenty
 * of room".
 *
 * @param {{ freeBytes: number|null, floorBytes: number }} input
 * @returns {DiskFloorVerdict}
 */
export function evaluateDiskFloor({ freeBytes, floorBytes }) {
  if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes) || freeBytes < 0) {
    return {
      ok: false,
      state: 'unreadable',
      message: 'could not read free disk space on the runner',
    };
  }
  if (freeBytes < floorBytes) {
    return {
      ok: false,
      state: 'below-floor',
      message: `free disk ${(freeBytes / 1e9).toFixed(2)}GB is below the ${(floorBytes / 1e9).toFixed(2)}GB floor`,
    };
  }
  return { ok: true, state: 'ok', message: 'free disk is above the floor' };
}

/**
 * Read free bytes available at `path` via `df -k` (POSIX `-k` forces 1024-byte
 * blocks so the parse does not depend on the platform's default block size).
 *
 * @param {string} path
 * @returns {number|null}
 */
export function getFreeBytes(path) {
  const r = spawnSync('df', ['-k', path], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const lines = String(r.stdout).trim().split('\n');
  const last = lines.at(-1);
  if (!last) return null;
  // POSIX `df` columns: Filesystem 1024-blocks Used Available Capacity Mounted-on.
  // Split on whitespace and take the 4th field — resilient to a long
  // filesystem name wrapping the line onto two, which `df -k` does on narrow
  // terminals: if the row has fewer than 4 fields, the WHOLE output (not just
  // this line) is unreadable rather than risk reading the wrong column.
  const fields = last.trim().split(/\s+/);
  if (fields.length < 4) return null;
  const availableKb = Number(fields[3]);
  if (!Number.isFinite(availableKb)) return null;
  return availableKb * 1024;
}

/* c8 ignore start — CLI wrapper */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };

  const path = arg('path', '.');
  // 5GB: a first estimate, not a measured floor — a next.js checkout + one
  // musl-native rebuild + a handful of concurrent `next build`s comfortably
  // needs low-single-digit GB of headroom; docs/ci/capacity-budget.md is
  // where a measured number belongs once a real breach is observed (TODO
  // #1530).
  const floorGb = Number(arg('floor-gb', '5'));
  const freeBytes = getFreeBytes(path);
  const verdict = evaluateDiskFloor({ freeBytes, floorBytes: floorGb * 1e9 });

  const lines = [
    `state=${verdict.state}`,
    `ok=${verdict.ok ? 'true' : 'false'}`,
    `free_bytes=${freeBytes ?? ''}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(`${lines.join('\n')}\n${verdict.message}`);
  if (!verdict.ok) {
    console.error(`::warning::disk floor check: ${verdict.state} — ${verdict.message}`);
    process.exit(1);
  }
}
/* c8 ignore stop */
