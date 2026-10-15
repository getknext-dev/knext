#!/usr/bin/env node
/**
 * Mutation prover for #2321, TS half: the consumers of the operator's metric
 * golden (`packages/kn-next-operator/internal/metriccontract/operator-metrics.golden.json`).
 *
 * The golden is what the TS lane reads as "what the operator emits" (it has no
 * Go toolchain). The Go half — that the golden tracks what the binary actually
 * registers — is `mutation-prove-2321-go-metric-contract.mjs`. This half proves
 * the TS consumers BITE on the golden, by exit code:
 *
 *   T1  a family renamed in the golden: the alert, dashboard and doc naming the
 *       old series no longer resolve, so the metric contract reds — and so does
 *       alert reachability, which reads the same golden.
 *   T2  the `families` key broken: the parse fails closed (throws) rather than
 *       yielding an empty set that would make every consumer vacuous.
 *   N1  the negative control: the `$comment` text changes, nothing emitted
 *       does, and the contract stays GREEN.
 *
 * JSON has no comments, so each replacement embeds the residue marker inside
 * the `$comment` STRING (N1 proves that by itself reds nothing), and every
 * mutated golden is checked to still PARSE before it is graded — a red from
 * invalid JSON would be a red for the wrong reason.
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-2321-metric-golden-consumers.mjs
 */

import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const GOLDEN = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/metriccontract/operator-metrics.golden.json');
const CONTRACT_SPEC = 'packages/kn-next/src/__tests__/observability-metric-contract.test.ts';
const REACHABILITY_SPEC = 'packages/kn-next/src/__tests__/alert-reachability.test.ts';
const subjects = { golden: relative(REPO_ROOT, GOLDEN) };

/** Every mutated golden must still be valid JSON, or its red means nothing. */
const validate = (text) => {
  try {
    JSON.parse(text);
    return undefined;
  } catch (err) {
    return `golden is not valid JSON: ${err.message}`;
  }
};

const RENAME = {
  id: 'T1',
  expect: 'red',
  claim: 'a family is renamed in the golden (alerts/dashboards/docs still name the old series)',
  subject: 'golden',
  anchor:
    '/internal/metriccontract/",\n  "families": {\n    "knext_nextapp_image_prewarm_errors_total": "counter",',
  replacement: `/internal/metriccontract/ ${MUTATION_MARKER}",\n  "families": {\n    "knext_nextapp_image_prewarm_errors_renamed_total": "counter",`,
  validate,
};

const CONTRACT_ROWS = [
  RENAME,
  {
    id: 'T2',
    expect: 'red',
    claim: 'the families key is broken (the parse must throw, not yield an empty set)',
    subject: 'golden',
    anchor: '/internal/metriccontract/",\n  "families": {',
    replacement: `/internal/metriccontract/ ${MUTATION_MARKER}",\n  "familys": {`,
    validate,
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'only the $comment text changes; nothing emitted does',
    subject: 'golden',
    anchor: '/internal/metriccontract/",',
    replacement: `/internal/metriccontract/ ${MUTATION_MARKER}",`,
    validate,
  },
];
const REACHABILITY_ROWS = [{ ...RENAME, id: 'T1r' }];

// A real mutation of the real subject, so it also proves the runner reads it.
const CANARY = {
  subject: 'golden',
  anchor: '"knext_nextapp_reconcile_total": "counter"',
  replacement: `"knext_nextapp_reconcile_total": "untyped ${MUTATION_MARKER}"`,
};

const contract = createGuardProver({ repoRoot: REPO_ROOT, spec: CONTRACT_SPEC, subjects });
const reachability = createGuardProver({ repoRoot: REPO_ROOT, spec: REACHABILITY_SPEC, subjects });

console.log('=== mutation proof: the operator metric golden consumers (#2321) ===');
contract.preflight([...CONTRACT_ROWS, { id: 'canary', ...CANARY }]);
reachability.preflight(REACHABILITY_ROWS);
declareMutations(CONTRACT_ROWS.length + REACHABILITY_ROWS.length);

console.log(`\n=== ${CONTRACT_SPEC} ===`);
contract.baseline();
contract.proveCanSeeRed(CANARY);
for (const m of CONTRACT_ROWS) {
  contract.run(m);
  recordMutation();
}
contract.finish(CONTRACT_ROWS.length);

console.log(`\n=== ${REACHABILITY_SPEC} ===`);
reachability.baseline();
reachability.proveCanSeeRed(CANARY);
for (const m of REACHABILITY_ROWS) {
  reachability.run(m);
  recordMutation();
}
reachability.finish(REACHABILITY_ROWS.length);
