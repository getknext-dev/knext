#!/usr/bin/env node
/**
 * Mutation prover for #2321: the operator's metric golden is derived from the
 * Go AST of what the binary REGISTERS, not from source text.
 *
 * Each row plants one textual mutation (anchor EXACTLY ONCE in its subject, via
 * `lib/mutation-harness.mjs`, which marks residue and restores byte-identically)
 * and runs `go test ./internal/metriccontract/` in the operator module, graded
 * by EXIT CODE only:
 *
 *   G*  the operator's real metric sources. A rename, a dropped registration
 *       or an added one must RED (the golden is stale, or the live registry
 *       disagrees). A name in a comment, or a declared-but-unregistered var,
 *       must stay GREEN — those are not emitted, and a scan that counted them
 *       is the source-text bug #2321 removes (negative controls: the other half).
 *   X*  the #2377 review's evasions, on the real operator: a reassignment in
 *       init() before MustRegister, a local var shadow and a local const shadow
 *       each register a DIFFERENT name than the declaration the old by-name
 *       lookup read, and each is a *Vec with no children, so the live-registry
 *       cross-check cannot see it either. The scan must REFUSE them.
 *   S*  the scanner's own checks: remove one and its fixture test must red.
 *
 * NOT A JS TEST SUITE: the guards are Go tests, so there is no vitest runner to
 * resolve. Path-listed in `NON_JS_TEST_SUITE_PROVERS` (`lib/prover-lane.mjs`);
 * spawns only `go`, run in `packages/kn-next-operator`. Needs the Go toolchain
 * the operator's go.mod names; the nightly lane installs it. The TS consumers
 * of the golden are proved by `mutation-prove-2321-metric-golden-consumers.mjs`.
 *
 *   node scripts/mutation-prove-2321-go-metric-contract.mjs
 *
 * Exit 0 = every row behaved as required; 1 = a row did not (a guard is
 * decoration, or a negative control reddened); 2 = the prover itself could not
 * run (anchor drift, red baseline, missing tool). Never parses output.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the command's cwd), not a mutation subject: kept out of the
// `resolve(REPO_ROOT, …)` subject shape the anchor scanners read.
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;
const CONTROLLER = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/metrics.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const WEBHOOK = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/webhook/v1alpha1/budget_fallback_metric.go');
const SCANNER = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/metriccontract/scan.go');

// -count=1: the golden test reads files outside the package; never trust a cache.
const GO_TEST = ['go', 'test', '-count=1', './internal/metriccontract/'];

const MUTATIONS = [
  // ── G: the operator's real metric sources ─────────────────────────────────
  {
    id: 'G1',
    expect: 'red',
    claim: 'a controller metric is renamed',
    subject: 'controller',
    anchor: 'Name: "knext_nextapp_reconcile_total",',
    replacement: 'Name: "knext_nextapp_reconciles_renamed_total",',
  },
  {
    id: 'G2',
    expect: 'red',
    claim: 'the webhook metric is renamed',
    subject: 'webhook',
    anchor: 'Name: "knext_platform_budget_fallback_total",',
    replacement: 'Name: "knext_platform_budget_fallback_renamed_total",',
  },
  {
    id: 'G3',
    expect: 'red',
    claim: 'a controller metric is dropped from MustRegister (declared, still used, never served)',
    subject: 'controller',
    anchor: 'MustRegister(reconcileTotal, reconcileDuration, reconcileErrors, imagePrewarmErrors,',
    replacement: 'MustRegister(reconcileTotal, reconcileDuration, imagePrewarmErrors,',
  },
  {
    id: 'G4',
    expect: 'red',
    claim: 'the webhook metric is never registered (the import kept alive by a type use)',
    subject: 'webhook',
    anchor: '\tmetrics.Registry.MustRegister(budgetFallbackTotal)\n',
    replacement: '\tvar _ metrics.RegistererGatherer\n',
  },
  {
    id: 'G5',
    expect: 'red',
    claim: 'a new metric is registered inline',
    subject: 'webhook',
    anchor: '\tmetrics.Registry.MustRegister(budgetFallbackTotal)\n',
    replacement:
      '\tmetrics.Registry.MustRegister(budgetFallbackTotal, prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_platform_ghost_total"}))\n',
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'a registration in a COMMENT is not emitted, so the golden does not change',
    subject: 'webhook',
    anchor: 'func init() {',
    replacement:
      'func init() {\n\t// metrics.Registry.MustRegister(prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_platform_ghost_total"}))',
  },
  {
    id: 'N2',
    expect: 'green',
    claim:
      'a declared but never registered collector is not emitted, so the golden does not change',
    subject: 'webhook',
    anchor: 'var budgetFallbackTotal = prometheus.NewCounterVec(',
    replacement:
      'var ghostFallbackTotal = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_platform_ghost_total"})\n\nvar budgetFallbackTotal = prometheus.NewCounterVec(',
  },
  // ── X: the #2377 review's evasions, each a childless *Vec ─────────────────
  {
    id: 'X1',
    expect: 'red',
    claim: 'the package var is REASSIGNED in init() before MustRegister (registers the decoy)',
    subject: 'controller',
    anchor: '\tmetrics.Registry.MustRegister(reconcileTotal, reconcileDuration,',
    replacement:
      '\treconcileTotal = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "knext_nextapp_reconciles_renamed_total"}, []string{"result"})\n\tmetrics.Registry.MustRegister(reconcileTotal, reconcileDuration,',
  },
  {
    id: 'X2',
    expect: 'red',
    claim: 'a LOCAL var shadows the package var in init() (registers the decoy)',
    subject: 'controller',
    anchor: '\tmetrics.Registry.MustRegister(reconcileTotal, reconcileDuration,',
    replacement:
      '\treconcileTotal := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "knext_nextapp_reconciles_renamed_total"}, []string{"result"})\n\tmetrics.Registry.MustRegister(reconcileTotal, reconcileDuration,',
  },
  {
    id: 'X3',
    expect: 'red',
    claim:
      'a LOCAL const shadows the package const an inline collector is named by (registers the decoy)',
    subject: 'controller',
    // The package const holds the golden's name, so the old by-name lookup read
    // a matching name while the local one is what registers.
    anchor:
      "func init() {\n\t// Register with controller-runtime's global registry so the series are served on\n\t// the existing /metrics endpoint alongside the built-in controller metrics.\n\tmetrics.Registry.MustRegister(reconcileTotal, reconcileDuration,",
    replacement:
      'const reconcileTotalName = "knext_nextapp_reconcile_total"\n\nfunc init() {\n\tconst reconcileTotalName = "knext_nextapp_reconciles_renamed_total"\n\tmetrics.Registry.MustRegister(prometheus.NewCounterVec(prometheus.CounterOpts{Name: reconcileTotalName}, []string{"result"}), reconcileDuration,',
  },
  // ── S: the scanner's own checks, each guarded by its fixture test ─────────
  {
    id: 'S1',
    expect: 'red',
    claim: 'the scanner stops refusing a collector that resolves to a local declaration',
    subject: 'scanner',
    anchor: '\t\tif obj.Parent() != p.scope {\n',
    replacement: '\t\tif false {\n',
  },
  {
    id: 'S2',
    expect: 'red',
    claim: 'the scanner stops refusing a package var assigned besides its declaration',
    subject: 'scanner',
    anchor: 'if at, re := p.assigned[v]; re {',
    replacement: 'if at, re := p.assigned[v]; re && at < 0 {',
  },
  {
    id: 'S3',
    expect: 'red',
    claim: 'the scanner stops refusing a name built from a LOCAL constant',
    subject: 'scanner',
    anchor: 'if obj != nil && obj.Parent() != p.scope && obj.Parent() != types.Universe {',
    replacement:
      'if obj != nil && obj.Parent() != p.scope && obj.Parent() != types.Universe && false {',
  },
  {
    id: 'S4',
    expect: 'red',
    claim: 'the scanner stops treating an address-taken var as assigned',
    subject: 'scanner',
    anchor: '\t\t\t\t\tmark(n.X) // a pointer to the var can reassign it\n',
    replacement: '\t\t\t\t\t_ = n.X\n',
  },
  {
    id: 'S5',
    expect: 'red',
    claim: 'the scanner scans only linux/amd64 (an arm64-only registration goes unseen)',
    subject: 'scanner',
    anchor: 'var ShippedArchs = []string{"amd64", "arm64"}',
    replacement: 'var ShippedArchs = []string{"amd64"}',
  },
  {
    id: 'S6',
    expect: 'red',
    claim: 'the scanner stops refusing a shadowed metrics package name',
    subject: 'scanner',
    anchor: 'if _, isPkg := p.info.Uses[x].(*types.PkgName); !isPkg {',
    replacement: 'if _, isPkg := p.info.Uses[x].(*types.PkgName); !isPkg && false {',
  },
];

const SUBJECTS = { controller: CONTROLLER, webhook: WEBHOOK, scanner: SCANNER };

function goTestExit() {
  const [bin, ...args] = GO_TEST;
  const r = spawnSync(bin, args, {
    cwd: OPERATOR_MODULE,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 600_000,
  });
  if (r.error || r.status === null) {
    console.error(
      `mutation-prove-2321-go-metric-contract: cannot run ${bin}: ${r.error?.message ?? r.signal}`,
    );
    process.exit(2);
  }
  return r.status;
}

declareMutations(MUTATIONS.length);
console.log(`mutation-prove-2321-go-metric-contract: ${MUTATIONS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of MUTATIONS) {
  const path = SUBJECTS[m.subject];
  if (path === undefined) {
    console.error(`mutation-prove-2321-go-metric-contract: ${m.id} names no subject ${m.subject}`);
    process.exit(2);
  }
  const count = snapshot(path).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `mutation-prove-2321-go-metric-contract: ${m.id}'s anchor occurs ${count} times in ${path}; aborting`,
    );
    process.exit(2);
  }
}

// Green baseline on a clean tree, else every verdict below is noise.
assertTreeClean(REPO_ROOT, 'baseline');
const base = goTestExit();
if (base !== 0) {
  console.error(
    `mutation-prove-2321-go-metric-contract: baseline RED (exit ${base}); fix the tree first`,
  );
  process.exit(2);
}
console.log('mutation-prove-2321-go-metric-contract: baseline green');

let failed = 0;
for (const m of MUTATIONS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(SUBJECTS[m.subject]);
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    code = goTestExit();
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  recordMutation();
  const ok = m.expect === 'red' ? code !== 0 : code === 0;
  if (!ok) failed++;
  const verdict = ok ? (m.expect === 'red' ? 'KILLED   ' : 'TOLERATED') : '*** SURVIVED ***';
  console.log(`${verdict} ${m.id} expect=${m.expect} exit=${code} — ${m.claim}`);
}

console.log(
  `mutation-prove-2321-go-metric-contract: ${MUTATIONS.length - failed}/${MUTATIONS.length} behaved as required`,
);
process.exit(failed === 0 ? 0 : 1);
