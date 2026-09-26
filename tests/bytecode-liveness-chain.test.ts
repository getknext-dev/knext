import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildLedger } from '../scripts/compat-run-ledger.mjs';
import { gradeNight } from '../scripts/compat-window-audit.mjs';

/**
 * The evidence chain: boot ledger → shard summary → run ledger → audit.
 *
 * tests/bytecode-liveness.test.ts pins the liveness RULE. That rule is only
 * worth anything if the evidence actually reaches the audit, so this drives the
 * REAL scripts end to end: `e2e-summary.mjs --boot-ledger` (the workflow's
 * summarize step), `buildLedger` (the shard-ledger job) and `gradeNight` (the
 * credential audit). Only the bytecode evidence varies; every other rule is
 * held green so a red result can only come from the liveness rule.
 */

const SUMMARY = resolve(import.meta.dir, '../scripts/e2e-summary.mjs');
const dir = mkdtempSync(join(tmpdir(), 'bytecode-chain-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BUN_LIVE =
  'mode=compiled-exec runtime=bun image=oven/bun:1.4.0-alpine@sha256:abc bytecode_verified=true'; // oven-bun-pin-exempt: synthetic fixture (fake version + digest), not a real selection
const NODE_LIVE =
  'mode=server-js runtime=node image=- bytecode_verified=- compile_cache_bake=ok compile_cache_accepted=416 compile_cache_missed=9 compile_cache_rejected=0';
const NODE_COLD =
  'mode=server-js runtime=node image=- bytecode_verified=- compile_cache_bake=ok compile_cache_accepted=0 compile_cache_missed=426 compile_cache_rejected=0';

let n = 0;
function summarizeShard(runtime: 'node' | 'bun', bootLedgerText: string | null) {
  n += 1;
  const out = join(dir, `summary-${n}.json`);
  const log = join(dir, `runner-${n}.log`);
  writeFileSync(log, '');
  const args = [SUMMARY, '--runner-log', log, '--ref', 'v16.2.0', '--shard', '1/1'];
  args.push('--excluded', '0', '--runtime', runtime, '--out', out);
  if (bootLedgerText !== null) {
    const boot = join(dir, `boot-${n}.log`);
    writeFileSync(boot, bootLedgerText);
    args.push('--boot-ledger', boot);
  }
  const r = spawnSync('node', args, { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  // A green shard's counts, so only the bytecode rule is under test.
  return { ...JSON.parse(readFileSync(out, 'utf8')), passed: 5, failed: 0, notRun: 0 };
}

function grade(summary: Record<string, unknown>, lane: string) {
  const { ledger } = buildLedger({
    shards: [summary],
    shardTotal: '1',
    fingerprint: { fingerprint: 'sha256:aaaa' },
    runId: '1',
    runAttempt: '1',
    event: 'schedule',
    compatMode: 'credential',
    knextRef: 'refs/tags/v1.0.0-rc.1',
    knextSha: 'a'.repeat(40),
  });
  return gradeNight(ledger, { lane });
}

describe('evidence chain — e2e-summary --boot-ledger → compat-run-ledger → gradeNight', () => {
  it('node: a live boot ledger yields a credential-eligible night', () => {
    const summary = summarizeShard('node', `${NODE_LIVE}\n${NODE_LIVE}\n`);
    expect(summary.bytecode).toMatchObject({ runtime: 'node', deploys: 2, live: 2, notLive: 0 });
    expect(grade(summary, 'node').disqualifiers).toEqual([]);
  });

  it('node: one cold deploy in the boot ledger makes the night ineligible', () => {
    const g = grade(summarizeShard('node', `${NODE_LIVE}\n${NODE_COLD}\n`), 'node');
    expect(g.eligible).toBe(false);
    expect(g.disqualifiers.join(' ')).toContain('bytecode-not-live');
  });

  it('bun: the verified compiled exec is eligible', () => {
    expect(grade(summarizeShard('bun', `${BUN_LIVE}\n`), 'bun').eligible).toBe(true);
  });

  it('bun: a non-bytecode server.js boot is NOT eligible', () => {
    const summary = summarizeShard(
      'bun',
      'mode=server-js runtime=bun image=- bytecode_verified=-\n',
    );
    expect(grade(summary, 'bun').eligible).toBe(false);
  });

  it('an EMPTY boot ledger is zero deploys — not eligible', () => {
    expect(grade(summarizeShard('node', ''), 'node').eligible).toBe(false);
  });

  it('no --boot-ledger at all → no evidence in the summary → not eligible (fail closed)', () => {
    const summary = summarizeShard('node', null);
    expect(summary.bytecode).toBeUndefined();
    expect(grade(summary, 'node').eligible).toBe(false);
  });
});
