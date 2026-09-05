#!/usr/bin/env node
/**
 * Mutation proof for the audit sibling-range tripwire's CALL-SITE guard
 * (#942, round 3).
 *
 * WHY THIS EXISTS. Round 2 shipped `siblingRangeProblems()` plus a test
 * claiming "main() actually calls the tripwire between pack and install" —
 * and that test was DECORATION: it ordered whole-file `indexOf` hits, whose
 * first matches were the helper DECLARATIONS, so declaration order alone
 * satisfied it and replacing main()'s call with `const problems = [];` left
 * all six tests green. The round-3 verification caught it; the test now
 * slices main()'s body and anchors on call-shaped needles. A guard that has
 * already been decorative once gets a standing prover, not a one-off manual
 * check.
 *
 * The claims proved, each of which fails silently if wrong:
 *
 *   1. deleting the tripwire CALL (the exact round-3 finding, verbatim) reds
 *      the spec — the call-site anchor reads main()'s body, not the
 *      declarations above it;
 *   2. reordering — moving the call BELOW the closure install — reds: the
 *      assertion is about position, and a tripwire that fires after npm has
 *      already resolved the stale sibling audits the wrong closure anyway;
 *   3. a NEGATIVE control — rewording the call-site comment stays green, or
 *      the reds above are equally explained by a spec asserting on prose.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline;
 * a canary red first; anchors exactly once or abort; clean tree between
 * mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/audit-published-sibling-ranges.test.ts';

/** main()'s tripwire block, anchored with its call so it occurs exactly once. */
const TRIPWIRE_CALL = '  const problems = siblingRangeProblems(tarballs.map(packedManifest));\n';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      "the round-3 finding restored VERBATIM — main()'s tripwire call becomes `const problems " +
      '= [];`, so every packed closure is "coherent" and the F1 drift ships unaudited. Round 2\'s ' +
      'whole-file-indexOf assertion stayed green under exactly this edit',
    subject: 'script',
    anchor: TRIPWIRE_CALL,
    replacement: '  const problems = [];\n',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'an install appears BEFORE the tripwire — the call still exists, in the wrong ORDER: npm ' +
      'has already resolved the stale sibling from the registry by the time the tripwire fires, ' +
      'so the audit and SBOM describe the wrong closure before anything can die. M1 proves ' +
      'presence; this proves the ordering comparisons are live, not decoration beside it. (The ' +
      'planted line never executes under the spec — main() is entrypoint-guarded — it only has ' +
      'to EXIST where the position assertion reads.)',
    subject: 'script',
    anchor: "  console.log('[audit-published] asserting packed sibling ranges are coherent…');\n",
    replacement:
      "  spawnSync('npm', ['install', '--dry-run'], { cwd: consumerDir }); // planted: closure install hoisted above the tripwire\n" +
      "  console.log('[audit-published] asserting packed sibling ranges are coherent…');\n",
  },
  {
    id: 'M3',
    expect: 'green',
    claim:
      'NEGATIVE CONTROL — the comment above the call is reworded and the spec stays green: the ' +
      'assertion reads the CALL, not the prose beside it',
    subject: 'script',
    anchor: '  // #942 F1 — BEFORE anything installs: the packed sibling edges must point at\n',
    replacement:
      '  // #942 F1 (reworded by the negative control) — before installing, sibling edges point at\n',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    script: 'scripts/audit-published.mjs',
    spec: SPEC,
  },
});

console.log(`=== mutation proof: ${SPEC} (the tripwire call-site guard, #942 round 3) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

// The canary breaks the drifted-lock expectation itself — a real mutation of
// the real spec, proving the runner is pointed at this file.
prover.proveCanSeeRed({
  subject: 'spec',
  anchor: "expect(problems.join('\\n')).toContain('@getknext/core');",
  replacement: "expect(problems.join('\\n')).toContain('@getknext/never');",
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
