#!/usr/bin/env node
/**
 * Mutation proof for T6b's published-seam gate.
 *
 * WHAT T6b CLAIMED, AND WHY IT NEEDS PROVING
 * ------------------------------------------
 * `@getknext/core/adapters/cache-handler` is a PUBLISHED subpath, and two of its
 * `__`-exports mutate process-wide cache state: `__setRedisClientForTests(...)`
 * repoints — or with `undefined` disables — the Redis client every request in
 * the process goes through. Sprint close gated them behind `KNEXT_TEST_SEAMS=1`.
 * The gate is right and the surface is still wrong: an env var is settable by an
 * npm postinstall, a compromised transitive dependency, or a Dockerfile `ENV`
 * copied off a blog post. T6b makes the refusal UNCONDITIONAL under
 * `NODE_ENV=production`, so the flag cannot re-open it in a production process.
 *
 * This is a `security.md` invariant on a published artifact, and the whole gate
 * is two `if`s. Removing either is invisible in a diff and observable only as
 * "the cache quietly stopped working in production". Three claims:
 *
 *   1. production refuses REGARDLESS of the flag;
 *   2. outside production the flag still works — a gate that simply threw would
 *      satisfy (1) while breaking every opted-in suite;
 *   3. the published `.d.ts` documents the production refusal, because that is
 *      the surface a TypeScript consumer actually reads.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/cache-handler-seam-gate.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the production refusal is removed — KNEXT_TEST_SEAMS=1 re-opens a process-wide cache ' +
      'mutator in production, which is the whole point of T6b',
    subject: 'handler',
    anchor: "  if (process.env.NODE_ENV === 'production') {",
    replacement: "  if (false && process.env.NODE_ENV === 'production') {",
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the flag gate is removed — the seams become callable by any consumer outside production ' +
      'too, undoing the sprint-close block this builds on',
    subject: 'handler',
    anchor: "  if (process.env.KNEXT_TEST_SEAMS !== '1') {",
    replacement: "  if (false && process.env.KNEXT_TEST_SEAMS !== '1') {",
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the gate throws UNCONDITIONALLY — satisfies "refuses in production" while breaking every ' +
      'opted-in harness, which is why the spec asserts the non-production half as well',
    subject: 'handler',
    // Same anchor as M2, opposite direction: M2 removes the flag gate, this one
    // welds it shut. A guard that only proved M1 would accept either.
    anchor: "  if (process.env.KNEXT_TEST_SEAMS !== '1') {",
    replacement: '  if (true) {',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the published .d.ts stops documenting the production refusal — a TS consumer then meets ' +
      'the gate at runtime, in production, which is the one place it must not be a surprise',
    subject: 'dts',
    anchor:
      ' * unconditionally under NODE_ENV=production — the flag cannot re-enable it in a\n * production process, because nothing legitimate calls it there.',
    replacement: ' * unconditionally — see the .js.',
  },
];

/**
 * NEGATIVE CONTROL. `__redisTtlSeconds` and the other `__`-helpers are PURE —
 * they mutate nothing, and gating them would drag the flag into production
 * diagnostics. Renaming a local inside the gate's message must leave the guard
 * GREEN, or the four reds above are equally explained by a text assertion.
 */
const NEGATIVE = {
  id: 'M5',
  expect: 'green',
  claim: 'the refusal MESSAGE is reworded — the guard asserts behaviour, not prose',
  subject: 'handler',
  anchor: "        'cache. Nothing legitimate calls it in a production process.',",
  replacement:
    "        'cache. Nothing legitimate calls it in a production process (reworded by the negative control).',",
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    handler: 'packages/kn-next/src/adapters/cache-handler.js',
    dts: 'packages/kn-next/src/adapters/cache-handler.d.ts',
  },
});

console.log(`=== mutation proof: ${SPEC} (T6b published-seam gate) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary makes `assertTestSeamEnabled` a no-op, so BOTH mutating seams stop
// refusing under every condition. It must red, and it proves the runner is
// pointed at this spec.
prover.proveCanSeeRed({
  subject: 'handler',
  anchor: 'function assertTestSeamEnabled(name) {',
  replacement: 'function assertTestSeamEnabled(name) {\n  if (name) return;',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
