#!/usr/bin/env node

/**
 * Mutation proof for `tests/compat-vinext-structural-gaps.test.ts` (the vinext
 * structural-gap ledger, ADR-0007 amendment 2026-10-09).
 *
 * WHAT THIS PROVES
 *   Every bound the ledger claims is a bound the spec can see go missing. Each
 *   mutation removes ONE behaviour and the spec must exit non-zero (exit codes
 *   only, never output). A mutation the spec survives is a guard that is
 *   decoration.
 *
 *     - the file cap is not enforced                       (M1)
 *     - the cap is raised (it may only ever go down)       (M2)
 *     - a 50th file is added to the committed ledger       (M3)
 *     - `reviewBy` passing does not red the run            (M4)
 *     - the 92-day review window is unbounded              (M5)
 *     - an unknown (non-corpus) file is accepted           (M6)
 *     - the vinext-only lane check is gone                 (M7)
 *     - use on a stable cell: apply no longer refuses      (M8, M9)
 *     - use on a stable cell: report no longer refuses     (M10)
 *     - a file that starts PASSING is no longer stale      (M11, M12)
 *     - the workflow stops passing the ledger              (M13)
 *     - the file SET is not pinned (swap / runtime check)  (M14, M15)
 *
 * Usage:  node scripts/mutation-prove-compat-vinext-structural-gaps.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { MUTATION_MARKER, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-vinext-structural-gaps.test.ts';
const GAPS = resolve(REPO_ROOT, 'scripts/compat-vinext-structural-gaps.mjs');
const LEDGER_SCRIPT = resolve(REPO_ROOT, 'scripts/compat-vinext-ledger.mjs');
const DATA = resolve(REPO_ROOT, 'test/compat-vinext-structural-gaps.json');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/compat-vinext.yml');

declareMutations(15);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** Exit code of the spec: 0 = green. */
function specExit() {
  return spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).status;
}

let pass = 0;
let fail = 0;

function prove(label, target, anchor, replacement, options) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(target);
  try {
    mutate(snap, anchor, replacement, options);
    const code = specExit();
    if (code === 0) {
      console.log('   x DECORATION: the spec stayed GREEN (exit 0) with the behaviour removed');
      fail += 1;
    } else {
      console.log(`   ok went RED as required (exit ${code})`);
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (specExit() !== 0) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: the spec must be GREEN (exit 0) before anything is mutated.');
if (specExit() !== 0) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// Canary: a spec that cannot see red proves nothing. Break an unrelated-but-
// asserted fact (the reason constant) and require a non-zero exit first.
{
  const snap = snapshot(GAPS);
  try {
    mutate(
      snap,
      "export const STRUCTURAL_BUILDER = 'vinext';",
      "export const STRUCTURAL_BUILDER = 'not-vinext';",
    );
    if (specExit() === 0) {
      console.error('FATAL: canary mutation stayed green — the harness cannot see red');
      process.exit(1);
    }
    console.log('   ok canary went red\n');
  } finally {
    restore(snap);
  }
  if (specExit() !== 0) {
    console.error('FATAL: spec not green after the canary restore');
    process.exit(1);
  }
}

// M1 — the cap is not enforced.
prove('the file cap is not enforced', GAPS, 'files.length > STRUCTURAL_FILE_CAP', 'false');

// M2 — the cap is raised. It may only ever go DOWN from the original 49.
prove(
  'the cap is raised above the original 49',
  GAPS,
  'export const STRUCTURAL_FILE_CAP = 49;',
  'export const STRUCTURAL_FILE_CAP = 60;',
);

// M3 — a file is ADDED to the committed ledger. JSON has no comments: the
// residue marker rides in as a JSON-legal key.
prove(
  'a file is added to the committed ledger (over the frozen cap)',
  DATA,
  '"files": [',
  `"//${MUTATION_MARKER}": 1,\n  "files": [\n    { "test": "test/e2e/app-dir/zz-added-after-the-freeze/added.test.ts", "cases": ["x"] },`,
);

// M4 — reviewBy passing does not red the run.
prove('a passed reviewBy no longer reds the run', GAPS, 'days(g.reviewBy, ctx.today) > 0', 'false');

// M5 — the 92-day (quarterly) window is unbounded.
prove(
  'the 92-day review window is unbounded',
  GAPS,
  'else if (span > STRUCTURAL_MAX_REVIEW_DAYS)',
  'else if (false)',
);

// M6 — a file that is not a corpus member is accepted.
prove(
  'an unknown (non-corpus) file is accepted',
  GAPS,
  'else if (!manifestIncludes(ctx.manifest, f.test))',
  'else if (false)',
);

// M7 — the lane check is gone: the ledger could name a stable lane.
prove(
  'the vinext-only lane check is removed',
  GAPS,
  'if (!STRUCTURAL_LANES.includes(ledger.lane))',
  'if (false)',
);

// M8 — use on a stable cell: the refusal predicate accepts everything.
prove(
  'a stable cell’s summary is no longer refused (predicate)',
  GAPS,
  'if (summary?.builder === STRUCTURAL_BUILDER) return null;',
  'return null;',
);

// M9 — use on a stable cell: `apply` stops calling the refusal.
prove(
  'apply no longer refuses a stable cell’s summary',
  LEDGER_SCRIPT,
  'const refusal = structural ? structuralApplyRefusal(before) : null;',
  'const refusal = null;',
);

// M10 — use on a stable cell: `report` stops calling the refusal.
prove(
  'report no longer refuses a stable cell’s summaries',
  LEDGER_SCRIPT,
  'const refused = summaries.map(structuralApplyRefusal).filter(Boolean);',
  'const refused = [];',
);

// M11 — a file that starts passing is not detected as stale.
prove(
  'a ledgered file that PASSES is no longer stale (detector)',
  GAPS,
  'if (!failing.has(f.test)) stale.push({ test: f.test });',
  'void 0;',
);

// M12 — a detected stale entry no longer reds the report's exit code.
prove(
  'a stale structural entry no longer reds the report',
  LEDGER_SCRIPT,
  'structuralStale.stale.length ||',
  'false ||',
);

// M13 — the workflow stops passing the ledger to `apply`.
prove(
  'the workflow stops passing the structural ledger to apply',
  WORKFLOW,
  '--structural test/compat-vinext-structural-gaps.json \\',
  '',
);

// M14 — a ledgered file is SWAPPED for a different failing file (same count).
// The committed JSON carries the swap; the count-only guards would stay green.
prove(
  'a ledgered file is swapped for a different one (committed JSON)',
  DATA,
  'test/e2e/app-dir/navigation-focus/navigation-focus.test.ts',
  'test/e2e/app-dir/catch-error/catch-error.test.ts',
);

// M15 — the run-time set check is removed from the validator (apply/report).
prove(
  'the run-time canonical-set check is removed',
  GAPS,
  'if (!CANONICAL_SET.has(f.test))',
  'if (false)',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
