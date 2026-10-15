#!/usr/bin/env node
/**
 * Mutation proof for zone functions in the operator (issue #2052): the
 * BackendService reconciler, its data-sovereignty allowlist, and the zone's
 * rendered binding env (ADR-0004 Amendments 1 and 2).
 *
 * Every row breaks ONE rule and must turn its guard red:
 *   - the credential allowlist, one row per Secret SOURCE (secretKeyRef, envFrom,
 *     Secret volume, projected volume), the deny rules (another zone's database
 *     Secret, a Secret marked for another zone, any zone's signing key), the allow
 *     rules (own database Secret, same-zone mark, UID-checked ownerReference), and
 *     the foreign-JWKS rule per ConfigMap source;
 *   - the database-host LINT (it warns, never rejects);
 *   - the reconciler: fail closed, both halves of the binding, revocation, a
 *     conflicting owner, the operator-owned ServiceAccount, the optional JWKS
 *     mount, the activator peer, cluster-local, the served version read from the
 *     READY revision, the controller ownerReference;
 *   - the zone render: rendered at all, sorted, collisions kept, cross-zone
 *     refused, served version, wake opt-out, byte-identical with no binding, and
 *     the BackendBindings condition computed in computeStatusVerdict;
 *   - the CRD's CEL rules (spec.zone immutable, /var/run/knext reserved), the
 *     nextapps/finalizers grant, and unconditional metric registration.
 *
 * Graded by `go test` targets in packages/kn-next-operator: plain unit tests,
 * the envtest Ginkgo suite (focused per row), the RBAC envtest and the metric
 * golden. Each row is BUILD-CHECKED first (the mutated tree must compile its
 * tests), so a row can only count as killed by a failing assertion, never by a
 * compile error.
 *
 * Opt-in, cluster-bound row K01: set KNEXT_CALICO_CLUSTER to a kind cluster that
 * already runs Calico + Knative (left by the drill with KEEP_CLUSTER=1). It drops
 * the activator peer from the function NetworkPolicy and re-runs the Calico
 * function leg of test/networkpolicy-enforcement-drill.sh, which must exit
 * non-zero (the cold call is blackholed). Without the variable that row is not
 * declared, so the declared count stays honest.
 *
 * Envtest binaries: KUBEBUILDER_ASSETS, or packages/kn-next-operator/bin/k8s
 * (`make setup-envtest`). Exit 0 = every row went red; 1 = a row survived;
 * 2 = the prover could not run (anchor drift, red baseline, a mutation that does
 * not compile, missing tool). Never parses output.
 *
 * Usage:
 *   node scripts/mutation-prove-2052-backendservice.mjs
 *   KNEXT_CALICO_CLUSTER=knext-z8-e2e node scripts/mutation-prove-2052-backendservice.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const NAME = 'mutation-prove-2052-backendservice';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the commands' cwd), not a mutation subject.
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;
// biome-ignore format: one-line resolve() for the anchor-drift scan
const SOV = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_sovereignty.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const CTL = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_controller.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const RENDER = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_render.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const VERDICT = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_verdict.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const BIND = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backend_bindings.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const NEXTAPP = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/nextapp_controller.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const STATUS = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/status_verdict.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const METRICS = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_metrics.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const CRD = resolve(REPO_ROOT, 'packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_backendservices.yaml');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const ROLE = resolve(REPO_ROOT, 'packages/kn-next-operator/config/rbac/role.yaml');

const PROVER = {
  subjects: {
    sov: SOV,
    ctl: CTL,
    render: RENDER,
    verdict: VERDICT,
    bind: BIND,
    nextapp: NEXTAPP,
    status: STATUS,
    metrics: METRICS,
    crd: CRD,
    role: ROLE,
  },
};

const PKG = './internal/controller/';

/** A unit-test row: `go test -run <run> <pkg>`. */
const unit = (run, pkg = PKG) => ({ kind: 'go', args: ['-run', run, pkg] });
/** An envtest row: the Ginkgo suite, focused. */
const envtest = (focus) => ({
  kind: 'go',
  args: ['-run', 'TestControllers', PKG, `-ginkgo.focus=${focus}`],
});

const MUTATIONS = [
  // --- the credential allowlist, one row per Secret source ------------------
  {
    id: 'S01',
    claim: 'a secretKeyRef is not checked',
    subject: 'sov',
    anchor:
      'refs = append(refs, objectRef{fmt.Sprintf("env[%s].valueFrom.secretKeyRef", e.Name), e.ValueFrom.SecretKeyRef.Name})',
    replacement: '_ = e.ValueFrom',
    test: unit('TestSovereigntyRejectsUnmarkedSecret_SecretKeyRef'),
  },
  {
    id: 'S02',
    claim: 'an envFrom secretRef is not checked',
    subject: 'sov',
    anchor:
      'refs = append(refs, objectRef{fmt.Sprintf("envFrom[%d].secretRef", i), ef.SecretRef.Name})',
    replacement: '_, _ = i, ef',
    test: unit('TestSovereigntyRejectsUnmarkedSecret_EnvFrom'),
  },
  {
    id: 'S03',
    claim: 'a Secret volume is not checked',
    subject: 'sov',
    anchor:
      'refs = append(refs, objectRef{fmt.Sprintf("volumes[%s].secret", v.Name), v.Secret.SecretName})',
    replacement: '_ = v',
    test: unit('TestSovereigntyRejectsUnmarkedSecret_SecretVolume'),
  },
  {
    id: 'S04',
    claim: 'a projected Secret source is not checked',
    subject: 'sov',
    anchor:
      'refs = append(refs, objectRef{fmt.Sprintf("volumes[%s].projected.sources[%d].secret", v.Name, i), s.Secret.Name})',
    replacement: '_, _ = i, s',
    test: unit('TestSovereigntyRejectsUnmarkedSecret_ProjectedVolume'),
  },
  {
    id: 'S05',
    claim:
      "another zone's database Secret is allowed (and deny no longer wins over a same-zone mark)",
    subject: 'sov',
    anchor: 'if owner, ok := foreignDB[ref.name]; ok {',
    replacement: 'if owner, ok := foreignDB[ref.name]; ok && false {',
    test: unit(
      'TestSovereigntyRejectsForeignDatabaseSecret|TestSovereigntyDenyWinsOverSameZoneMark',
    ),
  },
  {
    id: 'S06',
    claim: 'a Secret marked for another zone is allowed',
    subject: 'sov',
    anchor: 'if other := foreignMark(m, zoneName, zone); other != "" {',
    replacement: 'if other := foreignMark(m, zoneName, zone); other != "" && false {',
    test: unit(
      'TestSovereigntyRejectsSecretLabelledForAnotherZone|TestSovereigntyRejectsSecretOwnedByAnotherZone',
    ),
  },
  {
    id: 'S07',
    claim: "the zone's own database Secret is refused (allow rule a dropped)",
    subject: 'sov',
    anchor: 'if ownDB[ref.name] || markedFor(m, zone) {',
    replacement: 'if markedFor(m, zone) {',
    test: unit('TestSovereigntyAllowsOwnDatabaseSecretFromEverySource'),
  },
  {
    id: 'S08',
    claim: 'a Secret marked for the zone is refused (allow rule b dropped)',
    subject: 'sov',
    anchor: 'if ownDB[ref.name] || markedFor(m, zone) {',
    replacement: 'if ownDB[ref.name] {',
    test: unit('TestSovereigntyAllowsSecretMarkedForSameZone'),
  },
  {
    id: 'S09',
    claim: "an ownerReference to a recreated zone (stale UID) counts as the zone's mark",
    subject: 'sov',
    anchor: 'ref.Name == zone.Name && ref.UID == zone.UID {',
    replacement: 'ref.Name == zone.Name {',
    test: unit('TestSovereigntyRejectsOwnerReferenceWithWrongUID'),
  },
  {
    id: 'S10',
    claim: "a zone's signing key reaches a function",
    subject: 'sov',
    anchor: 'if strings.HasSuffix(ref.name, zoneSigningKeySecretSuffix) {',
    replacement: 'if false {',
    test: unit('TestSovereigntyRejectsEveryZoneSigningKeySecret'),
  },
  {
    id: 'S11',
    claim: 'a configMapKeyRef to a foreign JWKS is not checked',
    subject: 'sov',
    anchor:
      'refs = append(refs, objectRef{fmt.Sprintf("env[%s].valueFrom.configMapKeyRef", e.Name), e.ValueFrom.ConfigMapKeyRef.Name})',
    replacement: '_ = e.ValueFrom',
    test: unit('TestSovereigntyRejectsForeignJWKSFromEverySource/configMapKeyRef'),
  },
  {
    id: 'S12',
    claim: 'an envFrom configMapRef to a foreign JWKS is not checked',
    subject: 'sov',
    anchor:
      'refs = append(refs, objectRef{fmt.Sprintf("envFrom[%d].configMapRef", i), ef.ConfigMapRef.Name})',
    replacement: '_, _ = i, ef',
    test: unit('TestSovereigntyRejectsForeignJWKSFromEverySource/envFrom'),
  },
  {
    id: 'S13',
    claim: 'a ConfigMap volume of a foreign JWKS is not checked',
    subject: 'sov',
    anchor:
      'refs = append(refs, objectRef{fmt.Sprintf("volumes[%s].configMap", v.Name), v.ConfigMap.Name})',
    replacement: '_ = v',
    test: unit('TestSovereigntyRejectsForeignJWKSFromEverySource/configMapVolume'),
  },
  {
    id: 'S14',
    claim: 'a projected ConfigMap source of a foreign JWKS is not checked',
    subject: 'sov',
    anchor:
      'refs = append(refs, objectRef{fmt.Sprintf("volumes[%s].projected.sources[%d].configMap", v.Name, i), s.ConfigMap.Name})',
    replacement: '_, _ = i, s',
    test: unit('TestSovereigntyRejectsForeignJWKSFromEverySource/projectedVolume'),
  },
  {
    id: 'S15',
    claim: "another zone's JWKS is allowed and the own one refused",
    subject: 'sov',
    anchor: '&& ref.name != ownJWKS {',
    replacement: '&& ref.name == ownJWKS {',
    test: unit(
      'TestSovereigntyRejectsForeignJWKSFromEverySource|TestSovereigntyAllowsOwnJWKSAndPlainConfigMaps',
    ),
  },
  // --- the database-host LINT ------------------------------------------------
  {
    id: 'L01',
    claim: 'a host in another namespace is not flagged',
    subject: 'sov',
    anchor: 'labels[1] != "svc" && labels[1] != bs.Namespace {',
    replacement: 'labels[1] != "svc" && labels[1] != bs.Namespace && false {',
    test: unit('TestDatabaseHostLintFlagsAnotherNamespace'),
  },
  {
    id: 'L02',
    claim: 'a cluster named <zone>-... is not attributed to that zone',
    subject: 'sov',
    anchor: 'if cluster == z || strings.HasPrefix(cluster, z+"-") {',
    replacement: 'if cluster == z {',
    test: unit('TestDatabaseHostLintFlagsAnotherZonesCluster'),
  },
  {
    id: 'L03',
    claim: 'the shortest zone prefix wins (own cluster flagged as foreign)',
    subject: 'sov',
    anchor: 'sort.SliceStable(zones, func(i, j int) bool { return len(zones[i]) > len(zones[j]) })',
    replacement:
      'sort.SliceStable(zones, func(i, j int) bool { return len(zones[i]) < len(zones[j]) })',
    test: unit('TestDatabaseHostLintLongestZonePrefixWins'),
  },
  {
    id: 'L04',
    claim: 'the lint rejects the function instead of warning',
    subject: 'verdict',
    anchor: '&& o.zoneListed && len(o.violations) == 0',
    replacement: '&& o.zoneListed && len(o.violations) == 0 && len(o.lint) == 0',
    test: envtest('foreign database host as a lint WARNING'),
  },
  // --- the reconciler ---------------------------------------------------------
  {
    id: 'R01',
    claim: 'a refused function is rendered anyway (not fail-closed)',
    subject: 'ctl',
    anchor: '\tif obs.accepted() {',
    replacement: '\tif true {',
    test: envtest('the credential allowlist'),
  },
  {
    id: 'R02',
    claim: 'the zone half of the binding is ignored (one-sided binding renders)',
    subject: 'ctl',
    anchor: '\t\tfor _, entry := range obs.zone.Spec.Backends {',
    replacement: '\t\tobs.zoneListed = true\n\t\tfor _, entry := range obs.zone.Spec.Backends {',
    test: envtest('one-sided binding from the function side|revokes: removing the zone'),
  },
  {
    id: 'R03',
    claim: 'a revoked or newly-refused function keeps its Knative Service',
    subject: 'ctl',
    anchor: 'if err := r.removeRendered(ctx, bs); err != nil {',
    replacement: 'if err := error(nil); err != nil {',
    test: envtest('revokes: removing the zone|fails closed: a violation added'),
  },
  {
    id: 'R04',
    claim: 'a conflicting controller ownerReference is ignored',
    subject: 'ctl',
    anchor: 'obs.conflictingOwner = conflictingController(bs, obs.zone)',
    replacement: 'obs.conflictingOwner = ""',
    test: envtest('never overwrites a conflicting controller ownerReference'),
  },
  {
    id: 'R05',
    claim: 'the pod does not run as the operator-owned ServiceAccount',
    subject: 'render',
    anchor: 'spec.ServiceAccountName = FunctionServiceAccountName(bs.Name)',
    replacement: 'spec.ServiceAccountName = ""',
    test: envtest(
      'stray serviceAccountName|operator-owned ServiceAccount and the function NetworkPolicy',
    ),
  },
  {
    id: 'R06',
    claim: 'the JWKS mount is not optional (a function cannot start before its zone identity)',
    subject: 'render',
    anchor: 'Optional: ptr.To(true),',
    replacement: 'Optional: ptr.To(false),',
    test: envtest('operator-owned ServiceAccount and the function NetworkPolicy'),
  },
  {
    id: 'R07',
    claim: "the function mounts a JWKS that is not its own zone's",
    subject: 'render',
    anchor: 'Name: ZoneJWKSConfigMapName(bs.Spec.Zone)},',
    replacement: 'Name: ZoneJWKSConfigMapName(bs.Name)},',
    test: envtest('operator-owned ServiceAccount and the function NetworkPolicy'),
  },
  {
    id: 'R08',
    claim: 'the function NetworkPolicy drops the activator peer (knative-serving)',
    subject: 'render',
    anchor: 'inNamespaceLabelsPeer("knative-serving", "kourier-system"),',
    replacement: 'inNamespaceLabelsPeer("kourier-system"),',
    test: envtest('operator-owned ServiceAccount and the function NetworkPolicy'),
  },
  {
    id: 'R09',
    claim: 'the function Knative Service is not cluster-local',
    subject: 'render',
    anchor: 'ksvc.Labels["networking.knative.dev/visibility"] = VisibilityClusterLocalLabelValue',
    replacement: '_ = VisibilityClusterLocalLabelValue',
    test: envtest('operator-owned ServiceAccount and the function NetworkPolicy'),
  },
  {
    id: 'R10',
    claim: 'the served version is read from the spec, not from the READY revision',
    subject: 'ctl',
    anchor: 'served, revision = r.servedVersion(ctx, ksvc, served, revision)',
    replacement: 'served, revision = bs.Spec.ProtoVersion, ksvc.Status.LatestReadyRevisionName',
    test: envtest('stamped on the latest READY revision'),
  },
  {
    id: 'R11',
    claim: 'the zone reference is not a controller ownerReference',
    subject: 'ctl',
    anchor: 'if err := controllerutil.SetControllerReference(obs.zone, bs, r.Scheme); err != nil {',
    replacement: 'if err := controllerutil.SetOwnerReference(obs.zone, bs, r.Scheme); err != nil {',
    test: envtest('sets the controller ownerReference itself'),
  },
  // --- the zone render ----------------------------------------------------------
  {
    id: 'B01',
    claim: 'the binding env is not rendered into the zone',
    subject: 'nextapp',
    anchor: 'bindingCollisions = applyBindingEnv(ksvc, nextApp.Namespace, bindings)',
    replacement: '_ = bindings',
    test: envtest('never writes NextApp.spec|exactly one on a served-version bump'),
  },
  {
    id: 'B02',
    claim: 'the binding env is not sorted (a reconcile can roll a revision)',
    subject: 'bind',
    anchor: 'sort.Slice(res.env, func(i, j int) bool { return res.env[i].Name < res.env[j].Name })',
    replacement: '',
    test: unit('TestBindingEnvIsDeterministic'),
  },
  {
    id: 'B03',
    claim: "the zone's own same-named variable is overwritten",
    subject: 'bind',
    anchor: '\t\tif taken[name] {',
    replacement: '\t\tif false {',
    test: unit('TestBindingEnvCollisionKeepsExistingValueAndReportsName'),
  },
  {
    id: 'B04',
    claim: 'a cross-zone backends[] entry is rendered',
    subject: 'bind',
    anchor: '\t\tcase bs.Spec.Zone != app.Name:',
    replacement: '\t\tcase false:',
    test: envtest('cross-zone backends'),
  },
  {
    id: 'B05',
    claim: 'the served version is not rendered',
    subject: 'bind',
    anchor: '\t\tif e.servedProtoVersion != "" {',
    replacement: '\t\tif false {',
    test: unit('TestSharedBindingEnvFixture'),
  },
  {
    id: 'B06',
    claim: 'the wake-ahead opt-out is ignored',
    subject: 'bind',
    anchor: '\t\tif e.wakeAhead {',
    replacement: '\t\tif true {',
    test: unit('TestSharedBindingEnvFixture'),
  },
  {
    id: 'B07',
    claim: 'a zone with no binding no longer renders byte-identically',
    subject: 'bind',
    anchor: '\tif len(wake) > 0 {',
    replacement: '\tif true {',
    test: unit('TestZeroDiffGoldenWithFunctionsInTheNamespace|TestNoBindingsRenderNothing'),
  },
  {
    id: 'B08',
    claim: 'a one-sided or cross-zone entry renders env',
    subject: 'bind',
    anchor: '\t\tif e.state != bindingBound {',
    replacement: '\t\tif false {',
    test: unit('TestSharedBindingEnvFixture'),
  },
  {
    id: 'B09',
    claim: 'the BackendBindings condition is not computed in computeStatusVerdict',
    subject: 'status',
    anchor: 'if len(app.Spec.Backends) > 0 && extras.bindings != nil {',
    replacement: 'if false {',
    test: unit('TestBackendBindingsCondition'),
  },
  // --- CRD, RBAC and metrics ---------------------------------------------------
  {
    id: 'C01',
    claim: 'spec.zone can be changed after creation',
    subject: 'crd',
    // Whole lines, indentation included: the marker comment goes above the
    // replacement at its indentation, so a mid-line start would break the YAML.
    anchor:
      '                - message: spec.zone is immutable\n                  rule: self == oldSelf\n',
    replacement:
      "                - message: spec.zone is immutable\n                  rule: 'true'\n",
    test: envtest('change of spec.zone at admission'),
  },
  {
    id: 'C02',
    claim: 'a user volume may shadow the JWKS mount under /var/run/knext',
    subject: 'crd',
    anchor:
      "rule: self.mountPath != '/var/run/knext' && !self.mountPath.startsWith('/var/run/knext/')",
    replacement: "rule: 'true'",
    test: envtest('under /var/run/knext at admission'),
  },
  {
    id: 'P01',
    claim: 'the shipped role lacks nextapps/finalizers (blockOwnerDeletion is refused)',
    subject: 'role',
    anchor: '  - backendservices/finalizers\n  - nextapps/finalizers\n',
    replacement: '  - backendservices/finalizers\n',
    test: unit('TestFunctionOwnerReferenceNeedsTheNextAppFinalizersGrant'),
  },
  {
    id: 'M01',
    claim: 'the zone-function metrics are not registered',
    subject: 'metrics',
    anchor:
      'metrics.Registry.MustRegister(backendServiceReconcileTotal, backendServiceRefusalsTotal)',
    replacement: '_ = metrics.Registry',
    test: unit('TestGoldenMatchesTheOperatorsRegisteredMetrics', './internal/metriccontract/'),
  },
];

const CALICO_CLUSTER = process.env.KNEXT_CALICO_CLUSTER ?? '';
if (CALICO_CLUSTER !== '') {
  MUTATIONS.push({
    id: 'K01',
    claim:
      'Calico: the function NetworkPolicy drops the activator peer, so a cold call is blackholed',
    subject: 'render',
    anchor: 'inNamespaceLabelsPeer("knative-serving", "kourier-system"),',
    replacement: 'inNamespaceLabelsPeer("kourier-system"),',
    test: {
      kind: 'bash',
      args: ['test/networkpolicy-enforcement-drill.sh'],
      env: { CLUSTER: CALICO_CLUSTER, REUSE_CLUSTER: '1', LEGS: 'function' },
    },
  });
}

function envtestAssetsPresent() {
  if (process.env.KUBEBUILDER_ASSETS) return true;
  const dir = `${OPERATOR_MODULE}/bin/k8s`;
  return existsSync(dir) && readdirSync(dir).length > 0;
}

/** Run one command in the operator module; return its exit code. */
function run(bin, args, env = {}, { showErrors = false } = {}) {
  const r = spawnSync(bin, args, {
    cwd: OPERATOR_MODULE,
    // stderr is kept ONLY to explain a failed build check to a human; no
    // verdict ever reads it (verdicts are exit codes).
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

/** The row's guard. -count=1: never trust a cached verdict for a mutated tree. */
function guardExit(test) {
  if (test.kind === 'go') return run('go', ['test', '-count=1', ...test.args]);
  return run('bash', test.args, test.env);
}

/** The mutated tree must still COMPILE its tests, or the row proves nothing. */
function buildsExit() {
  const build = run('go', ['build', './...'], {}, { showErrors: true });
  if (build !== 0) return build;
  return run(
    'go',
    ['test', '-count=1', '-run', '^$', PKG, './internal/metriccontract/'],
    {},
    {
      showErrors: true,
    },
  );
}

declareMutations(MUTATIONS.length);
console.log(`${NAME}: ${MUTATIONS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of MUTATIONS) {
  const path = PROVER.subjects[m.subject];
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

// Green baseline on a clean tree, for every distinct guard, else every verdict
// below is noise.
assertTreeClean(REPO_ROOT, 'baseline');
const seen = new Set();
for (const m of MUTATIONS) {
  const key = JSON.stringify(m.test);
  if (seen.has(key)) continue;
  seen.add(key);
  const code = guardExit(m.test);
  if (code !== 0) {
    console.error(`${NAME}: baseline RED for ${m.id}'s guard (exit ${code}); fix the tree first`);
    process.exit(2);
  }
}
console.log(`${NAME}: baseline green (${seen.size} distinct guards)`);

let failed = 0;
for (const m of MUTATIONS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(PROVER.subjects[m.subject]);
  let built;
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    built = buildsExit();
    code = built === 0 ? guardExit(m.test) : undefined;
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  if (built !== 0) {
    console.error(
      `${NAME}: ${m.id}'s mutation does not compile (exit ${built}); the row proves nothing`,
    );
    process.exit(2);
  }
  recordMutation();
  const ok = code !== 0;
  if (!ok) failed++;
  console.log(`${ok ? 'KILLED   ' : '*** SURVIVED ***'} ${m.id} exit=${code} — ${m.claim}`);
}

console.log(`${NAME}: ${MUTATIONS.length - failed}/${MUTATIONS.length} went red as required`);
process.exit(failed === 0 ? 0 : 1);
