#!/usr/bin/env node
/**
 * Mutation proof for #906's ISR stale-while-revalidate guard (sprint 3, A5).
 *
 * WHAT #906 CLAIMED, AND WHY IT NEEDS PROVING
 * -------------------------------------------
 * #886's real defect was on knext's side of the cache contract: `set` wrote the
 * Redis entry with `EX <revalidate>` (evicting it at the exact moment it should
 * have become stale-but-servable) and `get` returned the stored entry unchanged
 * (so every hit read as fresh and background regeneration was unreachable).
 * `cache-handler-isr-staleness.test.ts` is the guard that pins the fix: the
 * three `cacheState`s, and the Redis TTL rule. It shipped as one of sprint 1's
 * nine guards with a dated exemption instead of a prover (#928) — #928's own
 * triage calls it the highest-priority unproven guard of the four. This file
 * removes that exemption by proving it.
 *
 * THE SIX MUTATIONS are the sysdesign plan's table (§3, `.claude/
 * sprint3-plan-sysdesign.md`), implemented exactly: each is a way the #886
 * defect could quietly come back, and each must independently RED the guard.
 * M6 is the boundary off-by-one the plan singles out: if it survives, the TEST
 * lacks a boundary case, and the fix is a failing boundary test — never a
 * weaker prover.
 *
 * THE GAP THIS PROVER STRUCTURALLY CANNOT CLOSE, stated rather than papered
 * over: the guard's `freshHandler()` deletes `REDIS_URL` and its Redis-path
 * cases inject a fake client, so M1 is proved against `__redisTtlSeconds` and
 * the SET command handed to that fake — never against a live Redis honouring
 * the TTL. That half is S3-V runbook row E (key + TTL read out of a real Redis
 * on the cluster), deliberately not duplicated here. C3 is satisfied by this
 * prover AND row E, not by either alone.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/cache-handler-isr-staleness.test.ts';
const HANDLER = 'packages/kn-next/src/adapters/cache-handler.js';

/**
 * A mutated handler that stopped PARSING reds every test in the guard for the
 * wrong reason — the module fails to import — and that red is indistinguishable
 * in the log from the guard doing its job. Not hypothetical here: this prover's
 * first M6 used a mid-line anchor, the harness's appended line-comment residue
 * marker commented out the tail of the `if (...) {` line, and the "KILLED" that
 * produced would have certified a boundary case the test did not have.
 * (`packages/kn-next` is `"type": "module"`, so `--check` parses it as ESM.)
 */
const jsStillParses = () => {
  const res = spawnSync(process.execPath, ['--check', resolve(REPO_ROOT, HANDLER)], {
    encoding: 'utf8',
  });
  return res.status === 0 ? undefined : `the mutated handler no longer parses: ${res.stderr}`;
};

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the Redis TTL becomes the revalidate window again — this IS the #886 bug: the entry is ' +
      'deleted at the moment it should become stale, so nothing can ever be served stale',
    subject: 'handler',
    validate: jsStillParses,
    anchor: 'return Math.max(revalidate * 2, DEFAULT_TTL_SECONDS);',
    replacement: 'return revalidate;',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the cacheState derivation is deleted — every stored entry comes back unlabelled, all ' +
      'three state assertions must fall; any that survives asserts on something other than ' +
      'the contract',
    subject: 'handler',
    validate: jsStillParses,
    anchor: 'const revalidate = entry.cacheControl?.revalidate;',
    replacement: 'return entry; const revalidate = entry.cacheControl?.revalidate;',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      "every Redis hit is forced to cacheState 'fresh' — the original \"every hit reads fresh, " +
      'background regeneration unreachable" defect, in the string form vinext does not recognise',
    subject: 'handler',
    validate: jsStillParses,
    anchor: 'const parsed = withCacheState(deserializeCacheValue(JSON.parse(data)));',
    replacement:
      "const parsed = { ...deserializeCacheValue(JSON.parse(data)), cacheState: 'fresh' };",
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'set stops persisting the revalidate window — this handler derives staleness from ' +
      'lastModified + cacheControl.revalidate (its revalidateAt), so dropping it makes STALE ' +
      'unreachable',
    subject: 'handler',
    validate: jsStillParses,
    anchor: 'cacheControl.revalidate = revalidate;',
    replacement: 'void revalidate;',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'set stops persisting the expire window — the expireAt equivalent — so EXPIRED becomes ' +
      'unreachable and an expired body would be handed to vinext as merely stale',
    subject: 'handler',
    validate: jsStillParses,
    anchor: 'if (expire !== undefined) cacheControl.expire = expire;',
    replacement: 'void expire;',
  },
  {
    id: 'M6',
    expect: 'red',
    claim:
      'the staleness comparison flips <= to < (stale iff age > revalidate becomes age >= ' +
      'revalidate) — an entry exactly at its revalidate window flips from fresh to stale. If ' +
      'this survives, the TEST has no boundary case; the fix is a failing boundary test, ' +
      'never a weaker prover',
    subject: 'handler',
    validate: jsStillParses,
    // The anchor spans to the end of the line: the harness appends a `//`
    // residue marker after a single-line replacement, and a mid-line anchor
    // would have it comment out the closing `) {` — an unparseable subject,
    // which is a red for the wrong reason (see `jsStillParses`).
    anchor: 'ageSeconds > revalidate) {',
    replacement: 'ageSeconds >= revalidate) {',
  },
];

/**
 * NEGATIVE CONTROL. `DEFAULT_TTL_SECONDS` is a tunable retention default, not
 * part of the #886 contract: the guard asserts the RULE (an entry outlives its
 * revalidate window; `expire` wins when the render claimed one), never the
 * numeric default. Retuning it must leave the guard GREEN — a guard that
 * reddened on retention tuning would be the first one disabled.
 */
const NEGATIVE = {
  id: 'M7',
  expect: 'green',
  claim: 'the retention default is retuned — the guard checks the TTL rule, not the constant',
  subject: 'handler',
  validate: jsStillParses,
  anchor: 'const DEFAULT_TTL_SECONDS = 3600;',
  replacement: 'const DEFAULT_TTL_SECONDS = 3601;',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    handler: 'packages/kn-next/src/adapters/cache-handler.js',
  },
});

console.log(`=== mutation proof: ${SPEC} (#906 ISR staleness) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary blinds the in-memory read path entirely: `get` returns null for
// every entry, so the guard's very first assertion (a just-written entry is a
// hit) must fall. If the runner cannot see that, nothing below is worth reading.
prover.proveCanSeeRed({
  subject: 'handler',
  anchor: 'return labelled;',
  replacement: 'return null;',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
