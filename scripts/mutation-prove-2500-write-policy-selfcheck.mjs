#!/usr/bin/env node
/**
 * Mutation proof for the operator write-policy self-check (issue #2500): the
 * operator's read-only check that the ValidatingAdmissionPolicy limiting its
 * Secret/ConfigMap writes is actually in force, the 0/1 gauge it publishes, the
 * alert on a 0, the read-only RBAC it needs, the kustomize wiring that gives it
 * the rendered policy name, and `knext doctor`'s mirror of the same verdict.
 *
 * Every row breaks ONE rule and must turn its guard red:
 *   - the verdict: each way the policy can be off (deleted, binding deleted,
 *     binding that does not Deny, a username that is not the operator's, a policy
 *     that fails open or skips a verb or a resource, a binding scoped to some
 *     namespaces), and the headline row, "the check is forced to true", which
 *     must red the deleted-policy case on a real apiserver;
 *   - the gauge: published as 0 when off, one warning per change, run on every
 *     replica, re-checked on an interval, a failed read reported as not enforced;
 *   - the RBAC: `get` only, by name, on the two kinds, in a dedicated role;
 *   - the wiring: the operator's WRITE_POLICY_NAME and the role's resourceNames
 *     follow the policy's prefixed name, and main registers the monitor;
 *
 * The alert rule and `knext doctor`'s mirror of the verdict are the TS half:
 * mutation-prove-2500-write-policy-ts.mjs.
 *
 * Graded by `go test` in packages/kn-next-operator (the envtest proof needs
 * envtest binaries: KUBEBUILDER_ASSETS or bin/k8s; the bundle rows need
 * kustomize: KUSTOMIZE or bin/kustomize or PATH). Each row is BUILD-CHECKED
 * first (the mutant must compile its tests), so a row can only count as killed
 * by a failing assertion, never by a compile error. Exit 0 = every row went red; 1 = a row survived; 2 = the
 * prover could not run (anchor drift, red baseline, an unbuildable mutant,
 * missing tool). Never parses output.
 *
 * Usage:
 *   node scripts/mutation-prove-2500-write-policy-selfcheck.mjs
 *   MUTATION_ONLY=V01,K01 node scripts/mutation-prove-2500-write-policy-selfcheck.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const NAME = 'mutation-prove-2500-write-policy-selfcheck';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;

/** A subject's repo-relative path, made absolute. The map below holds literals so the prover-lane anchor audit can read it. */
const subjectPath = (key) => {
  const rel = PROVER.subjects[key];
  return rel === undefined ? undefined : resolve(REPO_ROOT, rel);
};

const PROVER = {
  subjects: {
    verdict: 'packages/kn-next-operator/internal/writepolicy/verdict.go',
    monitor: 'packages/kn-next-operator/internal/writepolicy/monitor.go',
    source: 'packages/kn-next-operator/internal/writepolicy/source.go',
    main: 'packages/kn-next-operator/cmd/main.go',
    role: 'packages/kn-next-operator/config/rbac/write_policy_reader_role.yaml',
    rbacKust: 'packages/kn-next-operator/config/rbac/kustomization.yaml',
    defaultKust: 'packages/kn-next-operator/config/default/kustomization.yaml',
    manager: 'packages/kn-next-operator/config/manager/manager.yaml',
  },
};

const WP = './internal/writepolicy/';
const CTRL = './internal/controller/';
const INSTALL = './internal/install/';
const CMD = './cmd/';

/** A `go test -run <run> <pkg>` guard. */
const unit = (run, pkg) => ({ kind: 'go', args: ['-run', run, pkg] });
/** The verdict table and the monitor, no cluster. */
const VERDICT = unit('TestEvaluateMatchesTheSharedVerdictTable', WP);
const MONITOR = unit(
  'TestGaugeIsOneWhenThePolicyIsEnforced|TestGaugeIsZeroAndOneWarningIsLoggedWhenNotEnforced|TestWarningFollowsTheStateAcrossRecoveryAndRegression|TestMonitorRunsOnEveryReplicaAndRechecksOnAnInterval',
  WP,
);
/** The self-check against a real kube-apiserver (deleted policy, deleted binding, wrong username, audit-only, the shipped role). */
const APISERVER = unit('TestSelfCheckAgainstARealApiserver', WP);
/** The RBAC scans: the grant is exactly get-by-name, and no shipped rule writes the policy kinds. */
const RBAC = unit(
  'TestWritePolicyReaderRoleIsExactlyGetOnTheTwoNamedObjects|TestOperatorCannotEditItsOwnWritePolicy',
  CTRL,
);
/** main registers the monitor, with the configured name, on every replica. */
const WIRING = unit(
  'TestAddWritePolicyMonitorRegistersAnEveryReplicaMonitor|TestWritePolicyNameComesFromTheRenderedEnvironment|TestMainRegistersTheWritePolicyMonitor',
  CMD,
);
/** The rendered bundle: re-render dist/install.yaml, then the install tests that read it. */
const BUNDLE = { kind: 'bundle' };
const MUTATIONS = [
  // --- the verdict ------------------------------------------------------------
  {
    id: 'V01',
    claim: 'the check is forced to true: a deleted policy is reported as enforced',
    subject: 'monitor',
    // The deleted-policy case has to be read off a real apiserver to count.
    anchor: '	return Evaluate(policy, binding, username)\n}',
    replacement:
      '	_ = Evaluate(policy, binding, username)\n	return Verdict{Enforced: true, Reason: ReasonEnforced}\n}',
    test: APISERVER,
  },
  {
    id: 'V02',
    claim: 'a binding that only audits is accepted (the Deny test is skipped)',
    subject: 'verdict',
    anchor: '	if !deny {',
    replacement: '	if false && !deny {',
    test: VERDICT,
  },
  {
    id: 'V03',
    claim: "the username the policy confines is not compared with the operator's",
    subject: 'verdict',
    anchor: '	if confined != operatorUsername {',
    replacement: '	if false && confined != operatorUsername {',
    test: VERDICT,
  },
  {
    id: 'V04',
    claim: 'a binding for another policy is accepted',
    subject: 'verdict',
    anchor: '	if binding.Spec.PolicyName != policy.Name {',
    replacement: '	if false && binding.Spec.PolicyName != policy.Name {',
    test: VERDICT,
  },
  {
    id: 'V05',
    claim: 'a missing binding is not noticed',
    subject: 'verdict',
    anchor: '	if binding == nil {',
    replacement: '	if binding == nil && false {',
    test: VERDICT,
  },
  {
    id: 'V06',
    claim: 'a policy that fails open (failurePolicy Ignore) is accepted',
    subject: 'verdict',
    anchor: 'fp != nil && *fp == admissionregistrationv1.Ignore {',
    replacement: 'fp != nil && *fp == "never" {',
    test: VERDICT,
  },
  {
    id: 'V07',
    claim: 'a policy that skips an operation or a resource is accepted',
    subject: 'verdict',
    anchor: '			if !found {',
    replacement: '			if false && !found {',
    test: VERDICT,
  },
  {
    id: 'V08',
    claim: 'a binding scoped to some namespaces is accepted (a selector never narrows)',
    subject: 'verdict',
    anchor: '	return s != nil && (len(s.MatchLabels) > 0 || len(s.MatchExpressions) > 0)',
    replacement: '	return false',
    test: VERDICT,
  },
  {
    id: 'V09',
    claim: 'a matchCondition that is not a plain equality (startsWith, !=) is read as an identity',
    subject: 'verdict',
    anchor: 'var identityExpr = regexp.MustCompile(`^\\s*request\\.userInfo\\.username\\s*==\\s*(',
    replacement: 'var identityExpr = regexp.MustCompile(`request\\.userInfo\\.username.*?(',
    test: VERDICT,
  },
  {
    id: 'V10',
    claim: 'a read that fails (RBAC, transport) is reported as enforced',
    subject: 'monitor',
    anchor:
      '		return no(ReasonUnverifiable, "reading ValidatingAdmissionPolicy %q failed: %v", name, err)',
    replacement: '		return Verdict{Enforced: true, Reason: ReasonEnforced}',
    test: MONITOR,
  },
  // --- the gauge and the monitor ----------------------------------------------
  {
    id: 'G01',
    claim: 'the gauge is published as 1 when the policy is off',
    subject: 'monitor',
    anchor: '	} else {\n		enforcedGauge.Set(0)',
    replacement: '	} else {\n		enforcedGauge.Set(1)',
    test: MONITOR,
  },
  {
    id: 'G02',
    claim: 'a warning is logged on every check, not once per change',
    subject: 'monitor',
    anchor:
      '	changed := m.last == nil || m.last.Enforced != v.Enforced || m.last.Reason != v.Reason',
    replacement: '	changed := true',
    test: MONITOR,
  },
  {
    id: 'G03',
    claim: 'the monitor needs leader election, so a standby replica reports nothing',
    subject: 'monitor',
    anchor: 'func (m *Monitor) NeedLeaderElection() bool { return false }',
    replacement: 'func (m *Monitor) NeedLeaderElection() bool { return true }',
    test: MONITOR,
  },
  {
    id: 'G04',
    claim: 'the check runs once at start-up and never again, so a later deletion goes unseen',
    subject: 'monitor',
    anchor: '		case <-t.C:\n			m.CheckOnce(ctx)',
    replacement: '		case <-t.C:',
    test: MONITOR,
  },
  {
    id: 'G05',
    claim: "the operator's identity is not the one the apiserver reports",
    subject: 'source',
    anchor: '	return r.Status.UserInfo.Username, nil',
    replacement: '	_ = r\n	return "", nil',
    test: APISERVER,
  },
  {
    id: 'G06',
    claim: 'a deleted policy surfaces as a read error instead of "missing"',
    subject: 'source',
    anchor: '	if apierrors.IsNotFound(err) {\n		return nil, nil\n	}\n	return p, err',
    replacement: '	return p, err',
    test: APISERVER,
  },
  // --- main -------------------------------------------------------------------
  {
    id: 'M01',
    claim: 'main never registers the monitor',
    subject: 'main',
    anchor:
      '	if err := addWritePolicyMonitor(mgr.Add, mgr.GetConfig(), writePolicyName, writePolicyCheckInterval); err != nil {',
    replacement: '	if err := error(nil); err != nil {',
    test: WIRING,
  },
  {
    id: 'M02',
    claim: 'the monitor checks a fixed policy name, not the configured one',
    subject: 'main',
    anchor: '		Name:     name,',
    replacement: '		Name:     defaultWritePolicyName,',
    test: WIRING,
  },
  // --- the RBAC ---------------------------------------------------------------
  {
    id: 'R01',
    claim: 'the role also lists admission policies (every policy in the cluster becomes visible)',
    subject: 'role',
    anchor: '  verbs:\n  - get\n',
    replacement: '  verbs:\n  - get\n  - list\n',
    test: RBAC,
  },
  {
    id: 'R02',
    claim: "the role is no longer limited to the shipped policy's name",
    subject: 'role',
    anchor: '  resourceNames:\n  - secret-configmap-writes\n',
    replacement: '',
    test: RBAC,
  },
  {
    id: 'R03',
    claim: 'the role lets the operator edit its own write policy',
    subject: 'role',
    anchor: '  verbs:\n  - get\n',
    replacement: '  verbs:\n  - get\n  - update\n',
    test: RBAC,
  },
  {
    id: 'R04',
    claim: 'the role no longer lets the check read the objects (forbidden on a real apiserver)',
    subject: 'role',
    anchor: '  - validatingadmissionpolicybindings\n',
    replacement: '',
    test: APISERVER,
  },
  {
    id: 'R05',
    claim: 'the role is dropped from the bundle',
    subject: 'rbacKust',
    anchor: '- write_policy_reader_role.yaml\n',
    replacement: '',
    test: BUNDLE,
  },
  // --- the kustomize wiring ---------------------------------------------------
  {
    id: 'K01',
    claim:
      'WRITE_POLICY_NAME keeps the base name in a prefixed install (the check reads an object that is not there)',
    subject: 'defaultKust',
    anchor:
      '      kind: Deployment\n      name: controller-manager\n    fieldPaths:\n    - .spec.template.spec.containers.[name=manager].env.[name=WRITE_POLICY_NAME].value',
    replacement:
      '      kind: Deployment\n      name: no-such-deployment\n    fieldPaths:\n    - .spec.template.spec.containers.[name=manager].env.[name=WRITE_POLICY_NAME].value',
    test: BUNDLE,
  },
  {
    id: 'K02',
    claim:
      "the role's resourceNames keep the base name in a prefixed install (the check is forbidden from reading the policy)",
    subject: 'defaultKust',
    anchor:
      '      kind: ClusterRole\n      name: write-policy-reader\n    fieldPaths:\n    - .rules.0.resourceNames.0',
    replacement:
      '      kind: ClusterRole\n      name: no-such-role\n    fieldPaths:\n    - .rules.0.resourceNames.0',
    test: BUNDLE,
  },
  {
    id: 'K03',
    claim: 'the manager is not told the policy name',
    subject: 'manager',
    anchor:
      '        env:\n        - name: WRITE_POLICY_NAME\n          value: secret-configmap-writes\n',
    replacement: '',
    test: BUNDLE,
  },
];

// MUTATION_ONLY=V01,K01 runs just those rows. Unset, every row runs; the declared count
// is the rows selected, so declared == run holds either way.
const ONLY = (process.env.MUTATION_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ROWS = ONLY.length === 0 ? MUTATIONS : MUTATIONS.filter((m) => ONLY.includes(m.id));
if (ONLY.length > 0 && ROWS.length !== ONLY.length) {
  console.error(`${NAME}: MUTATION_ONLY names a row that does not exist (${ONLY.join(',')})`);
  process.exit(2);
}

function envtestAssetsPresent() {
  if (process.env.KUBEBUILDER_ASSETS) return true;
  const dir = `${OPERATOR_MODULE}/bin/k8s`;
  return existsSync(dir) && readdirSync(dir).length > 0;
}

/** kustomize: $KUSTOMIZE, the operator's bin/, then PATH. */
function kustomizePath() {
  if (process.env.KUSTOMIZE) return process.env.KUSTOMIZE;
  const local = `${OPERATOR_MODULE}/bin/kustomize`;
  if (existsSync(local)) return local;
  const which = spawnSync('kustomize', ['version'], { stdio: 'ignore' });
  return which.status === 0 ? 'kustomize' : '';
}

/** Run one command; return its exit code. Stderr is kept only to explain a failed build check. */
function run(bin, args, { cwd = OPERATOR_MODULE, env = {}, showErrors = false } = {}) {
  const r = spawnSync(bin, args, {
    cwd,
    stdio: ['ignore', 'ignore', showErrors ? 'pipe' : 'ignore'],
    env: { ...process.env, ...env },
    timeout: 1_800_000,
  });
  if (r.error || r.status === null) {
    console.error(`${NAME}: cannot run ${bin}: ${r.error?.message ?? r.signal}`);
    process.exit(2);
  }
  if (showErrors && r.status !== 0) console.error(String(r.stderr ?? '').slice(-2000));
  return r.status;
}

/**
 * Re-render the install bundle exactly as `make build-installer` does (without the tool
 * downloads), then run the install tests that read it. A render that fails would "kill"
 * the row for the wrong reason, so it stops the prover instead of scoring.
 */
function renderBundle(kustomize) {
  return run('bash', [
    '-c',
    `mkdir -p dist && "${kustomize}" build config/default > dist/install.yaml && ./hack/set-ingress-class.sh dist/install.yaml ""`,
  ]);
}

function guardExit(test, kustomize) {
  if (test.kind === 'bundle') {
    if (renderBundle(kustomize) !== 0) {
      console.error(`${NAME}: kustomize could not render config/default; the row proves nothing`);
      process.exit(2);
    }
    return run(
      'go',
      [
        'test',
        '-count=1',
        '-run',
        'TestRenderedBundleGivesTheSelfCheckTheRenderedPolicyName|TestBaseManifestsNameThePolicyConsistently',
        INSTALL,
      ],
      { env: { KNEXT_REQUIRE_BUNDLE: '1' } },
    );
  }
  // -count=1: never trust a cached verdict for a mutated tree.
  return run('go', ['test', '-count=1', ...test.args]);
}

/** The mutated tree must still COMPILE its tests, or the row proves nothing. */
function buildsExit(file) {
  if (!file.endsWith('.go')) return 0;
  const build = run('go', ['build', './...'], { showErrors: true });
  if (build !== 0) return build;
  return run('go', ['test', '-count=1', '-run', '^$', WP, CTRL, CMD], { showErrors: true });
}

declareMutations(ROWS.length);
console.log(`${NAME}: ${ROWS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of ROWS) {
  const path = subjectPath(m.subject);
  if (path === undefined) {
    console.error(`${NAME}: ${m.id} names no subject ${m.subject}`);
    process.exit(2);
  }
  const count = snapshot(path).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(`${NAME}: ${m.id}'s anchor occurs ${count} times in ${path}; aborting`);
    process.exit(2);
  }
}
if (!envtestAssetsPresent()) {
  console.error(
    `${NAME}: no envtest binaries (set KUBEBUILDER_ASSETS or run \`make setup-envtest\` in packages/kn-next-operator)`,
  );
  process.exit(2);
}
const KUSTOMIZE = kustomizePath();
if (KUSTOMIZE === '') {
  console.error(
    `${NAME}: no kustomize (set KUSTOMIZE or run \`make kustomize\` in packages/kn-next-operator)`,
  );
  process.exit(2);
}

// Green baseline on a clean tree, for every distinct guard, else every verdict below is noise.
assertTreeClean(REPO_ROOT, 'baseline');
const seen = new Set();
for (const m of ROWS) {
  const key = JSON.stringify(m.test);
  if (seen.has(key)) continue;
  seen.add(key);
  const code = guardExit(m.test, KUSTOMIZE);
  if (code !== 0) {
    console.error(`${NAME}: baseline RED for ${m.id}'s guard (exit ${code}); fix the tree first`);
    process.exit(2);
  }
}
console.log(`${NAME}: baseline green (${seen.size} distinct guards)`);

// CANARY: prove the harness can SEE red before any green below is trusted. A runner that
// always exits 0 would certify every row while nothing ran. The canary is a real mutation
// (the Deny test skipped) graded by the fast, cluster-free guard.
{
  assertTreeClean(REPO_ROOT, 'before the canary');
  const canary = MUTATIONS.find((m) => m.id === 'V02');
  const snap = snapshot(subjectPath(canary.subject));
  let code;
  try {
    mutate(snap, canary.anchor, canary.replacement);
    code = guardExit(canary.test, KUSTOMIZE);
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, 'after the canary');
  if (code === 0) {
    console.error(
      `${NAME}: the canary mutation (${canary.claim}) left its guard GREEN; the harness cannot observe red`,
    );
    process.exit(2);
  }
  console.log(`${NAME}: canary ok: the harness sees red (exit ${code})`);
}

let failed = 0;
for (const m of ROWS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const path = subjectPath(m.subject);
  const snap = snapshot(path);
  let built;
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    built = buildsExit(path);
    code = built === 0 ? guardExit(m.test, KUSTOMIZE) : undefined;
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  if (built !== 0) {
    console.error(
      `${NAME}: ${m.id}'s mutation does not build (exit ${built}); the row proves nothing`,
    );
    process.exit(2);
  }
  recordMutation();
  const ok = code !== 0;
  if (!ok) failed++;
  console.log(`${ok ? 'KILLED   ' : '*** SURVIVED ***'} ${m.id} exit=${code} — ${m.claim}`);
}

// The last bundle row rendered a MUTATED overlay into dist/install.yaml (gitignored). Put the
// restored tree's bundle back so a local `go test ./internal/install/` is not left reading a mutant.
if (ROWS.some((m) => m.test.kind === 'bundle')) renderBundle(KUSTOMIZE);

console.log(`${NAME}: ${ROWS.length - failed}/${ROWS.length} went red as required`);
process.exit(failed === 0 ? 0 : 1);
