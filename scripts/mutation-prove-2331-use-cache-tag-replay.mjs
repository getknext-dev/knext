#!/usr/bin/env node
/**
 * Mutation proof for the `'use cache'` tag replay (issue #2331).
 *
 * Two specs, two tables, one subject (`use-cache-handler.js`):
 *
 *  - REPLAY rows grade `use-cache-breaker-tag-replay.test.ts`: what an outage
 *    records, how the backlog is bounded, deduplicated and kept across a run,
 *    when a replay starts, how it stops at the first fault, and the read-then-
 *    write fallback for a Redis that refuses scripts. Those tests run on a fake
 *    Redis with no Lua engine, which answers the replay script with a JavaScript
 *    model keyed by the imported script constant, so they cannot see the Lua.
 *  - LUA rows grade `use-cache-replay-script-live-redis.test.ts`, which EVALs the
 *    exact `REPLAY_STAMPS_SCRIPT` on a REAL Redis and requires each result to
 *    equal the model's. Each row flips one comparison or one value of the Lua.
 *    A mutated script would stay green in the fake-backed spec; it must go red
 *    here.
 *
 * The Lua rows need a real Redis: set KNEXT_REDIS_LIVE_URL to a loopback Redis
 * (CI's nightly prover lane provides one). Without it this prover FAILS before
 * planting anything: the live spec would skip, every Lua row would survive, and
 * a prover that quietly dropped its Lua rows would report a proof it never ran.
 *
 * Verdicts are by EXIT CODE only (`scripts/lib/guard-prover.mjs`), every anchor
 * must occur exactly once (preflight first), each baseline must be green, a
 * canary must go red before any green is trusted, and every restore is
 * content-verified. Each anchor runs to the end of its line, so the harness's
 * trailing residue marker comments out nothing that matters.
 *
 * Usage:
 *   KNEXT_REDIS_LIVE_URL=redis://127.0.0.1:6379 \
 *     node scripts/mutation-prove-2331-use-cache-tag-replay.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPLAY_SPEC = 'packages/kn-next/src/__tests__/use-cache-breaker-tag-replay.test.ts';
const LIVE_SPEC = 'packages/kn-next/src/__tests__/use-cache-replay-script-live-redis.test.ts';

if (!(process.env.KNEXT_REDIS_LIVE_URL ?? '').trim()) {
  console.error(
    'ABORT: KNEXT_REDIS_LIVE_URL is not set. The Lua rows of this prover are graded by ' +
      `${LIVE_SPEC}, which runs the replay script on a real Redis and SKIPS without one, so ` +
      'every Lua row would survive. Point it at a loopback Redis, e.g. ' +
      "`redis-server --port 6399 --save ''` and KNEXT_REDIS_LIVE_URL=redis://127.0.0.1:6399.",
  );
  process.exit(2);
}

const REPLAY = [
  // ── what an outage records ────────────────────────────────────────────────
  {
    id: 'R01',
    subject: 'handler',
    claim: 'an updateTags that finds the breaker open is not recorded for replay',
    anchor:
      "      noteUnavailable();\n      count('tagsDropped');\n      recordDroppedTags(core, list, durations);",
    replacement: "      noteUnavailable();\n      count('tagsDropped');",
  },
  {
    id: 'R02',
    subject: 'handler',
    claim: 'an updateTags whose HSET faults (breaker closed) is not recorded for replay',
    anchor:
      '      console.error("[CacheHandler] Error updating \'use cache\' tags:", err?.message);\n      recordDroppedTags(core, list, durations);',
    replacement:
      '      console.error("[CacheHandler] Error updating \'use cache\' tags:", err?.message);',
  },
  {
    id: 'R03',
    subject: 'handler',
    claim: 'tags are recorded with no Redis configured at all',
    anchor: '  if (!core.redisConfigured()) return;',
    replacement: '',
  },
  {
    id: 'R04',
    subject: 'handler',
    claim: 'merging a later drop forgets an earlier stale stamp',
    anchor:
      '  const next = { generation, stale: prev?.stale ?? false, expireMs: prev?.expireMs ?? null };',
    replacement: '  const next = { generation, stale: false, expireMs: prev?.expireMs ?? null };',
  },
  // ── the bound and the collapse ────────────────────────────────────────────
  {
    id: 'R05',
    subject: 'handler',
    claim: 'the backlog bound is off by one (1001 tags kept)',
    anchor: '      if (!prev && replay.tags.size >= REPLAY_MAX_TAGS) {',
    replacement: '      if (!prev && replay.tags.size > REPLAY_MAX_TAGS) {',
  },
  {
    id: 'R06',
    subject: 'handler',
    claim: 'the collapse sweep deletes the stamp hash too',
    anchor:
      '    const keys = (Array.isArray(reply?.[1]) ? reply[1].map(String) : []).filter((k) => k !== stamps);',
    replacement: '    const keys = Array.isArray(reply?.[1]) ? reply[1].map(String) : [];',
  },
  {
    id: 'R07',
    subject: 'handler',
    claim: 'a drop recorded during the collapse sweep is lost (no generation check)',
    anchor: '  if (replay.generation === generation) replay.collapsed = false;',
    replacement: '  replay.collapsed = false;',
  },
  {
    id: 'R08',
    subject: 'handler',
    claim: 'tags_collapsed is not counted',
    anchor: "  count('tagsCollapsed');",
    replacement: '',
  },
  // ── one run, its writes, and what it keeps ────────────────────────────────
  {
    id: 'R09',
    subject: 'handler',
    claim: 'the replay goes back to a plain HSET at the client clock (the round-1 overwrite)',
    anchor:
      '    await writeReplayBatch(core, client, batch.flatMap(([tag, record]) => replayArgs(tag, record)));',
    replacement:
      "    await core.redisCall(() => core.command(client, 'HSET', [tagsKeyOf(core), ...batch.flatMap(([tag, record]) => stampFields(tag, record, Math.round(localNowMs())))]));",
  },
  {
    id: 'R10',
    subject: 'handler',
    claim: 'the replay does not stop at the first fault (a storm against a dying Redis)',
    anchor:
      '    await writeReplayBatch(core, client, batch.flatMap(([tag, record]) => replayArgs(tag, record)));',
    replacement:
      '    try {\n      await writeReplayBatch(core, client, batch.flatMap(([tag, record]) => replayArgs(tag, record)));\n    } catch {\n      continue;\n    }',
  },
  {
    id: 'R11',
    subject: 'handler',
    claim: 'a drop recorded while its write was in flight is forgotten (no generation check)',
    anchor: '      if (replay.tags.get(tag)?.generation !== record.generation) continue;',
    replacement: '',
  },
  {
    id: 'R12',
    subject: 'handler',
    claim: 'a superseded write is counted as replayed',
    anchor:
      '      if (replay.tags.get(tag)?.generation !== record.generation) continue;\n      replay.tags.delete(tag);',
    replacement:
      '      if (replay.tags.get(tag)?.generation === record.generation) replay.tags.delete(tag);',
  },
  {
    id: 'R13',
    subject: 'handler',
    claim: 'tags_replayed is not counted',
    anchor: "      count('tagsReplayed');",
    replacement: '',
  },
  {
    id: 'R14',
    subject: 'handler',
    claim: 'the whole backlog goes in one script call',
    anchor: 'const REPLAY_BATCH = 100;',
    replacement: 'const REPLAY_BATCH = 100_000;',
  },
  {
    id: 'R15',
    subject: 'handler',
    claim: 'the replay omits the stale stamp',
    anchor: "  if (record.stale) args.push(`s:${tag}`, '0');",
    replacement: '',
  },
  {
    id: 'R16',
    subject: 'handler',
    claim: 'the replay sends expire-now for every window',
    anchor: '  if (record.expireMs !== null) args.push(`e:${tag}`, String(record.expireMs));',
    replacement: "  if (record.expireMs !== null) args.push(`e:${tag}`, '0');",
  },
  // ── when a replay starts, and the probe ───────────────────────────────────
  {
    id: 'R17',
    subject: 'handler',
    claim: 'a request that finds the breaker closed does not start the replay',
    anchor: '    if (client && replayPending(state.replay)) startTagReplay(core);',
    replacement: '',
  },
  {
    id: 'R18',
    subject: 'handler',
    claim: 'no probe is set after a run, so an idle pod never replays',
    anchor: '        replay.run = null;\n        scheduleTagProbe(core);',
    replacement: '        replay.run = null;',
  },
  {
    id: 'R19',
    subject: 'handler',
    claim: "the probe timer is not unref'd and holds the process open",
    anchor: '  replay.timer.unref?.();',
    replacement: '',
  },
  {
    id: 'R20',
    subject: 'handler',
    claim: 'the replay run is not enrolled in the SIGTERM drain registry',
    anchor: '  replay.run = trackWrite(',
    replacement: '  replay.run = (',
  },
  {
    id: 'R21',
    subject: 'handler',
    claim: 'a client that can no longer be loaded keeps the backlog (and a probe) forever',
    anchor:
      '  if (!core.redisConfigured()) {\n    // The client could not be loaded at all: there is nothing a replay could reach.\n    resetUseCacheTagReplay(core);\n    return;\n  }',
    replacement: '',
  },
  // ── the script call and its read-then-write fallback ──────────────────────
  {
    id: 'R22',
    subject: 'handler',
    claim: 'the script goes through the breaker: a Redis refusing scripts takes ISR offline',
    anchor: "    await core.command(client, 'EVAL', [REPLAY_STAMPS_SCRIPT, '1', key, ...args]);",
    replacement:
      "    await core.redisCall(() => core.command(client, 'EVAL', [REPLAY_STAMPS_SCRIPT, '1', key, ...args]));",
  },
  {
    id: 'R23',
    subject: 'handler',
    claim: 'a refused script has no read-then-write fallback (the stamps are never written)',
    anchor: '  const fields = args.filter((_, i) => i % 2 === 0);',
    replacement: '  if (key) return;\n  const fields = args.filter((_, i) => i % 2 === 0);',
  },
  {
    id: 'R24',
    subject: 'handler',
    claim: 'the fallback moves an expiry already in effect into the future',
    anchor: '  if (cur <= now) return want <= now ? now : null;',
    replacement: '  if (cur <= now) return want;',
  },
  {
    id: 'R25',
    subject: 'handler',
    claim: 'the fallback leaves an expiry in effect alone on expire-now',
    anchor: '  if (cur <= now) return want <= now ? now : null;',
    replacement: '  if (cur <= now) return null;',
  },
  {
    id: 'R26',
    subject: 'handler',
    claim: 'the fallback never brings a pending expiry forward',
    anchor: '  return want < cur ? want : null;',
    replacement: '  return null;',
  },
  {
    id: 'R27',
    subject: 'handler',
    claim: 'the fallback moves a stale stamp back',
    anchor: "  if (field.startsWith('s:')) return cur === null || cur < now ? now : null;",
    replacement: "  if (field.startsWith('s:')) return now;",
  },
  {
    id: 'R28',
    subject: 'handler',
    claim: "the fallback's write bypasses the breaker (a dead link would not trip it)",
    anchor:
      "  if (writes.length > 0) await core.redisCall(() => core.command(client, 'HSET', [key, ...writes]));",
    replacement: "  if (writes.length > 0) await core.command(client, 'HSET', [key, ...writes]);",
  },
];

// The script's lines are JS string literals in an array; each anchor is a whole
// line, quotes and trailing comma included, so the residue marker lands after it.
const LUA = [
  {
    id: 'L01',
    subject: 'handler',
    claim: 's: is re-written when it already equals now (boundary < flipped to <=)',
    anchor: "  '    if not cur or cur < now then v = now end',",
    replacement: "  '    if not cur or cur <= now then v = now end',",
  },
  {
    id: 'L02',
    subject: 'handler',
    claim: 'an s: stamp ahead of now is moved back to now',
    anchor: "  '    if not cur or cur < now then v = now end',",
    replacement: "  '    if true then v = now end',",
  },
  {
    id: 'L03',
    subject: 'handler',
    claim: 'an expiry equal to now is treated as pending (boundary <= flipped to <)',
    anchor: "  '    elseif cur <= now then',",
    replacement: "  '    elseif cur < now then',",
  },
  {
    id: 'L04',
    subject: 'handler',
    claim: 'expire-now leaves an expiry already in effect alone (boundary <= flipped to <)',
    anchor: "  '      if want <= now then v = now end',",
    replacement: "  '      if want < now then v = now end',",
  },
  {
    id: 'L05',
    subject: 'handler',
    claim: 'an expiry already in effect is moved into the future',
    anchor: "  '      if want <= now then v = now end',",
    replacement: "  '      v = want',",
  },
  {
    id: 'L06',
    subject: 'handler',
    claim: 'a pending expiry is pushed later instead of brought forward (< flipped to >)',
    anchor: "  '    elseif want < cur then v = want end',",
    replacement: "  '    elseif want > cur then v = want end',",
  },
  {
    id: 'L07',
    subject: 'handler',
    claim: 'a pending expiry equal to the wanted one is re-written (boundary < flipped to <=)',
    anchor: "  '    elseif want < cur then v = want end',",
    replacement: "  '    elseif want <= cur then v = want end',",
  },
  {
    id: 'L08',
    subject: 'handler',
    claim: "a fresh tag's expiry is written at now, dropping its window",
    anchor: "  '    if not cur then v = want',",
    replacement: "  '    if not cur then v = now',",
  },
  {
    id: 'L09',
    subject: 'handler',
    claim: 's: and e: fields swap rules',
    anchor: '  "  if string.sub(field, 1, 2) == \'s:\' then",',
    replacement: '  "  if string.sub(field, 1, 2) == \'e:\' then",',
  },
  {
    id: 'L10',
    subject: 'handler',
    claim: "the script's now is a second off the Redis clock",
    anchor: "  'local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)',",
    replacement:
      "  'local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + 1000',",
  },
  {
    id: 'L11',
    subject: 'handler',
    claim: 'the e: window (ARGV ms) is ignored',
    anchor: "  '    local want = now + tonumber(ARGV[i + 1])',",
    replacement: "  '    local want = now',",
  },
  {
    id: 'L12',
    subject: 'handler',
    claim: 'the written value is now, not the decided value',
    anchor: "  \"    redis.call('HSET', KEYS[1], field, string.format('%.0f', v))\",",
    replacement: "  \"    redis.call('HSET', KEYS[1], field, string.format('%.0f', now))\",",
  },
  {
    id: 'L13',
    subject: 'handler',
    claim: 'the script does not count what it wrote',
    anchor: "  '    n = n + 1',",
    replacement: "  '    n = n',",
  },
];

// Two drivers over the SAME subject file, one per spec. Each snapshots it up
// front and restores from its own snapshot; they never hold a mutation at once.
const replay = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: REPLAY_SPEC,
  subjects: { handler: 'packages/kn-next/src/adapters/use-cache-handler.js' },
});
const live = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: LIVE_SPEC,
  subjects: { handler: 'packages/kn-next/src/adapters/use-cache-handler.js' },
});

console.log("=== mutation proof: 'use cache' tag replay (#2331) ===");
replay.preflight(REPLAY);
live.preflight(LUA);
declareMutations(REPLAY.length + LUA.length);

console.log(`\n=== replay rows: ${REPLAY_SPEC} ===`);
replay.baseline();
replay.proveCanSeeRed({
  subject: 'handler',
  anchor: 'const REPLAY_MAX_TAGS = 1000;',
  replacement: 'const REPLAY_MAX_TAGS = 1;',
});
for (const m of REPLAY) {
  replay.run({ ...m, expect: 'red' });
  recordMutation();
}
replay.finish(REPLAY.length);

console.log(`\n=== Lua rows: ${LIVE_SPEC} (real Redis) ===`);
live.baseline();
live.proveCanSeeRed({
  subject: 'handler',
  anchor: '  "local t = redis.call(\'TIME\')",',
  replacement: "  \"local t = { '0', '0' }\",",
});
for (const m of LUA) {
  live.run({ ...m, expect: 'red' });
  recordMutation();
}
live.finish(LUA.length);
