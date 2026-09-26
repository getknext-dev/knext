#!/usr/bin/env node
/**
 * Mutation proof for `tests/soak-1304-readiness.test.ts` — the #1304 soak
 * readiness logic (3 consecutive green first-attempt nights per cell).
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-soak-readiness.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/soak-1304-readiness.test.ts';
const SUBJECT = resolve(REPO_ROOT, 'scripts/lib/soak-readiness.mjs');

const MUTATIONS = [
  {
    label: 'SOAK_REQUIRED_STREAK: drift from 3',
    anchor: 'export const SOAK_REQUIRED_STREAK = 3;',
    replacement: 'export const SOAK_REQUIRED_STREAK = 2;',
  },
  {
    label: 'evaluateCellReadiness: stop requiring enough total nights',
    anchor: 'if (sorted.length < requiredStreak) {',
    replacement: 'if (false) {',
  },
  {
    label: 'evaluateCellReadiness: stop checking the MOST RECENT night specifically',
    anchor: "if (mostRecent.conclusion !== 'success') {",
    replacement: 'if (false) {',
  },
  {
    label: 'evaluateCellReadiness: stop rejecting a RERUN in the trailing window',
    anchor: 'const rerun = window.find((r) => r.attempt !== 1);',
    replacement: 'const rerun = undefined;',
  },
  {
    label: 'evaluateCellReadiness: stop rejecting a red night anywhere in the trailing window',
    anchor: "const red = window.find((r) => r.conclusion !== 'success');",
    replacement: 'const red = undefined;',
  },
  {
    label: 'evaluateCellReadiness: use the FIRST N nights instead of the TRAILING N',
    anchor: 'const window = sorted.slice(-requiredStreak);',
    replacement: 'const window = sorted.slice(0, requiredStreak);',
  },
  {
    label: 'evaluateSoakReadiness: an empty cell set becomes vacuously ready',
    anchor:
      'const overallReady = cellNames.length > 0 && cellNames.every((c) => perCell[c].ready);',
    replacement: 'const overallReady = cellNames.every((c) => perCell[c].ready);',
  },
  {
    label:
      'evaluateSoakReadiness: overall readiness ignores individual cell readiness (SOME instead of EVERY)',
    anchor: 'cellNames.every((c) => perCell[c].ready)',
    replacement: 'cellNames.some((c) => perCell[c].ready)',
  },

  // ── rev-1396: deriveCellRunsFromWindow — the auditWindow -> readiness glue ──
  {
    label: 'deriveCellRunsFromWindow: stop requiring the night to be eligible',
    anchor:
      'const success = n.eligible && onCurrentRcTag && onCredentialedNextRef && inCurrentStreak;',
    replacement: 'const success = onCurrentRcTag && onCredentialedNextRef && inCurrentStreak;',
  },
  {
    label:
      'deriveCellRunsFromWindow: stop requiring the CURRENT rcTag match (accept any RC-shaped ref)',
    anchor: 'const onCurrentRcTag = n.knextRef === expectedKnextRef;',
    replacement: 'const onCurrentRcTag = true;',
  },
  {
    label:
      'deriveCellRunsFromWindow: stop propagating the real runAttempt (always report attempt 1)',
    anchor: 'attempt: Number(n.runAttempt ?? 1),',
    replacement: 'attempt: 1,',
  },
  {
    // #1396 round 2 finding 2 — the credentialed Next.js ref check.
    label: 'deriveCellRunsFromWindow: stop requiring the night tested the credentialed Next.js ref',
    anchor: 'const onCredentialedNextRef = n.ref === expectedNextjsRef;',
    replacement: 'const onCredentialedNextRef = true;',
  },
  {
    label:
      'deriveCellRunsFromWindow: stop throwing when expectedNextjsRef is missing (silently skip the check)',
    anchor: '  if (!expectedNextjsRef) {\n    throw new Error(',
    replacement: '  if (false) {\n    throw new Error(',
  },
  {
    // #1396 round 2 finding 1 — the current-open-streak (fingerprint
    // continuity) check.
    label:
      'deriveCellRunsFromWindow: stop requiring the night to sit inside the CURRENT open streak',
    anchor: 'const inCurrentStreak = currentStreakRunIds.has(n.runId);',
    replacement: 'const inCurrentStreak = true;',
  },
];

declareMutations(14);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 14) {
  console.error(`FATAL: declared 14 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(SUBJECT);
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative, of ${MUTATIONS.length}.`,
);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
