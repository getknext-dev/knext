#!/usr/bin/env node
/**
 * Mutation proof for the operator's Secret/ConfigMap write policy (issue #2462):
 * the ValidatingAdmissionPolicy that confines the operator's ServiceAccount to the
 * per-zone signing key and JWKS names, the kustomize wiring that gives it the
 * operator's real identity, and the scan that holds the policy's allow-list in
 * lockstep with the operator's source.
 *
 * Every row breaks ONE rule and must turn its guard red:
 *   - the policy: failurePolicy (fail open), each verb it must cover (create,
 *     update, delete), each resource, the allow-list in both directions (an extra
 *     suffix widens the operator, a wrong one breaks the reconciler), the suffix
 *     test (contains instead of endsWith), the resource-to-list ternary, the
 *     DELETE name source, the exact-identity equality (negated, loosened to every
 *     ServiceAccount), and the 403 reason;
 *   - the Secret type: the policy pins it (a service-account-token Secret under an
 *     allowed name would let the operator mint a credential), on create and update
 *     but not on delete or ConfigMaps, and the writer builds only that type;
 *   - the binding: it must Deny, name the policy, and not narrow the scope;
 *   - the kustomize wiring: the policy is in the default overlay, the namespace
 *     and name are rewritten from the real ServiceAccount (a wrong source or a
 *     wrong segment leaves an identity nobody runs as, so the policy would never
 *     match and the operator would be unrestricted with no error), and the
 *     cluster-scoped objects carry no namespace;
 *   - the code-side scan: a Secret named without the registered helper, a new
 *     Secret writer, an extra verb on a registered writer, a Secret written
 *     through an unstructured object, an interface-typed object written from a
 *     parameter, and a registered writer that stops writing;
 *   - the operator must not be able to lift the restriction itself: a shipped
 *     role that writes the policy kinds, scanned and then tried on a real
 *     apiserver, and a leader-election lock on a ConfigMap, which the policy
 *     would refuse.
 *
 * Graded by `go test` targets in packages/kn-next-operator: the typed-scan and
 * lockstep tests, the install-bundle tests (the rendered bundle is rebuilt for
 * every row that reads it), and the envtest proof on a real kube-apiserver. Each
 * row is BUILD-CHECKED first (the mutated tree must compile its tests), so a row
 * can only count as killed by a failing assertion, never by a compile error.
 *
 * Needs the envtest binaries (KUBEBUILDER_ASSETS, or packages/kn-next-operator/
 * bin/k8s from `make setup-envtest`) and kustomize (KUSTOMIZE, or
 * packages/kn-next-operator/bin/kustomize from `make kustomize`, or one on PATH).
 * Exit 0 = every row went red; 1 = a row survived; 2 = the prover could not run
 * (anchor drift, red baseline, a mutation that does not compile, missing tool).
 * Never parses output.
 *
 * Usage:
 *   node scripts/mutation-prove-2462-operator-write-policy.mjs
 *   MUTATION_ONLY=R01,L01 node scripts/mutation-prove-2462-operator-write-policy.mjs
 *     (just those rows, for a fast re-check; the nightly lane runs them all)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const NAME = 'mutation-prove-2462-operator-write-policy';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the commands' cwd), not a mutation subject.
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;
// biome-ignore format: one-line resolve() for the anchor-drift scan
const POLICY = resolve(REPO_ROOT, 'packages/kn-next-operator/config/admission/secret-configmap-writes.yaml');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const BINDING = resolve(REPO_ROOT, 'packages/kn-next-operator/config/admission/secret-configmap-writes-binding.yaml');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const DEFAULT_KUST = resolve(REPO_ROOT, 'packages/kn-next-operator/config/default/kustomization.yaml');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const ZONEKEY = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/zone_signing_key_reconcile.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const NEXTAPP = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/nextapp_controller.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const ROLE = resolve(REPO_ROOT, 'packages/kn-next-operator/config/rbac/role.yaml');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const MAIN = resolve(REPO_ROOT, 'packages/kn-next-operator/cmd/main.go');

const PROVER = {
  subjects: {
    policy: POLICY,
    binding: BINDING,
    defaultKust: DEFAULT_KUST,
    zonekey: ZONEKEY,
    nextapp: NEXTAPP,
    role: ROLE,
    main: MAIN,
  },
};

const CTRL = './internal/controller/';
const INSTALL = './internal/install/';

/** A `go test -run <run> <pkg>` guard. */
const unit = (run, pkg = CTRL) => ({ kind: 'go', args: ['-run', run, pkg] });
/** The typed-scan inventory tests (no cluster). */
const INVENTORY = unit(
  'TestOperatorSecretAndConfigMapWritersMatchTheRegistry|TestOperatorDynamicWritesAreJustifiedAndClosed|TestOperatorKindLiteralsLiveOnlyInReadOnlyFunctions',
);
/** The policy-versus-code lockstep (no cluster). */
const LOCKSTEP = unit('TestPolicyAllowListEqualsWhatTheOperatorWrites');
/** The policy and binding as authored (no cluster). */
const SOURCE = unit('TestOperatorWritePolicySourceIsStrict', INSTALL);
/** The envtest proof on a real kube-apiserver. */
const APISERVER = unit('TestOperatorWritePolicyNarrowsSecretAndConfigMapWrites');
/** The rendered bundle: re-render dist/install.yaml, then the install tests that read it. */
const BUNDLE = { kind: 'bundle' };
/** The rendered bundle's policy on a real apiserver, confining the identity its ClusterRoleBinding grants. */
const BUNDLE_APISERVER = { kind: 'bundle-apiserver' };
/** The Secret type: the writer builds Opaque Secrets, never changes the type, and the policy admits exactly that. */
const OPAQUE = unit('TestOperatorWritesOnlyOpaqueSecrets');
/** The RBAC scan: no shipped rule may let the operator write its own policy. */
const NO_SELF_EDIT = unit('TestOperatorCannotEditItsOwnWritePolicy');
/** The leader-election lock must stay a Lease (a ConfigMap lock would be refused by the policy). */
const LEASE_LOCK = unit('TestBuildManagerOptionsLeaderElectionNeverLocksOnAConfigMap', './cmd/...');

const MUTATIONS = [
  // --- the policy ----------------------------------------------------------------
  {
    id: 'P01',
    claim: 'the policy fails open (failurePolicy Ignore)',
    subject: 'policy',
    anchor: '  failurePolicy: Fail',
    replacement: '  failurePolicy: Ignore',
    test: SOURCE,
  },
  {
    id: 'P02',
    claim: 'the policy does not cover DELETE, so the operator could delete any Secret',
    subject: 'policy',
    anchor: '      operations: ["CREATE", "UPDATE", "DELETE"]',
    replacement: '      operations: ["CREATE", "UPDATE"]',
    test: SOURCE,
  },
  {
    id: 'P03',
    claim: 'the policy does not cover UPDATE, so the operator could overwrite any object',
    subject: 'policy',
    anchor: '      operations: ["CREATE", "UPDATE", "DELETE"]',
    replacement: '      operations: ["CREATE", "DELETE"]',
    test: APISERVER,
  },
  {
    id: 'P04',
    claim: 'the policy does not cover CREATE, so the operator could plant any object',
    subject: 'policy',
    anchor: '      operations: ["CREATE", "UPDATE", "DELETE"]',
    replacement: '      operations: ["UPDATE", "DELETE"]',
    test: APISERVER,
  },
  {
    id: 'P05',
    claim: 'the policy ignores ConfigMaps',
    subject: 'policy',
    anchor: '      resources: ["secrets", "configmaps"]',
    replacement: '      resources: ["secrets"]',
    test: SOURCE,
  },
  {
    id: 'P06',
    claim: 'the policy ignores Secrets',
    subject: 'policy',
    anchor: '      resources: ["secrets", "configmaps"]',
    replacement: '      resources: ["configmaps"]',
    test: APISERVER,
  },
  {
    id: 'P07',
    claim: 'the Secret allow-list holds a suffix the operator does not write (widened)',
    subject: 'policy',
    anchor: `    expression: "['-knext-signing-key']"`,
    replacement: `    expression: "['-knext-signing-key', '-extra']"`,
    test: LOCKSTEP,
  },
  {
    id: 'P08',
    claim:
      'the ConfigMap allow-list lacks the JWKS suffix the operator writes (reconciler refused)',
    subject: 'policy',
    anchor: `    expression: "['-knext-jwks']"`,
    replacement: `    expression: "['-knext-jwks-typo']"`,
    test: LOCKSTEP,
  },
  {
    id: 'P09',
    claim: 'the identity test is negated: everyone but the operator is confined',
    subject: 'policy',
    anchor: `    expression: "request.userInfo.username == 'system:serviceaccount:' + 'system' + ':' + 'controller-manager'"`,
    replacement: `    expression: "request.userInfo.username != 'system:serviceaccount:' + 'system' + ':' + 'controller-manager'"`,
    test: SOURCE,
  },
  {
    id: 'P10',
    claim: 'the policy confines every ServiceAccount, not only the operator',
    subject: 'policy',
    anchor: `    expression: "request.userInfo.username == 'system:serviceaccount:' + 'system' + ':' + 'controller-manager'"`,
    replacement: `    expression: "request.userInfo.username.startsWith('system:serviceaccount:')"`,
    test: APISERVER,
  },
  {
    id: 'P11',
    claim: 'a DELETE reads the name from the (absent) new object, so even an owned name errors',
    subject: 'policy',
    anchor: `    expression: "request.operation == 'DELETE' ? oldObject.metadata.name : object.metadata.name"`,
    replacement: '    expression: "object.metadata.name"',
    test: APISERVER,
  },
  {
    id: 'P12',
    claim: 'a name that merely contains the suffix is accepted (contains, not endsWith)',
    subject: 'policy',
    anchor: `  - expression: "variables.allowedSuffixes.exists(s, variables.objectName.endsWith(s) && size(variables.objectName) > size(s))"`,
    replacement: `  - expression: "variables.allowedSuffixes.exists(s, variables.objectName.contains(s) && size(variables.objectName) > size(s))"`,
    test: APISERVER,
  },
  {
    id: 'P13',
    claim: 'Secrets are checked against the ConfigMap suffix list (and the reverse)',
    subject: 'policy',
    anchor: `    expression: "request.resource.resource == 'secrets' ? variables.allowedSecretSuffixes : variables.allowedConfigMapSuffixes"`,
    replacement: `    expression: "request.resource.resource == 'secrets' ? variables.allowedConfigMapSuffixes : variables.allowedSecretSuffixes"`,
    test: APISERVER,
  },
  {
    id: 'P14',
    claim: 'a name refusal is no longer a 403 Forbidden',
    subject: 'policy',
    // Whole lines from the line start: the marker comment goes above the replacement.
    anchor: String.raw`    messageExpression: "'the knext operator may not ' + request.operation.lowerAscii() + ' the ' + request.resource.resource + ' object \"' + variables.objectName + '\": it writes only the per-zone signing key and JWKS'"
    reason: Forbidden`,
    replacement: String.raw`    messageExpression: "'the knext operator may not ' + request.operation.lowerAscii() + ' the ' + request.resource.resource + ' object \"' + variables.objectName + '\": it writes only the per-zone signing key and JWKS'"
    reason: Invalid`,
    test: APISERVER,
  },
  // --- the Secret type (a service-account-token Secret under an allowed name) ----
  {
    id: 'T01',
    claim:
      'the type check is removed: a service-account-token Secret under an allowed name is admitted',
    subject: 'policy',
    anchor: `  - expression: "request.resource.resource != 'secrets' || request.operation == 'DELETE' || dyn(object).type == variables.allowedSecretType"
    message: "the knext operator may write only Opaque Secrets: a service-account-token or any other Secret type under an allowed name would let it mint a credential"
    reason: Forbidden`,
    replacement: '',
    test: APISERVER,
  },
  {
    id: 'T02',
    claim: 'the type check admits any non-empty type',
    subject: 'policy',
    anchor: `  - expression: "request.resource.resource != 'secrets' || request.operation == 'DELETE' || dyn(object).type == variables.allowedSecretType"`,
    replacement: `  - expression: "request.resource.resource != 'secrets' || request.operation == 'DELETE' || dyn(object).type != ''"`,
    test: APISERVER,
  },
  {
    id: 'T03',
    claim:
      'the type check also runs on DELETE, where there is no new object, so an owned name errors',
    subject: 'policy',
    anchor: `  - expression: "request.resource.resource != 'secrets' || request.operation == 'DELETE' || dyn(object).type == variables.allowedSecretType"`,
    replacement: `  - expression: "request.resource.resource != 'secrets' || dyn(object).type == variables.allowedSecretType"`,
    test: APISERVER,
  },
  {
    id: 'T04',
    claim: 'the type check also runs on ConfigMaps, which have no type, so the JWKS is refused',
    subject: 'policy',
    anchor: `  - expression: "request.resource.resource != 'secrets' || request.operation == 'DELETE' || dyn(object).type == variables.allowedSecretType"`,
    replacement: `  - expression: "request.operation == 'DELETE' || dyn(object).type == variables.allowedSecretType"`,
    test: APISERVER,
  },
  {
    id: 'T05',
    claim:
      'the type check skips UPDATE, so a foreign token Secret under an allowed name can be changed',
    subject: 'policy',
    anchor: `  - expression: "request.resource.resource != 'secrets' || request.operation == 'DELETE' || dyn(object).type == variables.allowedSecretType"`,
    replacement: `  - expression: "request.resource.resource != 'secrets' || request.operation != 'CREATE' || dyn(object).type == variables.allowedSecretType"`,
    test: APISERVER,
  },
  {
    id: 'T06',
    claim: 'the allowed type is changed to a type the operator does not write (lockstep)',
    subject: 'policy',
    anchor: `    expression: "'Opaque'"`,
    replacement: `    expression: "'kubernetes.io/service-account-token'"`,
    test: OPAQUE,
  },
  {
    id: 'T07',
    claim: 'the type refusal is no longer a 403 Forbidden',
    subject: 'policy',
    anchor: String.raw`    message: "the knext operator may write only Opaque Secrets: a service-account-token or any other Secret type under an allowed name would let it mint a credential"
    reason: Forbidden`,
    replacement: String.raw`    message: "the knext operator may write only Opaque Secrets: a service-account-token or any other Secret type under an allowed name would let it mint a credential"
    reason: Invalid`,
    test: APISERVER,
  },
  // --- the binding ---------------------------------------------------------------
  {
    id: 'B01',
    claim: 'the binding only audits (no Deny), so nothing is refused',
    subject: 'binding',
    anchor: '  validationActions: ["Deny", "Audit"]',
    replacement: '  validationActions: ["Audit"]',
    test: SOURCE,
  },
  {
    id: 'B02',
    claim: 'the binding names a policy that does not exist',
    subject: 'binding',
    anchor: '  policyName: secret-configmap-writes',
    replacement: '  policyName: secret-configmap-writes-typo',
    test: SOURCE,
  },
  {
    id: 'B03',
    claim: 'the binding scopes the policy to labelled namespaces only',
    subject: 'binding',
    anchor: '  validationActions: ["Deny", "Audit"]',
    replacement:
      '  validationActions: ["Deny", "Audit"]\n  matchResources:\n    namespaceSelector:\n      matchLabels:\n        knext-scoped: "true"',
    test: SOURCE,
  },
  // --- the kustomize wiring ------------------------------------------------------
  {
    id: 'K01',
    claim: 'the default overlay does not include the policy',
    subject: 'defaultKust',
    anchor: '- ../admission',
    replacement: '# - ../admission',
    test: BUNDLE,
  },
  {
    id: 'K02',
    claim: 'the namespace literal is rewritten from the ServiceAccount NAME (wrong source field)',
    subject: 'defaultKust',
    anchor:
      '# ServiceAccount namespace -> policy matchCondition (namespace literal)\n- source:\n    kind: ServiceAccount\n    version: v1\n    name: controller-manager\n    fieldPath: .metadata.namespace',
    replacement:
      '# ServiceAccount namespace -> policy matchCondition (namespace literal)\n- source:\n    kind: ServiceAccount\n    version: v1\n    name: controller-manager\n    fieldPath: .metadata.name',
    test: BUNDLE,
  },
  {
    id: 'K03',
    claim: 'the name rewrite lands on the wrong literal, leaving the base name in the identity',
    subject: 'defaultKust',
    anchor: '      index: 7',
    replacement: '      index: 5',
    test: BUNDLE,
  },
  {
    id: 'K04',
    claim: 'the cluster-scoped policy keeps the namespace the overlay stamps on it',
    subject: 'defaultKust',
    anchor: '- admission_clusterscoped.yaml',
    replacement: '# - admission_clusterscoped.yaml',
    test: BUNDLE,
  },
  {
    id: 'K05',
    claim:
      'the rendered policy confines an identity nobody runs as, so the operator is unrestricted on a real apiserver',
    subject: 'defaultKust',
    anchor:
      '# ServiceAccount namespace -> policy matchCondition (namespace literal)\n- source:\n    kind: ServiceAccount\n    version: v1\n    name: controller-manager\n    fieldPath: .metadata.namespace',
    replacement:
      '# ServiceAccount namespace -> policy matchCondition (namespace literal)\n- source:\n    kind: ServiceAccount\n    version: v1\n    name: controller-manager\n    fieldPath: .metadata.name',
    test: BUNDLE_APISERVER,
  },
  // --- the code-side scan --------------------------------------------------------
  {
    id: 'C01',
    claim: 'the signing-key Secret is named without the registered helper',
    subject: 'zonekey',
    anchor: '				Name:      ZoneSigningKeySecretName(app.Name),',
    replacement: '				Name:      app.Name + "-signing",',
    test: INVENTORY,
  },
  {
    id: 'C02',
    claim: 'a new Secret writer appears that the policy would refuse in a cluster',
    subject: 'zonekey',
    anchor: 'func (r *NextAppReconciler) writeJWKSConfigMap(',
    replacement:
      'func (r *NextAppReconciler) sneakySecret(ctx context.Context) error {\n\treturn r.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "sneaky", Namespace: "default"}})\n}\n\nfunc (r *NextAppReconciler) writeJWKSConfigMap(',
    test: INVENTORY,
  },
  {
    id: 'C03',
    claim:
      'a registered writer gains a verb (Patch) the registry and the policy allow-list never saw',
    subject: 'zonekey',
    anchor:
      '	cm.Data = map[string]string{ZoneJWKSFileName: jwks}\n	if err := r.Update(ctx, cm); err != nil {',
    replacement:
      '	cm.Data = map[string]string{ZoneJWKSFileName: jwks}\n	_ = r.Patch(ctx, cm, client.MergeFrom(cm.DeepCopy()))\n	if err := r.Update(ctx, cm); err != nil {',
    test: INVENTORY,
  },
  {
    id: 'C04',
    claim: 'a Secret is written through an unstructured object, invisible to the type',
    subject: 'nextapp',
    anchor: 'func (r *NextAppReconciler) now() time.Time {',
    replacement:
      'func (r *NextAppReconciler) sneakyKind(ctx context.Context) error {\n\tu := &unstructured.Unstructured{}\n\tu.SetKind("Secret")\n\treturn r.Create(ctx, u)\n}\n\nfunc (r *NextAppReconciler) now() time.Time {',
    test: INVENTORY,
  },
  {
    id: 'C05',
    claim: 'an interface-typed object handed in by a caller is written (its kind cannot be shown)',
    subject: 'nextapp',
    anchor: 'func (r *NextAppReconciler) now() time.Time {',
    replacement:
      'func (r *NextAppReconciler) sneakyDelete(ctx context.Context, obj client.Object) error {\n\treturn r.Delete(ctx, obj)\n}\n\nfunc (r *NextAppReconciler) now() time.Time {',
    test: INVENTORY,
  },
  {
    id: 'C06',
    claim: 'a registered writer stops writing, leaving a stale policy suffix',
    subject: 'zonekey',
    anchor: '		if err := r.Create(ctx, cm); err != nil {',
    replacement: '		if err := error(nil); err != nil {',
    test: INVENTORY,
  },
  {
    id: 'C07',
    claim: 'the signing-key Secret is built as a service-account-token Secret',
    subject: 'zonekey',
    anchor: '			Type: corev1.SecretTypeOpaque,',
    replacement: '			Type: corev1.SecretTypeServiceAccountToken,',
    test: OPAQUE,
  },
  {
    id: 'C08',
    claim: 'the signing-key Secret leaves its type unset, so the lockstep cannot see it',
    subject: 'zonekey',
    anchor: '			Type: corev1.SecretTypeOpaque,',
    replacement: '',
    test: OPAQUE,
  },
  {
    id: 'C09',
    claim: "a Secret's type is assigned after its literal was built",
    subject: 'zonekey',
    anchor: 'func (r *NextAppReconciler) writeJWKSConfigMap(',
    replacement:
      'func sneakyType(sec *corev1.Secret) {\n\tsec.Type = corev1.SecretTypeTLS\n}\n\nfunc (r *NextAppReconciler) writeJWKSConfigMap(',
    test: OPAQUE,
  },
  // --- the operator must not be able to lift its own restriction -----------------
  {
    id: 'R01',
    claim: 'the shipped role lets the operator edit and delete the policy binding (RBAC scan)',
    subject: 'role',
    anchor: 'rules:\n- apiGroups:\n  - ""\n  resources:\n  - configmaps',
    replacement:
      'rules:\n- apiGroups:\n  - admissionregistration.k8s.io\n  resources:\n  - validatingadmissionpolicies\n  - validatingadmissionpolicybindings\n  verbs:\n  - delete\n  - update\n- apiGroups:\n  - ""\n  resources:\n  - configmaps',
    test: NO_SELF_EDIT,
  },
  {
    id: 'R02',
    claim: 'the same grant lets the operator delete its binding on a real apiserver',
    subject: 'role',
    anchor: 'rules:\n- apiGroups:\n  - ""\n  resources:\n  - configmaps',
    replacement:
      'rules:\n- apiGroups:\n  - admissionregistration.k8s.io\n  resources:\n  - validatingadmissionpolicies\n  - validatingadmissionpolicybindings\n  verbs:\n  - delete\n  - update\n- apiGroups:\n  - ""\n  resources:\n  - configmaps',
    test: APISERVER,
  },
  // --- the leader-election lock stays a Lease ---------------------------------------
  {
    id: 'L01',
    claim: 'leader election locks on a ConfigMap, which the policy would refuse',
    subject: 'main',
    anchor: '		LeaderElectionReleaseOnCancel: true,',
    replacement:
      '		LeaderElectionReleaseOnCancel: true,\n		LeaderElectionResourceLock:    "configmapsleases",',
    test: LEASE_LOCK,
  },
];

// MUTATION_ONLY=R01,L01 runs just those rows (a fast re-check while iterating). Unset,
// as in the nightly lane, every row runs; the declared count is the rows selected, so
// declared == run holds either way.
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

/**
 * Re-render the install bundle exactly as `make build-installer` does (without the
 * tool downloads), then run the install tests that read it. A render that fails
 * is a red guard: a mutated overlay that no longer builds is not a bundle.
 */
function renderBundle(kustomize) {
  return run('bash', [
    '-c',
    `mkdir -p dist && "${kustomize}" build config/default > dist/install.yaml && ./hack/set-ingress-class.sh dist/install.yaml ""`,
  ]);
}

function bundleExit(kustomize, test) {
  // A render that fails would "kill" the row for the wrong reason (a broken overlay,
  // not a failed assertion), so it stops the prover instead of scoring.
  if (renderBundle(kustomize) !== 0) {
    console.error(`${NAME}: kustomize could not render config/default; the row proves nothing`);
    process.exit(2);
  }
  if (test.kind === 'bundle-apiserver') {
    return run(
      'go',
      [
        'test',
        '-count=1',
        '-run',
        'TestRenderedBundlePolicyConfinesTheIdentityTheOperatorRunsAs',
        CTRL,
      ],
      { KNEXT_REQUIRE_BUNDLE: '1' },
    );
  }
  return run('go', ['test', '-count=1', '-run', 'WritePolicy', INSTALL], {
    KNEXT_REQUIRE_BUNDLE: '1',
  });
}

/** The row's guard. -count=1: never trust a cached verdict for a mutated tree. */
function guardExit(test, kustomize) {
  if (test.kind === 'bundle' || test.kind === 'bundle-apiserver')
    return bundleExit(kustomize, test);
  return run('go', ['test', '-count=1', ...test.args]);
}

/** The mutated tree must still COMPILE its tests, or the row proves nothing. */
function buildsExit() {
  const build = run('go', ['build', './...'], {}, { showErrors: true });
  if (build !== 0) return build;
  return run('go', ['test', '-count=1', '-run', '^$', CTRL, INSTALL], {}, { showErrors: true });
}

declareMutations(ROWS.length);
console.log(`${NAME}: ${ROWS.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of ROWS) {
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
const KUSTOMIZE = kustomizePath();
if (KUSTOMIZE === '') {
  console.error(
    `${NAME}: no kustomize (set KUSTOMIZE or run \`make kustomize\` in packages/kn-next-operator)`,
  );
  process.exit(2);
}

// Green baseline on a clean tree, for every distinct guard, else every verdict
// below is noise.
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

// CANARY: prove the harness can SEE red before any green below is trusted. A runner
// that always exits 0 would certify every row while nothing ran. The canary is a real
// mutation of the real policy (fail open) graded by the fast, cluster-free guard, so
// it also proves the runner is pointed at the right test.
{
  assertTreeClean(REPO_ROOT, 'before the canary');
  const canary = MUTATIONS.find((m) => m.id === 'P01');
  const snap = snapshot(PROVER.subjects[canary.subject]);
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
      `${NAME}: the canary mutation (${canary.claim}) left its guard GREEN; the harness cannot observe red, so nothing below would mean anything`,
    );
    process.exit(2);
  }
  console.log(`${NAME}: canary ok: the harness sees red (exit ${code})`);
}

let failed = 0;
for (const m of ROWS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(PROVER.subjects[m.subject]);
  let built;
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    built = buildsExit();
    code = built === 0 ? guardExit(m.test, KUSTOMIZE) : undefined;
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

// The last bundle row rendered a MUTATED overlay into dist/install.yaml (gitignored). Put
// the restored tree's bundle back so a local `go test ./internal/install/` is not left
// reading a mutant.
if (ROWS.some((m) => m.test.kind.startsWith('bundle'))) renderBundle(KUSTOMIZE);

console.log(`${NAME}: ${ROWS.length - failed}/${ROWS.length} went red as required`);
process.exit(failed === 0 ? 0 : 1);
