import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  countNodeCompileCache,
  deployIsLive,
  isShardBytecodeLive,
  NODE_CACHE_ACCEPTED_FLOOR,
  NODE_CACHE_HIT_RATIO_FLOOR,
  parseBootLine,
  summarizeBootLedger,
} from '../scripts/e2e-bytecode-liveness.mjs';

/**
 * Bytecode caching is mandatory in every runtime×builder cell, and a cell may
 * only credential on nights where caching is proven LIVE at runtime — not
 * merely configured. This module is the single definition of "live":
 *
 *   * bun  — the deploy booted the compiled exec (`mode=compiled-exec`), whose
 *            bytecode pragma the build-time verifier proved
 *            (`bytecode_verified=true`);
 *   * node — the booted server's V8 ACCEPTED cached code: at least
 *            NODE_CACHE_ACCEPTED_FLOOR accepted entries AND a hit ratio of at
 *            least NODE_CACHE_HIT_RATIO_FLOOR, read from the running server's
 *            own NODE_DEBUG_NATIVE=COMPILE_CACHE output.
 *
 * Every rule is asserted in BOTH directions: the live shape is green and each
 * way of not being live is red.
 */

const SCRIPT = resolve(import.meta.dir, '../scripts/e2e-bytecode-liveness.mjs');

const BUN_LIVE =
  'mode=compiled-exec runtime=bun image=oven/bun:1.4.0-alpine@sha256:abc bytecode_verified=true';
const NODE_LIVE =
  'mode=server-js runtime=node image=- bytecode_verified=- compile_cache_accepted=416 compile_cache_missed=9 compile_cache_rejected=0';
const NODE_COLD =
  'mode=server-js runtime=node image=- bytecode_verified=- compile_cache_accepted=0 compile_cache_missed=426 compile_cache_rejected=0';

/** Real node 24 debug lines, shortened paths. */
const DEBUG_LOG = [
  '[compile cache] resolved path /cc + v24.14.0-x64-cf738c9d-1001 -> /cc/v24.14.0-x64-cf738c9d-1001',
  '[compile cache] reading cache from /cc/v24/4585e49a for CommonJS /s/node_modules/next/dist/server/next.js...[1 2 3]... success, size=848',
  '[compile cache] V8 code cache for CommonJS /s/node_modules/next/dist/server/next.js was accepted, keeping the in-memory entry',
  '[compile cache] V8 code cache for CommonJS /s/node_modules/next/dist/server/lib/start-server.js was accepted, keeping the in-memory entry',
  '[compile cache] V8 code cache for ESM file:///s/server.js was not initialized, initializing the in-memory entry',
  '[compile cache] V8 code cache for CommonJS /s/node_modules/next/dist/x.js was rejected, reset the in-memory entry',
  '[compile cache] skip persisting CommonJS /s/node_modules/next/dist/server/next.js because cache was the same',
].join('\n');

describe('countNodeCompileCache — hits, misses and rejects from V8 debug output', () => {
  it('counts each outcome from the real line shapes', () => {
    expect(countNodeCompileCache(DEBUG_LOG)).toEqual({ accepted: 2, missed: 1, rejected: 1 });
  });

  it('an empty log (debug off, cache off, nothing loaded) is all zeros — never a hit', () => {
    expect(countNodeCompileCache('')).toEqual({ accepted: 0, missed: 0, rejected: 0 });
  });

  it('ignores lines that are not compile-cache debug output (an app logging the phrase is not a hit)', () => {
    expect(countNodeCompileCache('my app says: V8 code cache for x was accepted')).toEqual({
      accepted: 0,
      missed: 0,
      rejected: 0,
    });
  });
});

describe('parseBootLine', () => {
  it('parses key=value pairs, splitting on the FIRST = so digests survive', () => {
    expect(parseBootLine(BUN_LIVE)).toEqual({
      mode: 'compiled-exec',
      runtime: 'bun',
      image: 'oven/bun:1.4.0-alpine@sha256:abc',
      bytecode_verified: 'true',
    });
  });
});

describe('deployIsLive — one deploy', () => {
  it('bun: the verified compiled exec is live', () => {
    expect(deployIsLive(parseBootLine(BUN_LIVE)).live).toBe(true);
  });

  it('bun: a server.js boot is NOT live (the non-bytecode fallback)', () => {
    const r = deployIsLive(parseBootLine('mode=server-js runtime=bun image=- bytecode_verified=-'));
    expect(r.live).toBe(false);
    expect(r.reason).toMatch(/compiled-exec/);
  });

  it('bun: a compiled exec whose bytecode was not verified is NOT live', () => {
    const r = deployIsLive(
      parseBootLine('mode=compiled-exec runtime=bun image=x bytecode_verified=false'),
    );
    expect(r.live).toBe(false);
  });

  it('node: a baked, accepted cache above both floors is live', () => {
    expect(deployIsLive(parseBootLine(NODE_LIVE)).live).toBe(true);
  });

  it('node: a cold boot (0 accepted) is NOT live', () => {
    const r = deployIsLive(parseBootLine(NODE_COLD));
    expect(r.live).toBe(false);
    expect(r.reason).toMatch(/accepted/);
  });

  it('node: a node line carrying no counts at all is NOT live (fail closed)', () => {
    expect(
      deployIsLive(parseBootLine('mode=server-js runtime=node image=- bytecode_verified=-')).live,
    ).toBe(false);
  });

  it('node: accepted at the floor but a hit ratio below it is NOT live', () => {
    const accepted = NODE_CACHE_ACCEPTED_FLOOR;
    const missed = Math.ceil(accepted / NODE_CACHE_HIT_RATIO_FLOOR); // ratio < floor
    const r = deployIsLive(
      parseBootLine(
        `mode=server-js runtime=node compile_cache_accepted=${accepted} compile_cache_missed=${missed} compile_cache_rejected=0`,
      ),
    );
    expect(r.live).toBe(false);
    expect(r.reason).toMatch(/ratio/);
  });

  it('node: one accepted entry below the count floor is NOT live, at the floor it is', () => {
    const line = (n: number) =>
      `mode=server-js runtime=node compile_cache_accepted=${n} compile_cache_missed=0 compile_cache_rejected=0`;
    expect(deployIsLive(parseBootLine(line(NODE_CACHE_ACCEPTED_FLOOR - 1))).live).toBe(false);
    expect(deployIsLive(parseBootLine(line(NODE_CACHE_ACCEPTED_FLOOR))).live).toBe(true);
  });

  it('node: a compiled-exec claim on the node runtime is NOT live (no such node artifact)', () => {
    expect(
      deployIsLive(parseBootLine('mode=compiled-exec runtime=node bytecode_verified=true')).live,
    ).toBe(false);
  });

  it('an unknown runtime is NOT live', () => {
    expect(deployIsLive(parseBootLine('mode=compiled-exec runtime=deno')).live).toBe(false);
  });

  it('the floors are the design values (a lowered floor must be a visible decision)', () => {
    expect(NODE_CACHE_ACCEPTED_FLOOR).toBe(100);
    expect(NODE_CACHE_HIT_RATIO_FLOOR).toBe(0.5);
  });
});

describe('summarizeBootLedger — one shard', () => {
  it('every deploy live → live === deploys, no reasons', () => {
    const s = summarizeBootLedger([NODE_LIVE, NODE_LIVE].join('\n'), 'node');
    expect(s).toMatchObject({ runtime: 'node', deploys: 2, live: 2, notLive: 0 });
    expect(s.reasons).toEqual([]);
  });

  it('one cold deploy among live ones makes the shard not live, and names it', () => {
    const s = summarizeBootLedger([NODE_LIVE, NODE_COLD, NODE_LIVE].join('\n'), 'node');
    expect(s).toMatchObject({ deploys: 3, live: 2, notLive: 1 });
    expect(s.reasons.join(' ')).toMatch(/deploy 2/);
  });

  it('a line from a DIFFERENT runtime than the lane is not live', () => {
    const s = summarizeBootLedger(BUN_LIVE, 'node');
    expect(s).toMatchObject({ deploys: 1, live: 0, notLive: 1 });
  });

  it('blank lines are not deploys', () => {
    expect(summarizeBootLedger(`\n${BUN_LIVE}\n\n`, 'bun')).toMatchObject({ deploys: 1, live: 1 });
  });
});

describe('isShardBytecodeLive — the audit rule, fail closed', () => {
  const live = { runtime: 'node', deploys: 5, live: 5, notLive: 0, reasons: [] };

  it('complete live evidence of the cell runtime passes', () => {
    expect(isShardBytecodeLive(live, 'node').live).toBe(true);
  });

  it('missing evidence fails (a shard summary from before this rule, or a dropped field)', () => {
    expect(isShardBytecodeLive(undefined, 'node').live).toBe(false);
    expect(isShardBytecodeLive(null, 'node').live).toBe(false);
    expect(isShardBytecodeLive('live', 'node').live).toBe(false);
  });

  it('evidence of the wrong runtime fails', () => {
    expect(isShardBytecodeLive({ ...live, runtime: 'bun' }, 'node').live).toBe(false);
  });

  it('zero deploys fails — no evidence is not evidence', () => {
    expect(isShardBytecodeLive({ ...live, deploys: 0, live: 0 }, 'node').live).toBe(false);
  });

  it('recomputes from the counts: live < deploys fails even with notLive forged to 0', () => {
    expect(isShardBytecodeLive({ ...live, live: 4, notLive: 0 }, 'node').live).toBe(false);
  });

  it('any notLive fails', () => {
    expect(isShardBytecodeLive({ ...live, notLive: 1 }, 'node').live).toBe(false);
  });

  it('non-integer counts fail', () => {
    expect(isShardBytecodeLive({ ...live, deploys: '5', live: '5' }, 'node').live).toBe(false);
  });
});

describe('CLI — the workflow check and the harness counter share this module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bytecode-liveness-'));

  it('--check exits 0 on a fully live ledger and 1 on a cold one', () => {
    const ok = join(dir, 'ok.log');
    const cold = join(dir, 'cold.log');
    writeFileSync(ok, `${NODE_LIVE}\n${NODE_LIVE}\n`);
    writeFileSync(cold, `${NODE_LIVE}\n${NODE_COLD}\n`);
    const run = (f: string) =>
      spawnSync('node', [SCRIPT, '--check', '--runtime', 'node', '--ledger', f], {
        encoding: 'utf8',
      });
    expect(run(ok).status).toBe(0);
    expect(run(cold).status).toBe(1);
  });

  it('--check exits 1 on a missing or empty ledger', () => {
    const empty = join(dir, 'empty.log');
    writeFileSync(empty, '');
    const run = (f: string) =>
      spawnSync('node', [SCRIPT, '--check', '--runtime', 'bun', '--ledger', f], {
        encoding: 'utf8',
      });
    expect(run(empty).status).toBe(1);
    expect(run(join(dir, 'does-not-exist.log')).status).toBe(1);
  });

  it('--count-node-log prints the key=value counts e2e-deploy.sh appends', () => {
    const log = join(dir, 'debug.log');
    writeFileSync(log, DEBUG_LOG);
    const r = spawnSync('node', [SCRIPT, '--count-node-log', log], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      'compile_cache_accepted=2 compile_cache_missed=1 compile_cache_rejected=1',
    );
  });

  it('--count-node-log on a missing debug log prints zeros (not live), never fails the deploy', () => {
    const r = spawnSync('node', [SCRIPT, '--count-node-log', join(dir, 'nope.log')], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      'compile_cache_accepted=0 compile_cache_missed=0 compile_cache_rejected=0',
    );
  });
});
