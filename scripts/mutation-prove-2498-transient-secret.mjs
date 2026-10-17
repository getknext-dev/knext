#!/usr/bin/env node
/**
 * Mutation proof for "a transient apiserver error never deletes a running
 * function": an error on a Secret's metadata GET says nothing about the
 * Secret's marks, so it must neither refuse the function (a sovereignty
 * violation) nor tear its Knative Service down; only a definitive answer
 * (NotFound, or an object with the wrong owner or labels) does.
 *
 * Every row breaks ONE rule and requires its `go test` guard to go red:
 *   - the classification: an unreadable Secret becomes a violation again (M01),
 *     the lookup drops the read error and reports "unmarked" (M06), or NotFound
 *     is read as "unknown" so a definitive refusal never happens (M09);
 *   - the exit: Reconcile stops leaving on an undecided function (M02), it
 *     holds the error but never returns it (M05), `undecided` ignores a
 *     definitive refusal (M03) or never fires (M04);
 *   - the status: an undecided pass says SecretsUnverified, not compliant and
 *     not a violation (M10, M11), and is not counted as a refusal (M12);
 *   - the scan: a new API-error-to-teardown path is added to Reconcile (M07) or
 *     to the sanctioned fork's neighbour (M08), and the AST guard must see it.
 *
 * Verdicts are by EXIT CODE only, every anchor must occur exactly once
 * (preflight first), the baselines must be green, a CANARY must go red before
 * any green is trusted, a NEUTRAL control (same behaviour, spelled differently)
 * must stay green so a runner that is always red cannot certify the table, every
 * Go row is BUILD-CHECKED first (a row is killed by a failing assertion, never
 * a compile error), and every restore is content-verified.
 *
 * What this does not prove: a real apiserver's failure modes (the envtest rows
 * inject the errors at the reader); the guard scan covers the BackendService
 * reconciler's own sources.
 *
 * Exit 0 = every row behaved as required; 1 = a row survived; 2 = the prover
 * could not run (anchor drift, red baseline, a mutation that does not compile).
 *
 * Usage:  node scripts/mutation-prove-2498-transient-secret.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const NAME = 'mutation-prove-2498-transient-secret';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the commands' cwd), not a mutation subject.
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;
// biome-ignore format: one-line resolve() for the anchor-drift scan
const CONTROLLER = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_controller.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const SOVEREIGNTY = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_sovereignty.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const VERDICT = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_verdict.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const CRD = resolve(REPO_ROOT, 'packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_backendservices.yaml');

const PROVER = {
  subjects: { controller: CONTROLLER, sovereignty: SOVEREIGNTY, verdict: VERDICT, crd: CRD },
};

const PKG = './internal/controller/';
const unit = (run, pkg = PKG) => ({ kind: 'go', args: ['-run', run, pkg] });
/** An envtest row: the Ginkgo suite, focused. */
const envtest = (focus) => ({
  kind: 'go',
  args: ['-run', 'TestControllers', PKG, `-ginkgo.focus=${focus}`],
});

const CLASSIFY =
  'TestSovereigntyUnreadableSecretIsUnverifiedNotAViolation|TestSovereigntyDefinitiveViolationSurvivesAnUnverifiedNeighbour|TestSovereigntyNotFoundSecretIsStillAViolationNotUnverified|TestSovereigntyNoZoneRefusesEvenWhenTheReadFails';
const UNDECIDED = 'TestUndecidedOnlyWhenOtherwiseAccepted';
const GUARD =
  'TestNoAPIErrorReachesTeardownOrAViolation|TestRemoveRenderedHasThreeSanctionedCallSites|TestReconcileLeavesOnUndecidedBeforeTheAcceptedFork|TestKnativeServiceIsDeletedOnlyInsideRemoveRendered|TestSovereigntyViolationsAreBuiltOnlyWhereSanctioned|TestOnlyNameProblemsAndNotFoundReachADefinitiveVerdict';
const VERDICT_UNIT = 'TestVerdictForAnUndecidedFunctionIsUnverifiedNotAViolation';
const BLIP = 'a rotation that coincides with an apiserver blip keeps the function';
const POSITIVE =
  'TestRunningTemplateViolationNeedsPositiveEvidence|TestIsRefusedRolloutIsOnlyInvalidAndBadRequest|TestAnErrorDerivedBoolGatesTeardownOnlyWithPositiveEvidence|TestRunningCheckAloneToleratesAbsentSecrets';
const REVOKED = 'an unreadable Secret never keeps a revoked one running';
const FORBIDDEN = `${REVOKED} a persistent Forbidden`;
const CRD_REFUSES = `${REVOKED} the CRD refuses a Secret reference that names no Secret`;
const R_CLASSIFY = 'TestClassifyReadError|TestSecretLookupMapsEachReadFailure';
const R_NAMES = 'TestSecretNameProblem|TestInvalidSecretNameIsAViolationNeverUnverified';
const R_RUNNING =
  'TestRunningSecretRefsCoversEverySource|TestCheckRunningSovereigntyRefusesARevokedSecretAndIgnoresNoService';
const R_ESCALATE =
  'TestEscalateDeniedSecretsOnlyAfterTheHold|TestNextDeniedSinceStartsAtTheFirstDenialAndClearsWithIt';
const R_DEFINITIVE =
  'TestOnlyNameProblemsAndNotFoundReachADefinitiveVerdict|TestAFailedReadHasNoDefinitiveState';
const R_GENERATION = 'TestVerdictHoldsTheGenerationWhileUndecided';
const TRANSIENT = 'a transient Secret read error never tears a function down';

const GO_MUTATIONS = [
  // --- the classification ------------------------------------------------------
  {
    id: 'M01',
    claim: 'an unreadable Secret is a sovereignty violation again (the original defect)',
    subject: 'sovereignty',
    anchor:
      'unverified = append(unverified, unverifiedSecret{ref.source, ref.name, m.readErr, m.denied})',
    replacement:
      'out = append(out, sovereigntyViolation{ref.source, ref.name, "unreadable: " + m.readErr})',
    test: unit(`${CLASSIFY}|${GUARD}`),
  },
  {
    id: 'M06',
    claim: 'the Secret lookup drops the read error, so an apiserver blip reads as "unmarked"',
    subject: 'controller',
    anchor:
      'return secretMetadata{readErr: err.Error(), denied: classifyReadError(err) == readDenied}',
    replacement: 'return secretMetadata{}',
    test: envtest(TRANSIENT),
  },
  {
    id: 'M09',
    claim: 'NotFound is read as "no answer", so a deleted Secret never refuses the function',
    subject: 'controller',
    anchor: 'case apierrors.IsNotFound(err):\n\t\t\treturn secretMetadata{}',
    replacement:
      'case apierrors.IsNotFound(err):\n\t\t\treturn secretMetadata{readErr: "not found"}',
    test: envtest(`${TRANSIENT}|the credential allowlist`),
  },
  // --- the exit ------------------------------------------------------------------
  {
    id: 'M02',
    claim: 'Reconcile no longer leaves on an undecided function (it falls into the teardown fork)',
    subject: 'controller',
    anchor:
      'if obs.undecided() {\n\t\t// A Secret lookup that errored (not NotFound) says nothing about the',
    replacement:
      'if false {\n\t\t// A Secret lookup that errored (not NotFound) says nothing about the',
    test: envtest(TRANSIENT),
  },
  {
    id: 'M05',
    claim: 'Reconcile leaves on an undecided function but swallows the held error (no requeue)',
    subject: 'controller',
    anchor: 'return ctrl.Result{}, heldErr',
    replacement: 'return ctrl.Result{}, nil',
    test: envtest(TRANSIENT),
  },
  {
    id: 'M03',
    claim:
      'undecided ignores a definitive refusal (an unreadable neighbour keeps a violator alive)',
    subject: 'verdict',
    anchor: 'return len(o.unverified) > 0 && o.accepted()',
    replacement: 'return len(o.unverified) > 0',
    test: unit(UNDECIDED),
  },
  {
    id: 'M04',
    claim: 'undecided never fires',
    subject: 'verdict',
    anchor: 'return len(o.unverified) > 0 && o.accepted()',
    replacement: 'return false',
    test: envtest(TRANSIENT),
  },
  // --- the status ----------------------------------------------------------------
  {
    id: 'M10',
    claim: 'an undecided pass reports no SecretsUnverified condition (it reads as compliant)',
    subject: 'verdict',
    anchor: 'case o.undecided():\n\t\t// No answer, which is not a violation',
    replacement: 'case o.undecided() && false:\n\t\t// No answer, which is not a violation',
    test: unit(VERDICT_UNIT),
  },
  {
    id: 'M11',
    claim: 'a never-rendered undecided function is rolled up as pending, not SecretsUnverified',
    subject: 'verdict',
    anchor: 'case o.undecided() && o.ksvc == nil:',
    replacement: 'case false:',
    test: unit(VERDICT_UNIT),
  },
  {
    id: 'M12',
    claim: 'an unknown answer is counted as a refusal in the refusals metric',
    subject: 'verdict',
    anchor: ') && ready.Reason != ReasonSecretsUnverified {',
    replacement: ') {',
    test: unit(VERDICT_UNIT),
  },
  // --- (a) the running template is re-checked -----------------------------------
  {
    id: 'A02',
    claim: 'the running-template check finds nothing',
    subject: 'sovereignty',
    anchor: 'return checkSecretRefs(runningSecretRefs(running), bs, zone, others, lookup, true)',
    replacement: 'return nil, nil',
    test: unit(R_RUNNING),
  },
  {
    id: 'A03',
    claim: 'the running-template scan misses Secret volumes',
    subject: 'sovereignty',
    anchor:
      'refs = append(refs, objectRef{fmt.Sprintf("the running Knative Service: volumes[%s].secret", v.Name), v.Secret.SecretName})',
    replacement: '_ = v.Secret',
    test: unit(R_RUNNING),
  },
  // --- (b) a client-side or invalid-name error is definitive --------------------
  {
    id: 'B01',
    claim: 'an invalid Secret name is no longer refused before the lookup',
    subject: 'sovereignty',
    anchor: 'if problem := secretNameProblem(ref.name); problem != "" {',
    replacement: 'if problem := secretNameProblem(ref.name); problem != "" && false {',
    test: unit(R_NAMES),
  },
  {
    id: 'B06',
    claim: 'the CRD admits an empty envFrom Secret name',
    subject: 'crd',
    anchor: 'e.secretRef.name.size() > 0 && e.secretRef.name.size() <= 253))',
    replacement: 'e.secretRef.name.size() >= 0 && e.secretRef.name.size() <= 253))',
    test: envtest(CRD_REFUSES),
  },
  {
    id: 'B07',
    claim: 'the CRD admits an empty secretKeyRef Secret name',
    subject: 'crd',
    anchor: '|| (has(e.valueFrom.secretKeyRef.name) && e.valueFrom.secretKeyRef.name.size()',
    replacement: '|| (true || e.valueFrom.secretKeyRef.name.size()',
    test: envtest(CRD_REFUSES),
  },
  {
    id: 'B08',
    claim: 'the CRD admits an empty Secret volume name',
    subject: 'crd',
    anchor: "> 0 && self.secret.secretName.size() <= 253)'",
    replacement: ">= 0 && self.secret.secretName.size() <= 253)'",
    test: envtest(CRD_REFUSES),
  },
  {
    id: 'B09',
    claim: 'the CRD admits an empty projected Secret name',
    subject: 'crd',
    anchor: 'self.secret.name.size() > 0 && self.secret.name.size()',
    replacement: 'self.secret.name.size() >= 0 && self.secret.name.size()',
    test: envtest(CRD_REFUSES),
  },
  // --- (c) a persistent Forbidden is not held forever ---------------------------
  {
    id: 'A01',
    claim: 'the running Knative Service is never re-checked (a revoked Secret stays mounted)',
    subject: 'controller',
    anchor:
      'runViolations, runUnverified := checkRunningSovereignty(bs, obs.zone, others, lookup, running)',
    replacement:
      'runViolations, runUnverified := []sovereigntyViolation(nil), []unverifiedSecret(nil)',
    test: envtest(`${REVOKED} tears down a running function whose Secret was revoked`),
  },
  {
    id: 'A05',
    claim:
      'the running template is acted on even when the spec rolls out (a routine Secret rotation tears a healthy function down)',
    subject: 'controller',
    anchor: 'if obs.undecided() {\n\t\tobs.violations = append(obs.violations, runViolations...)',
    replacement: 'if true {\n\t\tobs.violations = append(obs.violations, runViolations...)',
    test: envtest(
      `${REVOKED} (rolls a routine Secret rotation out in place|replaces a revoked Secret in place)`,
    ),
  },
  {
    id: 'A06',
    claim:
      'a running-template violation tears the function down after a rollout that SUCCEEDED, not only when it fails',
    subject: 'controller',
    anchor: 'stuckOnRevoked := isRefusedRollout(rollErr) && len(runViolations) > 0',
    replacement: 'stuckOnRevoked := len(runViolations) > 0',
    test: envtest(
      `${REVOKED} (rolls a routine Secret rotation out in place|replaces a revoked Secret in place)`,
    ),
  },
  {
    id: 'A07',
    claim:
      'a NotFound Secret in the RUNNING template counts as a violation again (a pruned old version tears a healthy function down)',
    subject: 'sovereignty',
    anchor: 'if absentIsRotation && !m.found {',
    replacement: 'if absentIsRotation && !m.found && false {',
    test: envtest(`${BLIP} keeps the function and requeues on a 503 reading the NEW Secret`),
  },
  {
    id: 'A08',
    claim:
      'ANY rollout error tears the function down, with no definitive refusal and no evidence required (a 503, a 409, a JWKS read blip)',
    subject: 'controller',
    anchor: 'stuckOnRevoked := isRefusedRollout(rollErr) && len(runViolations) > 0',
    replacement: 'stuckOnRevoked := rollErr != nil',
    test: envtest(BLIP),
  },
  {
    id: 'A09',
    claim: 'every non-nil rollout error is read as a definitive refusal',
    subject: 'controller',
    anchor: 'return apierrors.IsInvalid(err) || apierrors.IsBadRequest(err)',
    replacement: 'return err != nil',
    test: envtest(`${BLIP} holds a REVOKED running Secret`),
  },
  {
    id: 'A10',
    claim: 'a Forbidden on the update counts as a definitive refusal',
    subject: 'controller',
    anchor: 'return apierrors.IsInvalid(err) || apierrors.IsBadRequest(err)',
    replacement:
      'return apierrors.IsInvalid(err) || apierrors.IsBadRequest(err) || apierrors.IsForbidden(err)',
    test: unit(POSITIVE),
  },
  {
    id: 'A11',
    claim:
      'the teardown gate drops the positive-evidence requirement (the guard pins the exact expression)',
    subject: 'controller',
    anchor: 'stuckOnRevoked := isRefusedRollout(rollErr) && len(runViolations) > 0',
    replacement: 'stuckOnRevoked := isRefusedRollout(rollErr)',
    test: unit(POSITIVE),
  },
  {
    id: 'A04',
    claim:
      'the running Knative Service is re-checked only when the spec is undecided (a decided pass whose render is refused keeps a revoked Secret)',
    subject: 'controller',
    anchor:
      'runViolations, runUnverified := checkRunningSovereignty(bs, obs.zone, others, lookup, running)',
    replacement:
      'runViolations, runUnverified := func() ([]sovereigntyViolation, []unverifiedSecret) {\n\t\tif len(obs.unverified) == 0 {\n\t\t\treturn nil, nil\n\t\t}\n\t\treturn checkRunningSovereignty(bs, obs.zone, others, lookup, running)\n\t}()',
    test: envtest(
      `${REVOKED} tears down a running function whose Secret was revoked even when the new spec cannot be rolled out`,
    ),
  },
  {
    id: 'B02',
    claim: 'every unrecognised read error is read as a denial',
    subject: 'controller',
    anchor: '\treturn readTransient\n}',
    replacement: '\treturn readDenied\n}',
    test: unit(R_CLASSIFY),
  },
  {
    id: 'B03',
    claim: 'a 401 is no longer a denial (it is held without limit)',
    subject: 'controller',
    anchor: 'if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {',
    replacement: 'if apierrors.IsForbidden(err) {',
    test: unit(R_CLASSIFY),
  },
  {
    id: 'B04',
    claim: 'a failed read gains a definitive state of its own again',
    subject: 'sovereignty',
    anchor: '\tdenied bool\n}\n\n// unverifiedSecret is',
    replacement: '\tdenied bool\n\trejected string\n}\n\n// unverifiedSecret is',
    test: unit(R_DEFINITIVE),
  },
  {
    id: 'E01',
    claim: 'the CRD admits the root path and its slash/dot spellings (/, //, /./)',
    subject: 'crd',
    anchor:
      "rule: '!self.mountPath.matches(''^((/+[.])*/*|(/+[.])*/+dev(/+[.])*/*|(/+[.])*/+dev(/+[.])*/+log(/+[.])*/*)$'')'",
    replacement:
      "rule: '!self.mountPath.matches(''^((/+[.])*zz|(/+[.])*/+dev(/+[.])*/*|(/+[.])*/+dev(/+[.])*/+log(/+[.])*/*)$'')'",
    test: envtest(`${REVOKED} the CRD refuses a mount path Knative serving reserves`),
  },
  {
    id: 'E02',
    claim: 'the CRD admits /dev/log and its spellings',
    subject: 'crd',
    anchor:
      "rule: '!self.mountPath.matches(''^((/+[.])*/*|(/+[.])*/+dev(/+[.])*/*|(/+[.])*/+dev(/+[.])*/+log(/+[.])*/*)$'')'",
    replacement:
      "rule: '!self.mountPath.matches(''^((/+[.])*/*|(/+[.])*/+dev(/+[.])*/*|(/+[.])*/+dev(/+[.])*/+zzz(/+[.])*/*)$'')'",
    test: envtest(`${REVOKED} the CRD refuses a mount path Knative serving reserves`),
  },
  {
    id: 'E03',
    claim: 'the CRD admits /dev and its spellings (/dev/, //dev, /./dev)',
    subject: 'crd',
    anchor:
      "rule: '!self.mountPath.matches(''^((/+[.])*/*|(/+[.])*/+dev(/+[.])*/*|(/+[.])*/+dev(/+[.])*/+log(/+[.])*/*)$'')'",
    replacement:
      "rule: '!self.mountPath.matches(''^((/+[.])*/*|(/+[.])*/+zzz(/+[.])*/*|(/+[.])*/+dev(/+[.])*/+log(/+[.])*/*)$'')'",
    test: envtest(`${REVOKED} the CRD refuses a mount path Knative serving reserves`),
  },
  {
    id: 'C01',
    claim: 'a denied read is held forever (never escalated)',
    subject: 'controller',
    anchor:
      'obs.violations, obs.unverified = escalateDeniedSecrets(obs.violations, obs.unverified, obs.deniedSince, now)',
    replacement:
      '_, _ = escalateDeniedSecrets(obs.violations, obs.unverified, obs.deniedSince, now)',
    test: envtest(FORBIDDEN),
  },
  {
    id: 'C04',
    claim: 'the hold ignores the clock (escalates as soon as a denial exists)',
    subject: 'verdict',
    anchor: 'if deniedSince == nil || now.Sub(deniedSince.Time) < secretsDeniedHold {',
    replacement: 'if deniedSince == nil {',
    test: unit(R_ESCALATE),
  },
  {
    id: 'C05',
    claim: 'a transient error starts the denial clock',
    subject: 'controller',
    anchor: 'nextDeniedSince(bs.Status.SecretsDeniedSince, hasDenied(obs.unverified), now)',
    replacement: 'nextDeniedSince(bs.Status.SecretsDeniedSince, len(obs.unverified) > 0, now)',
    test: envtest(FORBIDDEN),
  },
  {
    id: 'C06',
    claim: 'the denial clock restarts on every pass (the hold never runs out)',
    subject: 'verdict',
    anchor: 'case prev != nil:\n\t\treturn prev',
    replacement: 'case prev != nil:\n\t\treturn &metav1.Time{Time: now}',
    test: unit(R_ESCALATE),
  },
  {
    id: 'C07',
    claim: 'the denial clock is not cleared when no read is denied',
    subject: 'verdict',
    anchor: 'case !denied:\n\t\treturn nil',
    replacement: 'case !denied:\n\t\treturn prev',
    test: envtest(FORBIDDEN),
  },
  {
    id: 'C02',
    claim: 'the hold is zero (a first denied read tears the function down)',
    subject: 'verdict',
    anchor: 'secretsDeniedHold = 10 * time.Minute',
    replacement: 'secretsDeniedHold = 0 * time.Minute',
    test: envtest(FORBIDDEN),
  },
  {
    id: 'C03',
    claim: 'a TRANSIENT error is escalated too (a long blip tears the function down)',
    subject: 'verdict',
    anchor: 'if !u.denied {',
    replacement: 'if false {',
    test: unit(R_ESCALATE),
  },
  // --- the status of a spec that was not rolled out -----------------------------
  {
    id: 'D01',
    claim: 'an undecided pass advances observedGeneration',
    subject: 'verdict',
    anchor: 'v.observedGeneration = bs.Status.ObservedGeneration',
    replacement: 'v.observedGeneration = gen',
    test: unit(R_GENERATION),
  },
  {
    id: 'D02',
    claim: 'a spec that could not be verified keeps the old Service Ready',
    subject: 'verdict',
    anchor: 'case o.undecided() && bs.Generation != bs.Status.ObservedGeneration:',
    replacement: 'case false:',
    test: envtest(`${REVOKED} a spec change that cannot be verified`),
  },
  // --- the guard (G4, G5) ---------------------------------------------------------
  {
    id: 'M13',
    claim: 'a direct Delete of the Knative Service outside removeRendered',
    subject: 'controller',
    anchor: 'heldErr = unverifiedSecretsError(obs.unverified)',
    replacement:
      'heldErr = unverifiedSecretsError(obs.unverified)\n\t\t_ = r.Delete(ctx, &servingv1.Service{ObjectMeta: metav1.ObjectMeta{Name: bs.Name, Namespace: bs.Namespace}})',
    test: unit(GUARD),
  },
  {
    id: 'M14',
    claim: 'a violation is built in a helper outside the sanctioned functions',
    subject: 'controller',
    anchor: 'func mergeUnverified(a, b []unverifiedSecret) []unverifiedSecret {',
    replacement:
      'func mergeUnverified(a, b []unverifiedSecret) []unverifiedSecret {\n\t_ = sovereigntyViolation{}',
    test: unit(GUARD),
  },
  // --- the scan ------------------------------------------------------------------
  {
    id: 'M07',
    claim: 'a new path tears the function down on an API error (zone list fails -> removeRendered)',
    subject: 'controller',
    anchor: 'if err := r.List(ctx, &zones, client.InNamespace(bs.Namespace)); err != nil {',
    replacement:
      'if err := r.List(ctx, &zones, client.InNamespace(bs.Namespace)); err != nil {\n\t\t_ = r.removeRendered(ctx, bs)',
    test: unit(GUARD),
  },
  {
    id: 'M08',
    claim: 'removeRendered is reached from outside the two sanctioned forks',
    subject: 'controller',
    anchor: 'served, revision := bs.Status.ServedProtoVersion, bs.Status.ObservedRevision',
    replacement:
      'if len(obs.lint) > 0 {\n\t\t_ = r.removeRendered(ctx, bs)\n\t}\n\tserved, revision := bs.Status.ServedProtoVersion, bs.Status.ObservedRevision',
    test: unit(GUARD),
  },
];

// A mutation that changes NOTHING about behaviour (the same conjunction, its
// operands swapped): every guard must stay green. A runner that exits non-zero
// for any mutation at all would otherwise certify the whole table.
const NEUTRAL = {
  id: 'N01',
  claim: 'control: the same conjunction with its operands swapped changes nothing',
  subject: 'verdict',
  anchor: 'return len(o.unverified) > 0 && o.accepted()',
  replacement: 'return o.accepted() && len(o.unverified) > 0',
  test: unit(`${CLASSIFY}|${UNDECIDED}|${GUARD}`),
};

// --- the go driver ---------------------------------------------------------

function envtestAssetsPresent() {
  if (process.env.KUBEBUILDER_ASSETS) return true;
  const dir = `${OPERATOR_MODULE}/bin/k8s`;
  return existsSync(dir) && readdirSync(dir).length > 0;
}

function run(bin, args, { showErrors = false } = {}) {
  const r = spawnSync(bin, args, {
    cwd: OPERATOR_MODULE,
    // stderr is kept ONLY to explain a failed build check to a human; no
    // verdict ever reads it (verdicts are exit codes).
    stdio: ['ignore', 'ignore', showErrors ? 'pipe' : 'ignore'],
    env: { ...process.env, KNEXT_REQUIRE_BUNDLE: '1' },
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
const guardExit = (test) => run('go', ['test', '-count=1', ...test.args]);

/** The mutated tree must still COMPILE its tests, or the row proves nothing. */
const buildsExit = () => run('go', ['test', '-count=1', '-run', '^$', PKG], { showErrors: true });

/** Plant one mutation, return the guard's exit code; the subject is restored either way. */
function grade(m) {
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
  return code;
}

// --- main ---------------------------------------------------------------------

declareMutations(GO_MUTATIONS.length);
console.log(`${NAME}: ${GO_MUTATIONS.length} mutations declared (+ canary and neutral control)`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of [...GO_MUTATIONS, NEUTRAL]) {
  const count =
    snapshot(PROVER.subjects[m.subject]).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `${NAME}: ${m.id}'s anchor occurs ${count} times in ${PROVER.subjects[m.subject]}; aborting`,
    );
    process.exit(2);
  }
}
if (!envtestAssetsPresent()) {
  console.error(
    `${NAME}: no envtest binaries (set KUBEBUILDER_ASSETS or run \`make setup-envtest\` in packages/kn-next-operator)`,
  );
  process.exit(2);
}

// Green baseline on a clean tree, for every distinct guard.
assertTreeClean(REPO_ROOT, 'baseline');
const seen = new Set();
for (const m of [...GO_MUTATIONS, NEUTRAL]) {
  const key = JSON.stringify(m.test);
  if (seen.has(key)) continue;
  seen.add(key);
  const code = guardExit(m.test);
  if (code !== 0) {
    console.error(`${NAME}: baseline RED for ${m.id}'s guard (exit ${code}); fix the tree first`);
    process.exit(2);
  }
}
console.log(`${NAME}: operator baseline green (${seen.size} distinct guards)`);

// STEP 0: the harness can SEE red. A real mutation of a real subject, graded by
// the same runner: if it stays green, nothing below means anything.
const canary = grade({ ...GO_MUTATIONS[0], id: 'canary' });
if (canary === 0) {
  console.error(
    `${NAME}: the canary mutation left the guard GREEN; the harness cannot observe red`,
  );
  process.exit(2);
}
console.log(`step 0 ok: the harness sees red (canary exit=${canary})`);

// The neutral control must stay green.
const neutral = grade(NEUTRAL);
if (neutral !== 0) {
  console.error(
    `${NAME}: the neutral control went RED (exit ${neutral}); the runner is not trustworthy`,
  );
  process.exit(2);
}
console.log(`control ok: ${NEUTRAL.id} stays green — ${NEUTRAL.claim}`);

let failed = 0;
for (const m of GO_MUTATIONS) {
  const code = grade(m);
  recordMutation();
  const ok = code !== 0;
  if (!ok) failed++;
  console.log(`${ok ? 'KILLED   ' : '*** SURVIVED ***'} ${m.id} exit=${code} — ${m.claim}`);
}

console.log(
  `${NAME}: ${GO_MUTATIONS.length - failed}/${GO_MUTATIONS.length} rows went red as required`,
);
process.exit(failed === 0 ? 0 : 1);
