#!/usr/bin/env node
/**
 * Mutation proof for #1645's cancelled-aware alert-condition guard:
 *   - `tests/nightly-alert-cancelled-condition.test.ts` — every scheduled
 *     workflow's alert-shaped `if:` checks `needs.<X>.result == 'cancelled'`
 *     alongside `== 'failure'` for the same upstream job.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Round 2 (#1647 review) added the other half: the same spec also scans for
 * a missing `always()` guard, since a job can carry the fixed disjunction
 * and still never run at all without one (GitHub Actions' implicit
 * `success() &&`). Two more subject classes below cover that half.
 *
 * Four subject classes:
 *   1. the 9 real workflow files #1645 fixed — revert each alert job's
 *      condition to its pre-fix, failure-only form and confirm the SCAN
 *      test goes red;
 *   2. the spec's own cancelled-check detection logic — weaken
 *      `FAILURE_RESULT_RE`, `checksCancelledFor`, or the frozen-file
 *      allowlist filter and confirm the spec's own non-vacuity/allowlist
 *      assertions catch it;
 *   3. two real jobs with `always()` stripped but the disjunction intact —
 *      the review's live repro (`mutation-prover-nightly.yml`'s
 *      `nightly-red-alert`) and the sibling gap it flagged as uncovered
 *      anywhere else (`action-pin-resolution-nightly.yml`'s
 *      `crane-pin-red-alert`);
 *   4. the spec's own always()-guard detection logic — weaken `ALWAYS_RE`,
 *      `hasAlwaysGuard`, or `NEEDS_RESULT_RE` and confirm the spec's own
 *      non-vacuity assertions for that half catch it.
 *
 * Usage:  node scripts/mutation-prove-nightly-alert-cancelled.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SPEC = 'tests/nightly-alert-cancelled-condition.test.ts';

const PROOF = {
  subjects: {
    spec: SPEC,
    actionPinWorkflow: '.github/workflows/action-pin-resolution-nightly.yml',
    anonymousInstallWorkflow: '.github/workflows/anonymous-install-nightly.yml',
    shippedPinWorkflow: '.github/workflows/compat-shipped-pin-early-warning.yml',
    docsClosureWorkflow: '.github/workflows/docs-closure-nightly.yml',
    imagePinWorkflow: '.github/workflows/image-pin-resolution-nightly.yml',
    mutationProverWorkflow: '.github/workflows/mutation-prover-nightly.yml',
    retractedFigureWorkflow: '.github/workflows/retracted-figure-resolution-nightly.yml',
    scaffoldInstallWorkflow: '.github/workflows/scaffold-install-nightly.yml',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  // ── Real workflow regressions — the exact #1645 bug, reintroduced one file
  // at a time. Each anchors on the fixed `(… || … cancelled)` disjunction and
  // reverts it to the bare failure-only check the nightlies shipped with.
  {
    label:
      "action-pin-resolution-nightly.yml: drop 'cancelled' from nightly-red-alert (reintroduce #1645)",
    subject: 'actionPinWorkflow',
    anchor:
      "(needs.resolve-action-pins.result == 'failure' || needs.resolve-action-pins.result == 'cancelled')",
    replacement: "needs.resolve-action-pins.result == 'failure'",
  },
  {
    label:
      "action-pin-resolution-nightly.yml: drop 'cancelled' from crane-pin-red-alert (reintroduce #1645)",
    subject: 'actionPinWorkflow',
    anchor:
      "(needs.verify-crane-pin.result == 'failure' || needs.verify-crane-pin.result == 'cancelled')",
    replacement: "needs.verify-crane-pin.result == 'failure'",
  },
  {
    label:
      "anonymous-install-nightly.yml: drop 'cancelled' from nightly-red-alert (reintroduce #1645)",
    subject: 'anonymousInstallWorkflow',
    anchor:
      "(needs.anonymous-install.result == 'failure' || needs.anonymous-install.result == 'cancelled')",
    replacement: "needs.anonymous-install.result == 'failure'",
  },
  {
    label:
      "compat-shipped-pin-early-warning.yml: drop 'cancelled' from alert (reintroduce #1645, the bug this file's own comment predicted)",
    subject: 'shippedPinWorkflow',
    anchor:
      "(needs.dispatch-and-wait.result == 'failure' || needs.dispatch-and-wait.result == 'cancelled')",
    replacement: "needs.dispatch-and-wait.result == 'failure'",
  },
  {
    label: "docs-closure-nightly.yml: drop 'cancelled' from nightly-red-alert (reintroduce #1645)",
    subject: 'docsClosureWorkflow',
    anchor:
      "(needs.docs-closure-scan.result == 'failure' || needs.docs-closure-scan.result == 'cancelled')",
    replacement: "needs.docs-closure-scan.result == 'failure'",
  },
  {
    label:
      "image-pin-resolution-nightly.yml: drop 'cancelled' from nightly-red-alert (reintroduce #1645)",
    subject: 'imagePinWorkflow',
    anchor:
      "(needs.resolve-image-pins.result == 'failure' || needs.resolve-image-pins.result == 'cancelled')",
    replacement: "needs.resolve-image-pins.result == 'failure'",
  },
  {
    // The literal regression that caused the 2026-09-28/09-29 silent misses.
    label:
      "mutation-prover-nightly.yml: drop 'cancelled' from nightly-red-alert (reintroduce #1645)",
    subject: 'mutationProverWorkflow',
    anchor:
      "(needs.run-mutation-provers.result == 'failure' || needs.run-mutation-provers.result == 'cancelled')",
    replacement: "needs.run-mutation-provers.result == 'failure'",
  },
  {
    label:
      "retracted-figure-resolution-nightly.yml: drop 'cancelled' from nightly-red-alert (reintroduce #1645)",
    subject: 'retractedFigureWorkflow',
    anchor:
      "(needs.resolve-retracted-figures.result == 'failure' || needs.resolve-retracted-figures.result == 'cancelled')",
    replacement: "needs.resolve-retracted-figures.result == 'failure'",
  },
  {
    label:
      "scaffold-install-nightly.yml: drop 'cancelled' from nightly-red-alert (reintroduce #1645)",
    subject: 'scaffoldInstallWorkflow',
    anchor:
      "(needs.scaffold-install.result == 'failure' || needs.scaffold-install.result == 'cancelled')",
    replacement: "needs.scaffold-install.result == 'failure'",
  },
  // ── Round 2 (#1647 review): drop `always()` while leaving the fixed
  // `(failure || cancelled)` disjunction intact — the OTHER half of #1645.
  // Without `always()`, GitHub Actions prepends an implicit `success() &&`
  // and the disjunction never gets evaluated on a failed/cancelled upstream.
  // Verified live against these exact two jobs before this round landed:
  // the review's own repro on mutation-prover-nightly.yml, and the sibling
  // gap on crane-pin-red-alert the review flagged as uncovered anywhere else.
  {
    label:
      "mutation-prover-nightly.yml: drop always() from nightly-red-alert's if: (reintroduce the implicit success() gate)",
    subject: 'mutationProverWorkflow',
    anchor:
      "    if: >-\n      always() &&\n      github.event_name == 'schedule' &&\n      (needs.run-mutation-provers.result == 'failure' || needs.run-mutation-provers.result == 'cancelled')",
    replacement:
      "    if: >-\n      github.event_name == 'schedule' &&\n      (needs.run-mutation-provers.result == 'failure' || needs.run-mutation-provers.result == 'cancelled')",
  },
  {
    label:
      "action-pin-resolution-nightly.yml: drop always() from crane-pin-red-alert's if: (reintroduce the implicit success() gate)",
    subject: 'actionPinWorkflow',
    anchor:
      "always() &&\n      github.event_name == 'schedule' &&\n      (needs.verify-crane-pin.result == 'failure' || needs.verify-crane-pin.result == 'cancelled')",
    replacement:
      "github.event_name == 'schedule' &&\n      (needs.verify-crane-pin.result == 'failure' || needs.verify-crane-pin.result == 'cancelled')",
  },
  // ── The spec's own always()-guard detection logic.
  {
    label: 'ALWAYS_RE: defang the always() detector so it matches nothing',
    subject: 'spec',
    anchor: 'const ALWAYS_RE = /\\balways\\(\\)/;',
    replacement: 'const ALWAYS_RE = /$^/;',
  },
  {
    label: 'hasAlwaysGuard: always report the always() guard as present (vacuous pass)',
    subject: 'spec',
    anchor: 'function hasAlwaysGuard(ifStr: string): boolean {\n  return ALWAYS_RE.test(ifStr);\n}',
    replacement: 'function hasAlwaysGuard(_ifStr: string): boolean {\n  return true;\n}',
  },
  {
    // Every alert-shaped-job detector: defang it so no job is ever recognised
    // as alert-shaped, and every genuinely-missing-always() job silently
    // stops being flagged.
    label: 'NEEDS_RESULT_RE: defang the alert-shaped-job detector so it matches nothing',
    subject: 'spec',
    anchor: 'const NEEDS_RESULT_RE = /needs\\.[\\w-]+\\.result/;',
    replacement: 'const NEEDS_RESULT_RE = /$^/;',
  },
  // ── The spec's own detection logic.
  {
    label: 'FAILURE_RESULT_RE: defang the failure-check detector so it matches nothing',
    subject: 'spec',
    anchor: "const FAILURE_RESULT_RE = /needs\\.([\\w-]+)\\.result\\s*==\\s*'failure'/g;",
    replacement: 'const FAILURE_RESULT_RE = /$^/g;',
  },
  {
    label: 'checksCancelledFor: always report the cancelled check as present (vacuous pass)',
    subject: 'spec',
    anchor:
      "function checksCancelledFor(ifStr: string, needsJob: string): boolean {\n  const re = new RegExp(`needs\\\\.${escapeForRegExp(needsJob)}\\\\.result\\\\s*==\\\\s*'cancelled'`);\n  return re.test(ifStr);\n}",
    replacement:
      'function checksCancelledFor(_ifStr: string, _needsJob: string): boolean {\n  return true;\n}',
  },
  {
    // Scan every workflow, allowlist included — the frozen files' own
    // build-next leg genuinely still lacks the cancelled check today, so
    // this must flip the main scan test to red.
    label: 'scanNonFrozen: stop excluding the frozen-file allowlist',
    subject: 'spec',
    anchor: '.filter((file) => !ALLOWLIST.has(file))',
    replacement: '.filter((_file) => true)',
  },
];

declareMutations(17);

if (MUTATIONS.length !== 17) {
  console.error(`FATAL: declared 17 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
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
