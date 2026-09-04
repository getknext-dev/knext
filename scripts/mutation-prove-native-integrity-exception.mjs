#!/usr/bin/env node
/**
 * Mutation proof for S2's native-integrity absence exception.
 *
 * WHAT S2 CLAIMED, AND WHY IT NEEDS PROVING
 * -----------------------------------------
 * `sharp-addon-dlopen.mjs` is the last gate before native-code privilege. A
 * MISMATCH has always been fatal; ABSENCE of the manifest warns and loads,
 * because an image built before native-tree pinning has none and refusing would
 * turn a supply-chain fix into a fleet outage. That is the right default and it
 * had neither an expiry nor an off switch — the exact ADR-0044 shape this repo
 * has already been bitten by, where a deferral quietly becomes the design.
 *
 * S2 adds both, and each half can fail silently in a different direction:
 *
 *   1. `KNEXT_REQUIRE_NATIVE_INTEGRITY=1` must REFUSE an absent manifest. If the
 *      throw goes, an operator who believes their fleet is fail-closed is not,
 *      and nothing anywhere says so.
 *   2. Without the variable it must still LOAD. A shim that refuses on absence
 *      unconditionally satisfies (1) while bricking every pre-pinning image —
 *      the outage the exception exists to prevent.
 *   3. Only the exact value `1` enables it, so a stray `0`/`false` cannot fail a
 *      fleet closed by accident.
 *   4. The exception carries a real CLOCK. An `expires` that stops being read is
 *      the quietest way to neuter a deferral: it still reads as dated.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/native-integrity-absence-exception.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'KNEXT_REQUIRE_NATIVE_INTEGRITY=1 stops refusing — an operator who set it believes the ' +
      'fleet fails closed on an unverifiable native tree, and it does not',
    subject: 'shim',
    anchor: "    if (process.env.KNEXT_REQUIRE_NATIVE_INTEGRITY === '1') {",
    replacement: "    if (false && process.env.KNEXT_REQUIRE_NATIVE_INTEGRITY === '1') {",
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the switch becomes UNCONDITIONAL — every image predating native-tree pinning stops ' +
      'loading sharp at all, which is the fleet outage the exception exists to prevent',
    subject: 'shim',
    anchor: "    if (process.env.KNEXT_REQUIRE_NATIVE_INTEGRITY === '1') {",
    replacement: '    if (true) {',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the switch becomes truthiness rather than the exact value 1 — KNEXT_REQUIRE_NATIVE_INTEGRITY=0 ' +
      'then fails a whole fleet closed, the classic env-var-as-boolean defect',
    subject: 'shim',
    anchor: "process.env.KNEXT_REQUIRE_NATIVE_INTEGRITY === '1'",
    replacement: 'process.env.KNEXT_REQUIRE_NATIVE_INTEGRITY',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'a MISMATCH stops being fatal while the switch is on — the switch would then be the only ' +
      'thing standing between a swapped addon and native-code privilege',
    subject: 'shim',
    anchor: '    if (actual !== expected) {',
    replacement: '    if (false && actual !== expected) {',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'the exception loses its clock — a lapsed entry stops lapsing, so the deferral reads as ' +
      'dated forever, which is exactly how a deferral becomes the design',
    subject: 'policy',
    anchor: "  return activeExemptions(NATIVE_INTEGRITY_EXEMPTIONS, { field: 'exception', now });",
    replacement:
      '  void now;\n  return new Set(NATIVE_INTEGRITY_EXEMPTIONS.map((e) => e.exception));',
  },
];

/**
 * NEGATIVE CONTROL. The refusal message tells an operator to rebuild the image
 * or unset the variable. Rewording it must leave the guard GREEN — otherwise the
 * five reds above are equally explained by the spec asserting on the shim's TEXT
 * rather than its behaviour, and the guard would red on every improvement to its
 * own diagnostics.
 */
const NEGATIVE = {
  id: 'M6',
  expect: 'green',
  claim: 'a refusal MESSAGE is reworded — the guard asserts behaviour, not prose',
  subject: 'shim',
  anchor:
    "          '  integrity pinning; rebuild it with a current `kn-next build`, or unset the variable\\n' +",
  replacement:
    "          '  integrity pinning (reworded by the negative control); rebuild it with a current `kn-next build`, or unset the variable\\n' +",
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    shim: 'packages/kn-next/src/adapters/sharp-addon-dlopen.mjs',
    policy: 'scripts/lib/native-integrity-policy.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (S2 native-integrity absence exception) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary removes the manifest LOOKUP, so every tree looks unpinned. The
// pinned cases in the spec then fail, which also proves the runner is pointed at
// the right spec rather than exiting 0 on a file it never collected.
prover.proveCanSeeRed({
  subject: 'shim',
  anchor: '  const manifestPath = findManifest(dirname(addon));',
  replacement: '  const manifestPath = null;\n  void findManifest;',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
