#!/usr/bin/env node
/**
 * Standing mutation proof for the ci.yml BLOCKING-GATE guards (#672 item 1).
 *
 * `scripts/mutation-prove-blocking-gate.mjs` proves the audit ENGINE cannot be
 * gutted. This one proves the opposite direction, on the real workflow: every
 * guard that claims "this ci.yml job runs unconditionally on a PR and its
 * failure fails the run" must go RED when that claim is actually falsified.
 *
 * It exists because #672 measured the gap it closes. Before the conversion,
 * `tests/compile-cache-health-bun-ci.test.ts` asked the question as TEXT
 * (`not.toMatch(/continue-on-error:\s*true/)` over the job's lines) and stayed
 * GREEN under all four disarms below — the same four #661 measured on the
 * bun-exec guards. A guard that stays green while its subject is removed is
 * decoration, and the only way to know which of those a guard is, is to remove
 * the subject and look.
 *
 * PRE-CONVERSION BASELINE, per guard — recorded here because #672's own PR body
 * UNDER-CLAIMED it and a commit message cannot be corrected in place. The
 * round-2 review caught the error; the number below was then re-measured by
 * replaying the five disarms against the HEAD~1 text guard:
 *
 *   - `compile-cache-bun-probe` (compile-cache-health-bun-ci): GREEN under all
 *     five.
 *   - `typecheck-root` (root-typecheck-gate): GREEN under FOUR — `"if": false`,
 *     `'if': false`, `needs: <skippable>`, and the zero-expansion `strategy:`.
 *     The PR body listed only the quoted key and `strategy:`. Its one catch was
 *     `continue-on-error: ${{ true }}`, and only by accident of breadth: that
 *     guard matched a bare `/continue-on-error/` rather than the
 *     `/continue-on-error:\s*true/` its siblings used. Understating a guard's
 *     blind spots is the same failure as overstating its coverage, so the
 *     measured figure lives in the tree rather than in a PR body.
 *
 * The mutations are applied to `.github/workflows/ci.yml` through the byte-
 * snapshot harness, so the workflow is restored content-addressed rather than by
 * replaying inverse edits, and every mutation carries the residue marker.
 *
 * Usage:  node scripts/mutation-prove-ci-blocking-gates.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declaredTestTitles,
  GATE_TEST_NAME,
  GATES,
  runGateTest as runGateTestIn,
} from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');

/**
 * A job that CAN skip, used for the `needs:` disarm.
 *
 * `docs-drift-reminder` carries `if: github.event_name == 'pull_request'`, so it
 * is skipped on a push — and a job that `needs:` a skipped job is itself
 * skipped, and a skipped job does not fail the run. That is the indirection the
 * text guards missed entirely: the gate disappears without its own definition
 * ever being touched.
 */
const SKIPPABLE_JOB = 'docs-drift-reminder';

/*
 * `GATE_TEST_NAME` and `GATES` now live in `./lib/ci-blocking-gate-proof.mjs`,
 * so `tests/ci-blocking-gate-proof-runnable.test.ts` can assert this proof is
 * still runnable without importing this script and running all 25 mutations.
 */

/**
 * The disarms. Each is a single valid-YAML edit that neutralises the job while
 * leaving its definition otherwise intact — four measured in #661, plus the two
 * the fail-closed allowlist caught that nobody had enumerated.
 */
const DISARMS = [
  { label: 'a quoted "if": false key', inject: '    "if": false' },
  { label: "a single-quoted 'if': false key", inject: "    'if': false" },
  {
    label: 'continue-on-error as an EXPRESSION, not a literal true',
    inject: '    continue-on-error: ${{ true }}',
  },
  { label: `needs: ${SKIPPABLE_JOB} (a job that can skip)`, inject: `    needs: ${SKIPPABLE_JOB}` },
  {
    label: 'a matrix strategy that can expand to zero jobs',
    inject: '    strategy:\n      matrix:\n        shard: []',
  },
];

let pass = 0;
let fail = 0;

const runGateTest = (spec) => runGateTestIn(REPO_ROOT, spec);

/**
 * Say WHY nothing ran, naming what was expected and what was found.
 *
 * The first version printed a bare `FATAL: <spec> has no test named "…"` for
 * both causes. It was the wrong one: the assertion had never been renamed, the
 * RUNNER had failed to start (`pnpm exec vitest` resolves nothing in a tree
 * without its own `node_modules`). A misattributed FATAL sends the next reader
 * looking for a rename that does not exist, which is how the proof stayed
 * offline for a whole PR.
 */
function explainNothingRan(spec, result) {
  if (!result.launched) {
    return [
      `FATAL: the test runner never started, so NOTHING was proved.`,
      `  runner: ${result.runner.command} ${result.runner.args.join(' ')}`,
      `  fix:    install dependencies in ${REPO_ROOT} (a git worktree has no node_modules of its own)`,
      `  output: ${result.out.trim().split('\n').slice(-3).join(' | ')}`,
    ].join('\n');
  }
  const titles = declaredTestTitles(readFileSync(resolve(REPO_ROOT, spec), 'utf8'));
  return [
    `FATAL: ${spec} declares no test whose name contains the one this proof selects.`,
    `  expected (substring): ${JSON.stringify(GATE_TEST_NAME)}`,
    `  found in ${spec}:`,
    ...titles.map((t) => `    - ${JSON.stringify(t)}`),
    `  fix: restore the name, or update GATE_TEST_NAME in scripts/lib/ci-blocking-gate-proof.mjs`,
  ].join('\n');
}

/** The assertion must be RED while the job is disarmed, and GREEN once restored. */
function prove(jobId, spec, disarm) {
  console.log(`── ${spec} :: ${jobId} :: ${disarm.label}`);
  const anchor = `  ${jobId}:\n`;
  const snap = snapshot(CI_YML);
  try {
    // The anchor is the job KEY, so the injection lands at job level whatever
    // the job's body looks like — no dependence on which line happens to be
    // first, which is how an anchored-on-a-neighbour mutation silently no-ops.
    mutate(snap, anchor, `${anchor}${disarm.inject}\n`);
    const result = runGateTest(spec);
    const { ok, ran } = result;
    if (ran === 0) {
      console.error(explainNothingRan(spec, result));
      restore(snap);
      process.exit(1);
    }
    if (ok) {
      console.log('   x DECORATION: the guard stayed GREEN with the gate disarmed');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
  } finally {
    restore(snap);
  }
  if (!runGateTest(spec).ok) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: every gate assertion must be GREEN against the real ci.yml.');
for (const { spec } of GATES) {
  const result = runGateTest(spec);
  const { ok, ran } = result;
  if (ran === 0) {
    console.error(explainNothingRan(spec, result));
    process.exit(1);
  }
  if (!ok) {
    console.error(`FATAL: ${spec} is not green to begin with`);
    process.exit(1);
  }
}
console.log('   ok baseline green\n');

for (const { jobId, spec } of GATES) {
  for (const disarm of DISARMS) prove(jobId, spec, disarm);
}

console.log(`\n${pass} disarm(s) went red as required, ${fail} stayed green.`);
process.exit(fail === 0 ? 0 : 1);
