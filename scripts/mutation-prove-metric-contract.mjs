#!/usr/bin/env node
/**
 * Mutation proof for #908's app metric contract (sprint 2, lane G — G4).
 *
 * WHAT #908 CLAIMED, AND WHY IT NEEDS PROVING
 * -------------------------------------------
 * #908 made the observability contract REAL and gated it: the shipped runtime
 * emits an SLO-computable RED set, every alert queries a series something
 * actually emits, every dashboard panel likewise, and every checked-in copy of
 * the contract carries the same metric set.
 *
 * The last of those is the one that decides whether the rest mean anything. The
 * two `.hbs` trees are pinned byte-identical elsewhere, but the three `.mjs`
 * copies are not — and `examples/bun-exec`'s copy is the one the container e2e
 * actually BOOTS. A metric added to the template and forgotten in the example
 * leaves the gate green while the binary under test emits the old set, which is
 * the whole reason the copies are compared rather than trusted.
 *
 * Every failure here is silent by construction. An alert that queries a series
 * nobody emits does not error — it just never fires, and an alert that never
 * fires is indistinguishable from a healthy system right up until it isn't. #908
 * asserted 8/8 in prose and committed no prover.
 *
 * WHY THESE FIVE, AND WHY NOT THE TEMPLATES. Every mutation below targets the
 * OPERATOR's rules/dashboards, the `examples/bun-exec` reality-binding copy, or
 * the scanner in `metric-contract.ts`. The `.hbs` templates are deliberately
 * untouched: sibling work in this sprint owns those files, and a prover whose
 * anchors sit in another team's diff is a prover that will be inert by Monday —
 * which is #912's whole subject.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/observability-metric-contract.test.ts';

/** A rule file that stopped parsing would red for the wrong reason. */
const yamlStillParses = (text) => {
  try {
    parseYaml(text);
    return undefined;
  } catch (err) {
    return `the mutated PrometheusRule is not valid YAML: ${err.message}`;
  }
};

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'an ALERT queries a series nothing emits — it never fires, and an alert that never fires ' +
      'looks exactly like a healthy system',
    subject: 'rules',
    validate: yamlStillParses,
    anchor: 'sum(rate(knext_bunexec_http_requests_total{status_class="5xx"}[5m])) by (app)',
    replacement: 'sum(rate(knext_bunexec_http_5xx_total{status_class="5xx"}[5m])) by (app)',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the reality-binding copy DRIFTS — examples/bun-exec is what the container e2e boots, so ' +
      'the binary under test would emit a set the gate never checked',
    subject: 'exampleContract',
    anchor: "'# TYPE knext_bunexec_startup_duration_seconds gauge',",
    replacement: "'# TYPE knext_bunexec_cold_start_seconds gauge',",
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the emitted-metric SCANNER matches nothing — every "is this series emitted" check then ' +
      'compares against an empty set, and an empty set is not a green one',
    subject: 'scanner',
    anchor:
      '        /#\\s*TYPE\\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\\s+(counter|gauge|histogram|summary|untyped)\\b/g,',
    replacement:
      '        /#\\s*TYPEX\\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\\s+(counter|gauge|histogram|summary|untyped)\\b/g,',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the duration histogram loses its sub-100ms buckets — cold starts are measured in tens of ' +
      'ms, so the cold-start SLO becomes uncomputable while the metric still exists',
    subject: 'exampleContract',
    anchor: 'const REQUEST_DURATION_BUCKETS = [',
    replacement: 'const REQUEST_DURATION_BUCKETS = [0.5, 1, 2, 5]; const _OLD_BUCKETS = [',
  },
];

/**
 * NEGATIVE CONTROL. An alert's `annotations.description` is operator-facing prose
 * with no query in it. Rewording it must leave the guard GREEN.
 *
 * This is what separates "every alert queries a real series" from "the rule file
 * is frozen". Alert copy is edited constantly — runbook links, severity wording —
 * and a guard that reddened on it would be the first one disabled.
 */
const NEGATIVE = {
  id: 'M5',
  expect: 'green',
  claim: 'an alert DESCRIPTION is reworded — the guard checks queries, not prose',
  subject: 'rules',
  validate: yamlStillParses,
  anchor: 'description: "Reconcile p95 is {{ $value | humanizeDuration }} (>30s)."',
  replacement:
    'description: "Reconcile p95 is {{ $value | humanizeDuration }} (>30s). Reworded by the negative control."',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    rules: 'packages/kn-next-operator/config/observability/prometheusrule.yaml',
    exampleContract: 'examples/bun-exec/runtime-contract.mjs',
    scanner: 'packages/kn-next/src/adapters/metric-contract.ts',
  },
});

console.log(`=== mutation proof: ${SPEC} (#908 metric contract) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary renames the request counter in the reality-binding copy. If the
// guard cannot see the copy the e2e actually boots diverge from the contract,
// nothing below is worth reading.
prover.proveCanSeeRed({
  subject: 'exampleContract',
  anchor: "'# TYPE knext_bunexec_startup_duration_seconds gauge',",
  replacement: "'# TYPE knext_bunexec_canary_duration_seconds gauge',",
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
