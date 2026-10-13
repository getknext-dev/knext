#!/usr/bin/env node
/**
 * Mutation proof for the `'use cache'` Redis handler hardening (issue #2278).
 *
 * Four fixes, each of which ships green and unenforced if its test is
 * decorative: the conditional stamp prune, the Redis-clock domain for tag
 * comparisons, the entry-size ceiling, and the two logging corrections. Each
 * mutation below puts back ONE of the defects (or weakens one control) and
 * requires `use-cache-handler.test.ts` to go red.
 *
 * Verdicts are by EXIT CODE only (the shared driver, `scripts/lib/guard-prover.mjs`,
 * never parses output), every anchor must occur exactly once (preflight first),
 * the baseline must be green, a canary must go red before any green is trusted,
 * and every restore is content-verified. The spec is a `bun:test` file, run one
 * file per process by `scripts/bun-test.mjs`.
 *
 * Not covered here: the Lua source of the prune script itself. The test's fake
 * Redis has no Lua VM and answers only the exact script source it models, so a
 * mutated script reds for the wrong reason. M01 instead restores the unconditional
 * HDEL the script replaced, which is the defect the issue names.
 *
 * Usage:  node scripts/mutation-prove-2278-use-cache-hardening.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/use-cache-handler.test.ts';

// Each anchor runs to the end of its line, so the harness's trailing residue
// marker comments out nothing that matters.
const MUTATIONS = [
  // ── 1. prune race ─────────────────────────────────────────────────────────
  {
    id: 'M01',
    subject: 'handler',
    claim: 'the prune deletes unconditionally again: a stamp re-written mid-prune is lost',
    anchor:
      "await core.command(client, 'EVAL', [PRUNE_STAMPS_SCRIPT, '1', tagsKey(), String(cutoff), ...dead]);",
    replacement: "await core.command(client, 'HDEL', [tagsKey(), ...dead]);",
  },
  // ── 2. clock skew ─────────────────────────────────────────────────────────
  {
    id: 'M02',
    subject: 'handler',
    claim: 'tag stamps use the invalidating pod clock again',
    anchor: 'const now = Math.round(localNowMs()) + redisOffset;',
    replacement: 'const now = Math.round(localNowMs());',
  },
  {
    id: 'M03',
    subject: 'handler',
    claim: "an entry's creation time is stored in the writer's clock, not the Redis clock",
    anchor: 'at: Math.round(entry.timestamp + offset),',
    replacement: 'at: entry.timestamp,',
  },
  {
    id: 'M04',
    subject: 'handler',
    claim: 'get compares stamps with the writer-clock timestamp instead of the Redis-clock one',
    anchor: 'const madeAt = Number.isFinite(env.at) ? env.at : env.timestamp;',
    replacement: 'const madeAt = env.timestamp;',
  },
  {
    id: 'M05',
    subject: 'handler',
    claim: "get decides 'expired yet?' on the reader's own clock",
    anchor: 'const now = Math.round(localNowMs()) + offset;',
    replacement: 'const now = Math.round(localNowMs());',
  },
  {
    id: 'M06',
    subject: 'handler',
    claim: "the timestamp handed to Next is not translated into the reader's clock",
    anchor: 'timestamp: madeAt - offset,',
    replacement: 'timestamp: madeAt,',
  },
  {
    id: 'M07',
    subject: 'handler',
    claim: "getExpiration is not translated into the reader's clock",
    anchor: 'return newest === 0 ? 0 : newest - (await clockOffset(core, client));',
    replacement: 'return newest;',
  },
  {
    id: 'M08',
    subject: 'handler',
    claim: 'the Redis clock is re-read on every operation (one extra round trip each)',
    anchor:
      'clock.offset === undefined ? now >= clock.retryAt : now - clock.sampledAt >= CLOCK_RESYNC_MS;',
    replacement: 'true;',
  },
  // ── 3. payload ceiling ────────────────────────────────────────────────────
  {
    id: 'M09',
    subject: 'handler',
    claim: 'the size ceiling is never enforced',
    anchor: 'if (maxBytes > 0 && size > maxBytes) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M10',
    subject: 'handler',
    claim: 'the default ceiling grows from 2 MiB to 8 MiB',
    anchor: 'const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;',
    replacement: 'const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;',
  },
  {
    id: 'M11',
    subject: 'handler',
    claim: 'KNEXT_USE_CACHE_MAX_ENTRY_BYTES=0 no longer lifts the ceiling',
    anchor: 'return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MAX_ENTRY_BYTES;',
    replacement: 'return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_ENTRY_BYTES;',
  },
  {
    id: 'M12',
    subject: 'handler',
    claim: "an oversize stream is abandoned instead of drained: Next's producer is left waiting",
    anchor: 'if (!keep || !value || oversize) continue;',
    replacement: 'if (oversize) break;\n      if (!keep || !value) continue;',
  },
  {
    id: 'M13',
    subject: 'handler',
    claim: 'a skipped oversize entry is no longer counted as oversize',
    anchor: "count('oversize');",
    replacement: "count('skipped');",
  },
  // ── 4. logging ────────────────────────────────────────────────────────────
  {
    id: 'M14',
    subject: 'handler',
    claim: 'the outage warning is per handler kind again (default and remote each warn)',
    anchor: 'const state = shared(core);',
    replacement: 'const state = { outageWarned: false, oversizeWarned: false };',
  },
  {
    id: 'M15',
    subject: 'handler',
    claim: 'a prune failure is logged as a tag-update error again',
    anchor:
      'console.warn("[CacheHandler] Pruning old \'use cache\' tag stamps failed (the tags were updated):", err?.message);',
    replacement:
      'console.error("[CacheHandler] Error updating \'use cache\' tags:", err?.message);',
  },
  {
    id: 'M16',
    subject: 'handler',
    claim: 'the prune goes through the shared breaker again: a prune error takes ISR offline',
    anchor:
      "const reply = await core.command(client, 'HSCAN', [tagsKey(), pruneCursor, 'COUNT', String(PRUNE_PAGE)]);",
    replacement:
      "const reply = await core.redisCall(() => core.command(client, 'HSCAN', [tagsKey(), pruneCursor, 'COUNT', String(PRUNE_PAGE)]));",
  },
  // ── round 2 (review): guards the first sweep did not prove ────────────────
  {
    id: 'M17',
    subject: 'handler',
    claim:
      'the prune DELETE (EVAL) goes through the shared breaker: a Redis refusing scripts opens it',
    anchor:
      "await core.command(client, 'EVAL', [PRUNE_STAMPS_SCRIPT, '1', tagsKey(), String(cutoff), ...dead]);",
    replacement:
      "await core.redisCall(() => core.command(client, 'EVAL', [PRUNE_STAMPS_SCRIPT, '1', tagsKey(), String(cutoff), ...dead]));",
  },
  {
    id: 'M18',
    subject: 'handler',
    claim: 'the TIME read drops its half-round-trip correction (offset taken at the reply)',
    anchor: 'clock.offset = Math.round(serverMs - (t0 + t1) / 2);',
    replacement: 'clock.offset = Math.round(serverMs - t1);',
  },
  {
    id: 'M19',
    subject: 'handler',
    claim: 'the computed Redis clock offset is 1 s wrong',
    anchor: 'clock.offset = Math.round(serverMs - (t0 + t1) / 2);',
    replacement: 'clock.offset = Math.round(serverMs - (t0 + t1) / 2 + 1000);',
  },
  {
    id: 'M20',
    subject: 'handler',
    claim: "the stamp's clock is read BEFORE the first offset read, so it is a round trip early",
    anchor:
      'const redisOffset = await clockOffset(core, client);\n    const now = Math.round(localNowMs()) + redisOffset;',
    replacement: 'const now = Math.round(localNowMs()) + (await clockOffset(core, client));',
  },
  {
    id: 'M21',
    subject: 'handler',
    claim: 'a failing prune warns on every attempt (forever, on a Redis that refuses scripts)',
    anchor: 'if (!state.pruneWarned) {',
    replacement: 'if (true) {',
  },
  {
    id: 'M22',
    subject: 'handler',
    claim: 'a successful prune no longer re-arms the prune warning',
    anchor: 'if (await pruneStamps(client, now)) state.pruneWarned = false;',
    replacement: 'await pruneStamps(client, now);',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { handler: 'packages/kn-next/src/adapters/use-cache-handler.js' },
});

console.log("=== mutation proof: 'use cache' handler hardening (#2278) ===");
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'handler',
  anchor: 'const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;',
  replacement: 'const DEFAULT_MAX_ENTRY_BYTES = 1;',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
