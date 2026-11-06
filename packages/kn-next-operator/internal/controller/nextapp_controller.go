/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
	"knative.dev/pkg/apis"
	"knative.dev/serving/pkg/apis/serving"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	servingv1beta1 "knative.dev/serving/pkg/apis/serving/v1beta1"
)

// Condition type constants used across the reconciler.
const (
	// ConditionReconciling indicates the operator is actively reconciling the resource.
	ConditionReconciling = "Reconciling"
	// ConditionReady indicates the NextApp Knative Service is available.
	ConditionReady = "Ready"
	// ConditionDegraded indicates the reconciliation failed or the resource is unhealthy.
	ConditionDegraded = "Degraded"
	// ConditionRevalidationDeferred indicates that Kafka-based ISR revalidation was
	// requested (spec.revalidation.queue == "kafka") but the operator did NOT
	// provision a KafkaSource because the `{app}-revalidator` consumer is not yet
	// built (issue #95) and opt-in (spec.revalidation.provisionKafkaSource) is off.
	// It is informational/non-fatal — Ready stays True.
	ConditionRevalidationDeferred = "RevalidationDeferred"
	// ConditionEnvMapCollision indicates one or more spec.secrets.envMap
	// entries collide with an operator-injected system env var (HOSTNAME,
	// NODE_ENV, STORAGE_PROVIDER, ...). Before #1288 such an entry was
	// silently appended a second time — kubelet's last-wins duplicate-env
	// semantics decided which value actually reached the container, with no
	// signal that it happened. Admission REJECTS any NEW such collision
	// (#1391), EXCEPT validation.EnvMapUserAlwaysWinsEnvNames (connection-
	// string names — REDIS_URL, KAFKA_BROKER_URL, OTEL_EXPORTER_OTLP_ENDPOINT
	// — which have no secretRef field today and would otherwise force a
	// credential into the CR in plaintext to pass admission). So this
	// condition fires for two DIFFERENT reasons, and neither implies the
	// other: a CR reconciling with a collision the webhook would now reject
	// (predates the rule, or reconciled while the webhook was unavailable —
	// never assume "predates" is the only path), or an always-exempt
	// connection-string name on ANY CR, new or old. Informational/non-fatal —
	// Ready stays True. Resolution differs by name: for
	// validation.OperatorAlwaysWinsEnvNames (HOSTNAME) the operator's own
	// value always wins; for every other reserved name the envMap value WINS
	// instead, preserving the value the app was actually getting before
	// #1288 (kubelet's real last-wins semantics already favored envMap
	// there) rather than silently swapping it for the operator's default.
	ConditionEnvMapCollision = "EnvMapCollision"
)

// ksvcNotReadyRequeueAfter bounds how often the reconciler re-checks a child
// Knative Service that has not yet reported Ready. The Owns(ksvc) watch handles
// most transitions, but a bounded periodic requeue guarantees NextApp status
// converges toward the ksvc's real health even if a status event is missed.
const ksvcNotReadyRequeueAfter = 30 * time.Second

// imagePrewarmFailureRequeueAfter bounds the retry of a FAILED image-prewarm
// DaemonSet reconcile (#471 item 4). Because that failure no longer returns out
// of Reconcile, controller-runtime's error backoff no longer retries it — this
// requeue is the ONLY thing that does. It is deliberately looser than
// ksvcNotReadyRequeueAfter: the app is healthy, only an opt-in cold-start
// optimisation is not, and the usual cause (missing DaemonSet RBAC) needs
// operator action rather than fast polling.
const imagePrewarmFailureRequeueAfter = 2 * time.Minute

// Ingress-programming stall detection (#208). When the cluster's configured
// ingress-class matches NO installed ingress controller (e.g. the short-form
// drift `kourier.knative.dev` vs the class net-kourier actually serves), Knative
// Serving leaves the Route's KIngress unreconciled FOREVER — no error, only an
// Unknown `IngressNotConfigured` condition on the ksvc ("Ingress has not yet
// been reconciled."). That reads as "wait longer", which is exactly the silent
// trap. After a bounded window we call it a stall and surface it loudly.
const (
	// ingressProgrammingStallWindow is how long IngressNotConfigured may persist
	// before the operator flags it as a misconfiguration rather than startup
	// latency. Real ingress programming completes in seconds; two minutes is far
	// past any healthy path while still tolerating slow controller cold starts.
	ingressProgrammingStallWindow = 2 * time.Minute

	// ksvcIngressNotConfiguredReason is the exact reason Knative Serving's route
	// lifecycle sets when no ingress controller has reconciled the KIngress
	// (serving/pkg/apis/serving/v1/route_lifecycle.go MarkIngressNotConfigured).
	ksvcIngressNotConfiguredReason = "IngressNotConfigured"

	// kourierServedIngressClass is the class net-kourier's reconciler actually
	// filters on (net-kourier pkg/reconciler/ingress/config/config.go
	// KourierIngressClassName). NOT the short `kourier.knative.dev` form.
	kourierServedIngressClass = "kourier.ingress.networking.knative.dev"
)

// Event reason constants — concise, stable strings surfaced via `kubectl describe nextapp`.
const (
	// ReasonInvalidImage marks a NextApp rejected for failing digest-pinning (e.g. :latest).
	ReasonInvalidImage = "InvalidImage"
	// ReasonInvalidSpec marks a NextApp rejected for any OTHER spec validation
	// failure (resources, scaling, connection budget, ...). An image that fails
	// digest pinning keeps ReasonInvalidImage.
	ReasonInvalidSpec = "InvalidSpec"
	// ReasonReconcileFailed marks a generic reconcile error (API error, child create/update failure).
	ReasonReconcileFailed = "ReconcileFailed"
	// ReasonReconciled marks a successful reconcile.
	ReasonReconciled = "Reconciled"
	// ReasonCleanupFailed marks a best-effort external cleanup (object-store /
	// Redis) that failed during finalization but did not block CR deletion.
	ReasonCleanupFailed = "CleanupFailed"
	// ReasonEnvVarIgnored marks a spec.env entry dropped because its name is
	// already claimed by operator-managed system env or spec.secrets.envMap
	// (#186). Warning, not error: the reconcile proceeds, but the user must be
	// able to see via `kubectl describe nextapp` why their flag didn't land.
	ReasonEnvVarIgnored = "EnvVarIgnored"
	// ReasonEnvMapUserOverride marks a spec.secrets.envMap entry that
	// collides with an operator-managed reserved env name AND the envMap
	// value WINS (see ConditionEnvMapCollision's doc comment for why the
	// direction differs from ReasonEnvVarIgnored/DATABASE_URL). Deliberately
	// NEUTRAL wording (#1391 round 2), not "grandfathered": the collision
	// reaching the reconciler does not always mean the CR predates admission
	// rejection — it also covers EnvMapUserAlwaysWinsEnvNames (connection-
	// string names exempt from rejection entirely) and a CR that reconciled
	// while the validating webhook was unavailable. Labelling either of those
	// "grandfathered" would misleadingly imply a legacy-only condition.
	ReasonEnvMapUserOverride = "EnvMapUserOverride"
	// ReasonEnvMapExpectedOverride marks an EnvMapCollision condition whose
	// ONLY member is validation.EnvMapUserAlwaysWinsEnvNames (connection-
	// string names) — the documented, sanctioned pattern for a value the CRD
	// has no typed `*SecretRef` field for yet. computeStatusVerdict emits a
	// Normal event (not Warning) and this reason for that case, so the
	// documented pattern doesn't train users to ignore Warnings on this
	// condition (#1391 round 3). If any real collision (operatorWins or
	// userWinsGrandfathered) also fires alongside it, the reason/event
	// upgrade to the alarm-worthy ones instead — this reason is reserved for
	// the exempt-only case.
	ReasonEnvMapExpectedOverride = "EnvMapExpectedOverride"
	// ReasonIngressNotProgrammed marks a NextApp whose route has sat in
	// IngressNotConfigured past the stall window — i.e. NO ingress controller
	// reconciles the cluster's configured ingress-class, so the app will never
	// become reachable without operator action (#208).
	ReasonIngressNotProgrammed = "IngressNotProgrammed"
	// ReasonPinnedRevisionNotFound marks a NextApp whose spec.traffic.revisionName
	// pins a Knative Revision that no longer exists (e.g. GC'd), so the declared
	// rollback/canary can never resolve — Knative keeps serving the last-good
	// route with only an opaque RevisionMissing condition (ADR-0014 follow-up).
	ReasonPinnedRevisionNotFound = "PinnedRevisionNotFound"
	// ReasonImagePrewarmFailed marks a failure to reconcile (or, when the feature
	// is turned off, to delete) the opt-in image-prewarm DaemonSet — typically
	// missing DaemonSet RBAC. It is a WARNING event only: the failure degrades
	// ImageCacheReady and nothing else, so an opt-in cold-start optimisation
	// never blocks the app's status convergence (#471, ADR-0037).
	ReasonImagePrewarmFailed = "ImagePrewarmFailed"
	// ReasonProvisionKafkaSourceInert marks a NextApp that sets
	// spec.revalidation.provisionKafkaSource=true, which the operator IGNORES
	// (#475). The BYO external-consumer path that flag opted into is WITHDRAWN:
	// the sink contract (a Knative Service named `{app}-revalidator` consuming
	// the revalidation CloudEvents) was never specified or tested, so honouring
	// the flag would create a source pointing at a Service that may never exist.
	// The field still applies — rejecting it would narrow v1alpha1 in place
	// (ADR-0017 §2.1) and, on the shared fail-closed validation path, stop the
	// whole app from reconciling — so the withdrawal is surfaced as this
	// non-fatal condition reason + a Warning event instead.
	ReasonProvisionKafkaSourceInert = "ProvisionKafkaSourceInert"
)

// pinnedRevisionStallWindow is how long the child ksvc's RoutesReady/Ready
// condition may sit non-True (per Knative's own lastTransitionTime) before a
// NotFound pinned revision is judged a real ghost pin rather than a normal
// deploy window still creating the revision. Stateless by design: the window
// derives from Knative condition timestamps, never from in-memory grace passes
// or annotations, so it survives operator restarts and leader failover.
const pinnedRevisionStallWindow = 2 * time.Minute

// pinnedRevisionMissingStalled reports whether a pinned-but-NotFound revision
// should be surfaced as PinnedRevisionNotFound. revisionNotFound is the result
// of the operator's own authoritative Revision GET (true only on a real
// apierrors.IsNotFound — transient errors must not reach here as true). The
// race guard: fire only when, additionally, the ksvc's RoutesReady (or, as a
// fallback, rolled-up Ready) condition has been non-True for at least
// pinnedRevisionStallWindow. A fresh transition (deploy in progress) or a
// still-True route (Knative hasn't reacted to the pin yet) is NOT a stall.
// Unlike ingressProgrammingStalled this is deliberately reason-agnostic: the
// NotFound GET is the primary signal; the condition age is only the
// progress/race guard.
func pinnedRevisionMissingStalled(revisionNotFound bool, ksvc *servingv1.Service, now time.Time) (time.Duration, bool) {
	if !revisionNotFound {
		return 0, false
	}
	for _, condType := range []apis.ConditionType{
		servingv1.ServiceConditionRoutesReady,
		servingv1.ServiceConditionReady,
	} {
		cond := ksvc.Status.GetCondition(condType)
		if cond == nil || cond.IsTrue() {
			continue
		}
		if cond.LastTransitionTime.Inner.IsZero() {
			continue
		}
		if elapsed := now.Sub(cond.LastTransitionTime.Inner.Time); elapsed >= pinnedRevisionStallWindow {
			return elapsed, true
		}
	}
	return 0, false
}

// NextAppReconciler reconciles a NextApp object
type NextAppReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// APIReader is an uncached reader used for the rare per-DomainMapping Get of
	// a core Service (PrivateExposure detection), so that does not start a
	// cluster-wide Service informer. Falls back to the cached Client when nil.
	APIReader client.Reader
	// Recorder emits Kubernetes Events attached to the NextApp so operators can see
	// reconcile transitions via `kubectl describe`. May be nil in unit tests.
	Recorder record.EventRecorder
	// Cleaner clears the app's EXTERNAL state (object-store prefix + Redis
	// keyspace) during finalization. Injectable so unit tests can assert the
	// exact scoped delete and the cross-app safety guard. May be nil (skips
	// external cleanup) for unit tests of unrelated paths.
	Cleaner ExternalCleaner
	// Clock returns the current time; injectable so tests can pin "now" to
	// exercise the scheduled warm-floor window evaluation (ADR-0030, #380)
	// deterministically. nil => time.Now (production).
	Clock func() time.Time
	// PlatformCRDPresent reports whether the KnextPlatform CRD is installed. It is
	// set once at start-up from discovery (SetupWithManager) and, when false, the
	// reconciler never touches the platform kind at all: it renders the built-in
	// defaults and reports PlatformDefaultsApplied=NoPlatformCRD (ADR-0064 D3).
	// The zero value is "not installed", so a reconciler built without the platform
	// layer behaves exactly as before it existed.
	PlatformCRDPresent bool
	// BackendServiceCRDPresent reports whether the BackendService CRD is installed
	// (zone functions, ADR-0004). Set once at start-up from discovery
	// (SetupControllers). When false the reconciler never reads the kind: a zone
	// with spec.backends reports BackendBindings=BackendServiceCRDMissing and
	// renders no binding env. The zero value is "not installed".
	BackendServiceCRDPresent bool
	// ZoneSigningKey tunes the zone signing-key rotation (zone_signing_key.go).
	// The zero value is the contract's defaults: a 120 s propagation bound and
	// no scheduled rotation.
	ZoneSigningKey ZoneSigningKeyConfig
	// rollout paces platform-triggered re-renders (ADR-0064 F2). Zero value ready.
	rollout rolloutLimiter
	// held remembers which apps are held, for the fleet metrics. Zero value ready.
	held heldTracker
}

// now returns the reconciler's clock (test-injectable), defaulting to time.Now.
func (r *NextAppReconciler) now() time.Time {
	if r.Clock != nil {
		return r.Clock()
	}
	return time.Now()
}

// ingressProgrammingStalled reports whether the child Knative Service's route
// has been waiting on an unreconciled KIngress (reason IngressNotConfigured)
// for longer than ingressProgrammingStallWindow. It checks RoutesReady first
// (the condition that directly carries the ingress state) and falls back to the
// rolled-up Ready condition. Deliberately narrow: it does NOT try to discover
// which ingress controllers are installed or what class they serve — it only
// converts Knative's indefinitely-pending state into a bounded, loud signal.
func ingressProgrammingStalled(ksvc *servingv1.Service, now time.Time) (time.Duration, bool) {
	for _, condType := range []apis.ConditionType{
		servingv1.ServiceConditionRoutesReady,
		servingv1.ServiceConditionReady,
	} {
		cond := ksvc.Status.GetCondition(condType)
		if cond == nil || cond.IsTrue() || cond.Reason != ksvcIngressNotConfiguredReason {
			continue
		}
		if cond.LastTransitionTime.Inner.IsZero() {
			continue
		}
		if elapsed := now.Sub(cond.LastTransitionTime.Inner.Time); elapsed >= ingressProgrammingStallWindow {
			return elapsed, true
		}
	}
	return 0, false
}

// emitEvent records a Kubernetes Event on the NextApp when a recorder is wired.
func (r *NextAppReconciler) emitEvent(obj runtime.Object, eventType, reason, message string) {
	if r.Recorder != nil {
		r.Recorder.Event(obj, eventType, reason, message)
	}
}

// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=nextapps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=nextapps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=nextapps/finalizers,verbs=update
// The cluster-scoped platform config (ADR-0064): READ-ONLY for the NextApp
// reconciler, which only merges it. The status subresource is written by the
// platform's own reconciler (platform_controller.go), never the spec.
// +kubebuilder:rbac:groups=platform.kn-next.dev,resources=knextplatforms,verbs=get;list;watch
// +kubebuilder:rbac:groups=platform.kn-next.dev,resources=knextplatforms/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=serving.knative.dev,resources=services,verbs=get;list;watch;create;update;patch;delete
// Revisions: READ-ONLY — the reconciler GETs the spec.traffic.revisionName pin to
// surface a GC'd revision as PinnedRevisionNotFound (ADR-0014). Never written.
// +kubebuilder:rbac:groups=serving.knative.dev,resources=revisions,verbs=get;list;watch
// +kubebuilder:rbac:groups=serving.knative.dev,resources=domainmappings,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=services,verbs=get
// +kubebuilder:rbac:groups=serving.knative.dev,resources=routes,verbs=get
// Deployments: GET-only (uncached APIReader) to re-confirm an admission rejection is still
// in force after Knative flips the revision reason to ProgressDeadlineExceeded (PodCreationBlocked).
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get
// +kubebuilder:rbac:groups=apps,resources=daemonsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=caching.internal.knative.dev,resources=images,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=sources.knative.dev,resources=kafkasources,verbs=get;list;watch;create;update;patch;delete
// Warm-schedule (ADR-0030, #380) needs NO extra RBAC: the operator is the SINGLE
// writer of the ksvc min-scale annotation (folded into the ksvc it already
// manages via serving.knative.dev/services above). No CronJobs, no patcher
// Role/RoleBinding — the earlier CronJob approach (which needed batch/cronjobs +
// rbac roles/rolebindings) was replaced because an external writer raced the
// operator and got reverted every reconcile.
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// Secrets: the NextApp reconciler touches exactly ONE Secret per zone, the zone's
// own signing key (<zone>-knext-signing-key, zone_signing_key_reconcile.go, which
// carries the get;create;update marker and the reasoning), and only while the zone
// has a two-sided function binding. Nothing else: the managed-database mode that
// mirrored a DSN Secret was removed (ADR-0025); spec.secrets.envFrom/envMap and
// image-pull secrets are only NAME REFERENCES the kubelet resolves on the app
// pod's behalf; webhook/metrics certs are mounted volumes. The BackendService
// reconciler's get is metadata-only (the zone-function credential allowlist). No
// list, watch, patch or delete: a list/watch Secrets rule would let a compromised
// operator read every Secret in the cluster. rbac_secrets_guard_test.go fails if
// a Secrets marker or role rule appears without a justified allowlist entry.
// PersistentVolumeClaims: read-only. The controller-runtime cache watches
// *v1.PersistentVolumeClaim (found live on EKS, #306/#1062); without a
// cluster-scoped list/watch grant the manager's informer logs repeated
// `persistentvolumeclaims is forbidden` errors. The operator no longer CREATES
// PVCs (the PVC-backed bytecode cache was removed, ADR-0035), so this is
// get;list;watch only — no create/update/delete — least privilege.
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch

func (r *NextAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (result ctrl.Result, retErr error) { //nolint:gocyclo // long branch-per-condition orchestrator; splitting is tracked debt, new functions stay under the limit
	logger := logf.FromContext(ctx)

	// Observe reconcile duration and tally the result on every return path.
	start := time.Now()
	defer func() {
		reconcileDuration.Observe(time.Since(start).Seconds())
		if retErr != nil {
			reconcileTotal.WithLabelValues("error").Inc()
			reconcileErrors.Inc()
		} else {
			reconcileTotal.WithLabelValues("success").Inc()
		}
	}()

	var nextApp appsv1alpha1.NextApp
	if err := r.Get(ctx, req.NamespacedName, &nextApp); err != nil {
		if errors.IsNotFound(err) {
			r.held.forget(req.NamespacedName)
			r.rollout.release(req.NamespacedName)
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Snapshot the OBSERVED status so the terminal status write can be skipped
	// when the freshly-computed desired status is byte-identical (#98). Writing
	// status on every pass re-triggers the For(&NextApp{}) watch → a ~45/s
	// self-perpetuating reconcile hot-loop on an idle object. apimeta.
	// SetStatusCondition preserves LastTransitionTime when a condition is
	// unchanged, so this DeepEqual is stable for a converged, idle object.
	observedStatus := nextApp.Status.DeepCopy()

	// --- Finalizer: external-state teardown -------------------------------
	// The finalizer pauses Kubernetes deletion until the operator clears the
	// app's EXTERNAL state (object-store prefix + Redis keyspace) — state that
	// has no ownerRef and would otherwise leak across deploy/delete cycles.
	// In-cluster children (ksvc/SA) keep using ownerRef GC.
	if deleting, err := r.reconcileFinalizers(ctx, &nextApp); err != nil || deleting {
		if deleting {
			// A terminating app is no longer held by anything; do not let a
			// stale hold keep it on the held-apps gauge.
			r.held.forget(req.NamespacedName)
			r.rollout.release(req.NamespacedName)
		}
		// Nothing more to reconcile for a deleting object.
		return ctrl.Result{}, err
	}

	// NOTE (#98): we intentionally do NOT write an eager Reconciling=True status
	// here. That mid-pass write re-triggered this controller's own watch and was
	// the primary driver of the idle hot-loop. The full desired status (including
	// Reconciling=False on success) is computed in-memory below and written ONCE,
	// only when it actually differs from the observed status.

	// Validate the full spec using the SAME function the admission webhook calls
	// (internal/validation.ValidateNextAppSpec) so the two cannot drift. This
	// enforces digest pinning (rejects :latest / tag-only refs), required image,
	// non-negative scaling, MinScale <= MaxScale, and recognized provider/queue
	// enums. The webhook rejects these at write time; the reconciler stays
	// fail-closed as defense-in-depth for CRs that predate the webhook.
	//
	// Platform layer (ADR-0064): load the singleton KnextPlatform and merge it UNDER
	// the app's own fields and OVER the built-ins. With no platform this resolves to
	// the built-in table and the whole block below is inert. The effective budget is
	// the platform's database.connectionBudget when it set one.
	snap, platErr := r.loadPlatform(ctx)
	if platErr != nil {
		return ctrl.Result{}, platErr
	}
	eff := resolveEffective(&nextApp, snap.active())
	// A spec that is valid under the built-in budget but not under the platform's
	// (or whose merged resources a pod would refuse) is the platform's doing, not
	// the app's: hold the app's current Knative Service (F3) instead of failing it
	// as an invalid spec. Anything else the app got wrong stays an InvalidSpec.
	gate := platformEffectiveGate(&nextApp, snap, eff)
	if err := validation.ValidateNextAppSpecWithBudget(&nextApp.Spec, eff.connectionBudget); err != nil && gate.hold == holdNone {
		logger.Error(err, "Rejecting NextApp: spec failed validation")
		// The outcome (Degraded/Ready, the Warning event) is the verdict's: no
		// observed-state input exists yet, so only the rejection is supplied.
		verdict := computeStatusVerdict(&nextApp, nil, databaseCheckState{}, revisionCheck{}, imageCacheState{},
			netpolEnforcementState{}, envMapCollisionReport{}, privateExposureState{}, podCreationState{}, time.Now(),
			withInvalidSpec(err))
		// The validation error, not a status-write failure, is what the caller needs;
		// a failed write retries with the error's own backoff.
		_ = r.applyStatusVerdict(ctx, &nextApp, observedStatus, verdict)
		return ctrl.Result{}, err
	}

	// 0. Database binding (ADR-0019). knext is engine-agnostic and provisions NO
	// database (the managed scale-to-zero-Postgres mode was removed — ADR-0025).
	// The only database surface is BYO: spec.database.secretRef binds an EXISTING
	// same-namespace Secret onto DATABASE_URL(+_RO). The DatabaseReady composition
	// lives in computeStatusVerdict (#254).
	db := databaseCheckState{mode: databaseModeNone}
	if databaseBound(&nextApp) {
		// 0b. BYO binding (ADR-0019): spec.database.secretRef maps an EXISTING
		// same-namespace Secret onto DATABASE_URL(+_RO) through the in-memory
		// envMap injection. No provisioning, no hard-gate (envMap semantics: a
		// missing Secret surfaces on the pod as CreateContainerConfigError).
		db.mode = databaseModeBound
		r.injectBoundDatabaseEnv(&nextApp)
		nextApp.Status.DatabaseSecretName = nextApp.Spec.Database.SecretRef.Name
	} else {
		// 0c. spec.database removed/emptied: the status must stop claiming a
		// database. Clear the bound Secret name; the verdict drops the
		// DatabaseReady condition.
		nextApp.Status.DatabaseSecretName = ""
	}

	// 1. Create/Update ServiceAccount
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name + "-sa",
			Namespace: nextApp.Namespace,
		},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, sa, func() error {
		sa.AutomountServiceAccountToken = new(false)
		// Own the pull secrets: set them from spec on every reconcile so an
		// out-of-band `kubectl patch sa` is no longer required for a private
		// registry, and drift is corrected rather than tolerated (#794, #952;
		// ADR-0001). The image-prewarm DaemonSet reads them back off this SA
		// (ADR-0037, appImagePullSecrets), so wiring here covers both the app
		// revision and the prewarm path.
		sa.ImagePullSecrets = nextApp.Spec.ImagePullSecrets
		return ctrl.SetControllerReference(&nextApp, sa, r.Scheme)
	})
	if err != nil {
		logger.Error(err, "Failed to reconcile ServiceAccount")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
			fmt.Sprintf("Failed to reconcile ServiceAccount: %s", err.Error()))
		return ctrl.Result{}, err
	}

	// 2. Create/Update Image Cache (pre-pull for faster cold starts)
	imageCache := &unstructured.Unstructured{}
	imageCache.SetAPIVersion("caching.internal.knative.dev/v1alpha1")
	imageCache.SetKind("Image")
	imageCache.SetName(nextApp.Name + "-image-cache")
	imageCache.SetNamespace(nextApp.Namespace)

	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, imageCache, func() error {
		imageCache.Object["spec"] = map[string]any{
			"image": nextApp.Spec.Image,
		}
		labels := map[string]string{
			"app":          nextApp.Name,
			"generated-by": "kn-next-operator",
		}
		imageCache.SetLabels(labels)
		return ctrl.SetControllerReference(&nextApp, imageCache, r.Scheme)
	})
	if err != nil {
		// Image cache is non-critical — log and continue
		logger.Info("Could not reconcile Image cache (CRD may not be installed)", "error", err.Error())
	}

	// 2b. Zone functions (ADR-0004 Amendment 2): resolve spec.backends[] against
	// the BackendServices in this namespace. Read-only; the result is rendered
	// into the Knative Service template below (never into NextApp.spec) and
	// reported through computeStatusVerdict. No spec.backends => the zero value,
	// which renders nothing and reports nothing.
	bindings, err := r.resolveZoneBindings(ctx, &nextApp)
	if err != nil {
		logger.Error(err, "Failed to resolve spec.backends")
		return ctrl.Result{}, err
	}
	var bindingCollisions []string

	// 2c. Zone identity (ADR-0004 Amendment 1 Decisions 9 and 11): a zone with a
	// two-sided function binding owns one signing key (a Secret mounted into
	// this zone only) and a JWKS ConfigMap its functions mount, and rotates
	// them in the contract's order. Before the Knative Service, so a new zone's
	// first revision finds its key. A failed write fails the pass, like the
	// NetworkPolicy: it is a security control. Its state reaches status through
	// computeStatusVerdict (ZoneSigningKey), never through a branch here.
	var zoneKey zoneSigningKeyState
	if zoneKey, err = r.reconcileZoneSigningKey(ctx, &nextApp, bindings); err != nil {
		logger.Error(err, "Failed to reconcile the zone signing key")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
			fmt.Sprintf("Failed to reconcile the zone signing key: %s", err.Error()))
		return ctrl.Result{}, err
	}

	// 3. Create/Update Knative Service
	ksvc := &servingv1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name,
			Namespace: nextApp.Namespace,
		},
	}
	// #1288/#1391: captured from the closure so the pure verdict (computed
	// below) can report/warn on any spec.secrets.envMap entry colliding with
	// an operator-managed reserved env name on a GRANDFATHERED CR (admission
	// rejects any new such collision).
	var envMapCollision envMapCollisionReport
	// Rollout pacing (ADR-0064 F2): a platform change that WOULD alter this app's
	// revision template waits for its slot behind rollout.maxAppsPerMinute. Inert
	// (never even reads the Knative Service) when no platform stamp moved.
	if gate.hold == holdNone {
		var gateErr error
		if gate, gateErr = r.gateRollout(ctx, &nextApp, snap, eff); gateErr != nil {
			return ctrl.Result{}, gateErr
		}
	} else {
		// Held for another reason (an invalid merged spec): not waiting for a slot.
		r.rollout.release(req.NamespacedName)
	}
	// Fleet metrics observe the gate; they never decide it (platform_metrics.go).
	r.held.observe(req.NamespacedName, gate)
	if gate.hold != holdNone {
		// Hold-last-good: read the live Knative Service and leave it exactly as it
		// is. The verdict reports why (PlatformDefaultsApplied) and, for a queued
		// re-render, when to come back.
		if getErr := r.Get(ctx, client.ObjectKeyFromObject(ksvc), ksvc); getErr != nil && !errors.IsNotFound(getErr) {
			return ctrl.Result{}, getErr
		}
		_, _, envMapCollision = r.buildKsvcEnv(&nextApp)
	} else {
		_, err = controllerutil.CreateOrUpdate(ctx, r.Client, ksvc, func() error {
			var buildErr error
			envMapCollision, buildErr = r.buildDesiredKsvc(&nextApp, ksvc, eff)
			if buildErr != nil {
				return buildErr
			}
			// The binding env is appended LAST and only for two-sided bindings,
			// so a zone with none renders byte-identically. The zone's key mount
			// and issuer follow the same rule.
			bindingCollisions = applyBindingEnv(ksvc, nextApp.Namespace, bindings)
			if c := applyZoneIdentity(ksvc, &nextApp, bindings); len(c) > 0 {
				bindingCollisions = append(bindingCollisions, c...)
				sort.Strings(bindingCollisions)
			}
			return nil
		})
		if err != nil {
			logger.Error(err, "Failed to reconcile Knative Service")
			r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
				fmt.Sprintf("Failed to reconcile Knative Service: %s", err.Error()))
			return ctrl.Result{}, err
		}
	}

	// 4b. Reconcile the in-cluster-only NetworkPolicy (defense-in-depth for the
	// mutating cache endpoints). Default-on; toggled off via spec.security.networkPolicy=false.
	if err := r.reconcileNetworkPolicy(ctx, &nextApp); err != nil {
		logger.Error(err, "Failed to reconcile NetworkPolicy")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
			fmt.Sprintf("Failed to reconcile NetworkPolicy: %s", err.Error()))
		return ctrl.Result{}, err
	}

	// 4c. Reconcile the opt-in image-prewarm DaemonSet (ADR-0037). On
	// spec.scaling.imagePrewarm=true it pulls+pins the app's digest-pinned image
	// on every node so scale-from-zero skips the image pull; on false/unset any
	// previously-created DaemonSet is deleted.
	//
	// DECOUPLED FROM THE PASS (#471 item 4): unlike the ksvc (which IS the app)
	// and the NetworkPolicy (a security control), image prewarm is an OPT-IN
	// cold-start optimisation. Returning its error here made a persistent
	// failure — in practice, missing DaemonSet RBAC — abort the pass BEFORE the
	// status verdict ran, so the app's Ready was never written and the object sat
	// in controller-runtime's exponential backoff: the optimisation taking the
	// app's status convergence down with it. The error is instead carried into
	// the verdict (below), where it degrades ImageCacheReady ONLY, with a bounded
	// requeue for the retry and a transition-gated Warning event so it is loud
	// rather than swallowed. The failure ALSO increments
	// knext_nextapp_image_prewarm_errors_total, which is what the (warning, not
	// critical) alert keys on now that it no longer trips the reconcile-error page.
	//
	// A Conflict is classified apart from a real failure: CreateOrUpdate is
	// Get-then-Update, so losing that race is ROUTINE and says nothing about the
	// DaemonSet's health. Degrading on it would flip a healthy ImageCacheReady to
	// False and back on the next pass — the condition flapping the #98 no-op guard
	// exists to prevent. It only earns a retry.
	prewarmErrMsg := ""
	prewarmTransient := false
	if err := r.reconcileImagePrewarmDaemonSet(ctx, &nextApp); err != nil {
		switch {
		case errors.IsConflict(err):
			logger.V(1).Info("image-prewarm DaemonSet write lost an optimistic-concurrency race; "+
				"retrying without degrading ImageCacheReady", "error", err.Error())
			prewarmTransient = true
		default:
			logger.Error(err, "Failed to reconcile image-prewarm DaemonSet; "+
				"degrading ImageCacheReady instead of failing the reconcile pass")
			prewarmErrMsg = err.Error()
		}
	}

	// 4. Create/Update KafkaSource for ISR revalidation.
	//
	// CURRENTLY UNREACHABLE, DELIBERATELY (#475). revalidationDeferred is true for
	// EVERY `queue: kafka` app — it ignores spec.revalidation.provisionKafkaSource,
	// because the sink this source targets (a `{app}-revalidator` Knative Service)
	// is not built by knext and its contract was never specified, so honouring the
	// opt-in could only aim a source at a Service that may never exist. The flag is
	// inert rather than rejected: rejecting it would narrow v1alpha1 in place
	// (ADR-0017 §2.1) and, on the shared fail-closed validation path, would stop the
	// whole app from reconciling. The withdrawal is reported as the
	// RevalidationDeferred condition + a Warning event (status_verdict.go).
	//
	// The construction is retained, not deleted, because building the consumer is an
	// open ADR-0016 action item — that is what makes revalidationDeferred consult the
	// flag again and re-opens this branch. Retained-but-untested code rots, so the
	// object's shape is pinned by build_kafka_source_test.go.
	if !revalidationDeferred(&nextApp) && kafkaRevalidationRequested(&nextApp) {
		kafkaSource := buildKafkaSource(&nextApp)
		desiredSpec := kafkaSource.Object["spec"]

		_, err = controllerutil.CreateOrUpdate(ctx, r.Client, kafkaSource, func() error {
			kafkaSource.Object["spec"] = desiredSpec
			return ctrl.SetControllerReference(&nextApp, kafkaSource, r.Scheme)
		})
		if err != nil {
			logger.Error(err, "Failed to reconcile KafkaSource")
			r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
				fmt.Sprintf("Failed to reconcile KafkaSource: %s", err.Error()))
			return ctrl.Result{}, err
		}
	}

	// 5b. NOTE (ADR-0030, W5/#380): the scheduled warm-floor is applied INSIDE
	// buildDesiredKsvc (step 4) — the operator folds the active warmSchedule
	// window's floor into the ksvc min-scale annotation it already owns, making it
	// the SINGLE writer of min-scale. There is no separate warm-floor child to
	// reconcile here; the RequeueAfter to the next window boundary is set below,
	// after the status verdict, so it never masks the ksvc-not-ready requeue.

	// 5. Update Status: URL + conditions + observed traffic split (#92)
	if ksvc.Status.URL != nil {
		nextApp.Status.URL = ksvc.Status.URL.String()
	}
	nextApp.Status.CurrentTraffic = mapTrafficStatus(ksvc.Status.Traffic)

	// 6-pre. Scale-state + last-deploy status (#312): read the latest-READY
	// revision's Knative "Active" condition so `kubectl get nextapp -o wide` can
	// report whether the app is scaled to zero (Ready-but-Inactive revision) and
	// which build is live, without an operator having to spelunk Knative + pods.
	// The GET is best-effort: a transient failure or a not-yet-created revision
	// leaves activeness UNKNOWN (nil), which omits the field rather than guessing.
	var revisionActive *bool
	if ready := ksvc.Status.LatestReadyRevisionName; ready != "" {
		latest := &servingv1.Revision{}
		if getErr := r.Get(ctx, client.ObjectKey{Namespace: nextApp.Namespace, Name: ready}, latest); getErr == nil {
			if active := latest.Status.GetCondition(servingv1.RevisionConditionActive); active != nil {
				switch {
				case active.IsTrue():
					revisionActive = new(true)
				case active.IsFalse():
					revisionActive = new(false)
				}
			}
		}
	}
	ds := deriveDeployState(&nextApp, ksvc, revisionActive, time.Now())
	nextApp.Status.ObservedRevision = ds.observedRevision
	nextApp.Status.ScaledToZero = ds.scaledToZero
	nextApp.Status.LastSuccessfulDeployTime = ds.lastSuccessfulDeployTime

	// Pinned-revision existence check (ADR-0014 follow-up). When spec.traffic
	// pins a revision, GET it so a GC'd pin surfaces as a first-class
	// PinnedRevisionNotFound instead of only Knative's opaque RevisionMissing.
	// The declared traffic intent was ALREADY rendered into the ksvc above —
	// this check only informs status; it never changes what we write (Knative
	// keeps failing safe on the route, serving the last-good split).
	//
	// Three-valued outcome: exists / NotFound / unknown. Only a real NotFound
	// may degrade (after the stall-window race guard in computeStatusVerdict);
	// a transient GET error is NOT evidence the revision is gone, so the verdict
	// keeps the prior state rather than flip-flopping the condition on API hiccups.
	var revCheck revisionCheck
	if nextApp.Spec.Traffic != nil && nextApp.Spec.Traffic.RevisionName != "" {
		rev := &servingv1.Revision{}
		revKey := client.ObjectKey{Namespace: nextApp.Namespace, Name: nextApp.Spec.Traffic.RevisionName}
		switch getErr := r.Get(ctx, revKey, rev); {
		case getErr == nil:
			// Pinned revision exists — nothing to surface.
		case errors.IsNotFound(getErr):
			revCheck.notFound = true
		default:
			revCheck.unknown = true
			logger.Info("pinned revision existence check inconclusive; keeping prior verdict",
				"revision", nextApp.Spec.Traffic.RevisionName, "error", getErr.Error())
		}
	}

	// 6a. Compute the full status verdict (honest-Ready roll-up, pinned-revision
	// verdict, ingress-stall detection, RevalidationDeferred, requeue) in ONE
	// pure function (#254) and apply it: conditions in order, transition-gated
	// events, and the #98 no-op-guarded status write.
	// Image-prewarm readiness (ADR-0037): read the DaemonSet's node coverage so
	// the verdict can report ImageCacheReady honestly (desired vs ready). Only
	// meaningful when prewarm is enabled; best-effort GET (a not-yet-created or
	// unreadable DaemonSet leaves it Pulling, never fatal).
	// The GET happens even when the reconcile above FAILED: coverage observed on
	// the cluster is still accurate, and reporting "9/10 nodes cached, the 10th
	// update was rejected" is a different (and far more actionable) incident than
	// "nothing is cached". Skipping it threw that data away.
	ic := imageCacheState{
		enabled:         imagePrewarmEnabled(&nextApp),
		reconcileErrMsg: prewarmErrMsg,
		transientErr:    prewarmTransient,
	}
	if ic.enabled {
		prewarmDS := &appsv1.DaemonSet{}
		dsKey := client.ObjectKey{Namespace: nextApp.Namespace, Name: nextApp.Name + "-imgcache"}
		if getErr := r.Get(ctx, dsKey, prewarmDS); getErr == nil {
			ic.desired = prewarmDS.Status.DesiredNumberScheduled
			// Honest ImageCacheReady across a DIGEST ROLLOUT: count only pods
			// updated to the CURRENT template (old-digest pods are still "Ready"
			// but cache the wrong image), and only once the DS controller has
			// observed the latest spec. Otherwise a rollout would read stale-True
			// while nodes still pin the previous digest.
			if prewarmDS.Status.ObservedGeneration == prewarmDS.Generation {
				ic.ready = min(prewarmDS.Status.NumberReady, prewarmDS.Status.UpdatedNumberScheduled)
			}
		}
	}

	// NetworkPolicy-enforcement detection (#744): the operator writes a
	// default-on NetworkPolicy above, but whether the cluster's CNI ENFORCES
	// it is a separate fact — flannel (OKE GA, OrbStack) ships no policy
	// controller, so there the policy is declarative only. Observe the CNI
	// signatures so the verdict can say so instead of implying enforcement by
	// silence. Detection is best-effort: a failed DaemonSet list yields
	// "unknown", never "enforced".
	np := netpolEnforcementState{enabled: networkPolicyEnabled(&nextApp)}
	if np.enabled {
		np.verdict, np.evidence = r.detectNetworkPolicyEnforcement(ctx)
	}

	// status.platform records what the platform contributed to the render that
	// just happened. A held pass wrote nothing, so the previous record stands.
	if gate.hold == holdNone {
		nextApp.Status.Platform = platformStatusFor(snap, eff)
	}

	verdict := computeStatusVerdict(&nextApp, ksvc, db, revCheck, ic, np, envMapCollision, r.detectPrivateExposure(ctx, &nextApp), r.detectPodCreationBlocked(ctx, &nextApp, ksvc), time.Now(),
		withPlatformDefaults(newPlatformDefaultsState(snap, eff, gate)),
		withBackendBindings(bindings, bindingCollisions),
		withZoneSigningKey(zoneKey))
	if err := r.applyStatusVerdict(ctx, &nextApp, observedStatus, verdict); err != nil {
		return ctrl.Result{}, err
	}
	result.RequeueAfter = verdict.requeueAfter

	// Warm-schedule boundary requeue (ADR-0030, W5/#380): re-reconcile at the next
	// window start/end so the operator flips the min-scale floor exactly at the
	// boundary rather than waiting for an unrelated event. Take the SOONER of this
	// and any verdict requeue (e.g. ksvc-not-ready) so neither is masked.
	if warmRequeue := warmScheduleRequeue(&nextApp, r.now()); warmRequeue > 0 {
		if result.RequeueAfter == 0 || warmRequeue < result.RequeueAfter {
			result.RequeueAfter = warmRequeue
		}
	}

	r.emitEvent(&nextApp, corev1.EventTypeNormal, ReasonReconciled,
		fmt.Sprintf("NextApp reconciled successfully (image %s)", nextApp.Spec.Image))
	logger.Info("Successfully reconciled NextApp", "name", nextApp.Name, "url", nextApp.Status.URL)
	// Preserve any bounded RequeueAfter set while the child Knative Service is
	// not-yet-Ready (6a) so status converges toward real health.
	return result, nil
}

// reconcileFinalizers ensures the cleanup finalizers on a live NextApp and,
// for a deleting one, runs the bounded external/database teardown and releases
// the finalizers (deleting=true => the caller stops reconciling). Moved
// VERBATIM out of Reconcile (#254 companion move) — behavior-preserving;
// finalizer_test.go is the characterization net.
func (r *NextAppReconciler) reconcileFinalizers(ctx context.Context, nextApp *appsv1alpha1.NextApp) (deleting bool, err error) {
	if nextApp.DeletionTimestamp.IsZero() {
		// Live object: ensure the finalizer(s) are present so we get a chance to
		// run cleanup before the object is GC'd. Use a metadata Patch (not a
		// full Update) so it does not race the later Status().Update: finalizers
		// live in metadata, status in the /status subresource — patching one and
		// updating the other touches disjoint resourceVersions and avoids the
		// "object has been modified" conflict spam (#98).
		patch := client.MergeFrom(nextApp.DeepCopy())
		changed := controllerutil.AddFinalizer(nextApp, ExternalCleanupFinalizer)
		if changed {
			if err := r.Patch(ctx, nextApp, patch); err != nil {
				return false, err
			}
		}
		return false, nil
	}
	// Object is being deleted: run best-effort, bounded cleanup for each
	// finalizer, then remove it so deletion can complete. Neither cleanup
	// returns a hard error for an unreachable dependency (they log + Warning),
	// so we never wedge the CR in Terminating (ADR-0006 §5).
	if controllerutil.ContainsFinalizer(nextApp, ExternalCleanupFinalizer) {
		if err := r.cleanupExternalState(ctx, nextApp); err != nil {
			return true, err
		}
		// Remove the finalizer via a metadata Patch (see the add path above)
		// to keep the metadata vs status writes on disjoint subresources.
		patch := client.MergeFrom(nextApp.DeepCopy())
		controllerutil.RemoveFinalizer(nextApp, ExternalCleanupFinalizer)
		if err := r.Patch(ctx, nextApp, patch); err != nil {
			return true, err
		}
	}
	return true, nil
}

// applyStatusVerdict is the impure half of the compute→apply split (#254): it
// emits the verdict's (already transition-filtered) events, applies the
// condition removals then sets IN ORDER (append order is part of the #98
// contract — see statusVerdict), and writes status ONLY when it differs from
// what was observed at the top of the pass.
//
// No-op-status guard (#98): only write status when the freshly-computed
// desired status differs from what we observed at the top of the pass. On an
// idle, converged object every field is identical, so this skips the write
// and the watch event it would otherwise generate — settling the loop.
func (r *NextAppReconciler) applyStatusVerdict(
	ctx context.Context,
	app *appsv1alpha1.NextApp,
	observedStatus *appsv1alpha1.NextAppStatus,
	verdict statusVerdict,
) error {
	for _, ev := range verdict.events {
		r.emitEvent(app, ev.eventType, ev.reason, ev.message)
	}
	for _, condType := range verdict.removeConditions {
		apimeta.RemoveStatusCondition(&app.Status.Conditions, condType)
	}
	for _, cond := range verdict.conditions {
		apimeta.SetStatusCondition(&app.Status.Conditions, cond)
	}
	if !apiequality.Semantic.DeepEqual(observedStatus, &app.Status) {
		return r.Status().Update(ctx, app)
	}
	return nil
}

// Warm-schedule window evaluation (ADR-0030, W5/#380). The OPERATOR is the sole
// writer of the ksvc min-scale annotation: on every reconcile it evaluates the
// warmSchedule windows against NOW and folds the active-window floor into the
// min-scale stamped in buildDesiredKsvc. There is NO external writer (no CronJob,
// no KEDA) that could race it — so the floor never reverts and never thrashes.

// warmScheduleFloor returns, for the given app at instant `now`:
//   - floor: the warm-pod floor from the ACTIVE window (the max `replicas` over
//     all windows whose [start,end) contains `now`), or 0 if no window is active;
//   - next: the soonest upcoming window boundary strictly after `now` (any
//     window's next start or next end), used to RequeueAfter so the floor flips
//     exactly at boundaries;
//   - hasNext: whether such a boundary exists (always true for a valid non-empty
//     schedule — cron schedules are unbounded — but false for an empty schedule).
//
// Window membership uses robfig/cron ParseStandard (the 5-field flavour the K8s
// CronJob controller uses, matching admission validation) in each window's
// timezone (default UTC). A window is ACTIVE at `now` iff its next `end` fire is
// sooner than its next `start` fire — i.e. we are between a start and its end.
// A window whose cron fails to parse (should be impossible post-validation) or
// whose timezone is unknown is skipped defensively rather than erroring the
// whole reconcile.
func warmScheduleFloor(app *appsv1alpha1.NextApp, now time.Time) (floor int32, next time.Time, hasNext bool) {
	if app.Spec.Scaling == nil || len(app.Spec.Scaling.WarmSchedule) == 0 {
		return 0, time.Time{}, false
	}
	for _, w := range app.Spec.Scaling.WarmSchedule {
		tz := w.Timezone
		if tz == "" {
			tz = "UTC"
		}
		loc, err := time.LoadLocation(tz)
		if err != nil {
			continue // unknown tz: skip this window rather than fail the reconcile
		}
		startSched, err := cron.ParseStandard(strings.TrimSpace(w.Start))
		if err != nil {
			continue
		}
		endSched, err := cron.ParseStandard(strings.TrimSpace(w.End))
		if err != nil {
			continue
		}
		nowTZ := now.In(loc)
		nextStart := startSched.Next(nowTZ)
		nextEnd := endSched.Next(nowTZ)
		// Active iff the pending end comes before the pending start (we're inside
		// a window). At the exact start instant, Next(now) returns the FOLLOWING
		// start while nextEnd is this window's end => active (floor engages).
		if nextEnd.Before(nextStart) && w.Replicas > floor {
			floor = w.Replicas
		}
		// Track the soonest boundary (either edge) across all windows.
		for _, b := range []time.Time{nextStart, nextEnd} {
			if !hasNext || b.Before(next) {
				next, hasNext = b, true
			}
		}
	}
	return floor, next, hasNext
}

// warmScheduleRequeue returns the RequeueAfter duration to the next warm-schedule
// boundary after `now`, clamped to [warmRequeueMin, warmRequeueMax] so a boundary
// far in the future still gets a bounded periodic re-check and a near/negative
// boundary (clock skew) is nudged forward. Zero when there is no schedule.
func warmScheduleRequeue(app *appsv1alpha1.NextApp, now time.Time) time.Duration {
	_, next, hasNext := warmScheduleFloor(app, now)
	if !hasNext {
		return 0
	}
	d := min(max(next.Sub(now), warmRequeueMin), warmRequeueMax)
	return d
}

const (
	// warmRequeueMin floors the boundary requeue so a boundary essentially "now"
	// (or slightly past, from clock skew / reconcile latency) still schedules a
	// prompt re-check instead of a busy 0s requeue.
	warmRequeueMin = 10 * time.Second
	// warmRequeueMax caps the boundary requeue so a distant next boundary still
	// yields a bounded periodic reconcile (defense-in-depth if a boundary is
	// mis-evaluated); a window starting in a week re-checks at least hourly.
	warmRequeueMax = 1 * time.Hour
)

// revisionToNextAppRequests maps a Knative Revision to a reconcile request for
// the NextApp that owns it, so a pure Revision Active-condition flip (Active <->
// Inactive on wake/sleep) re-enqueues the NextApp and `.status.scaledToZero`
// converges within a bounded window (#365).
//
// A Revision is owned by its Configuration, NOT by the NextApp, so a plain
// Owns(Revision) owner-ref walk never resolves back to the NextApp. Instead we
// use the `serving.knative.dev/service` label Knative stamps on every Revision:
// the child ksvc name equals the NextApp name (buildDesiredKsvc), so that label
// value IS the owning NextApp's name in the same namespace. A Revision without
// the label (not ours) enqueues nothing. The re-enqueued reconcile is protected
// by the #98 no-op-status guard, so a Revision event that does not actually
// change status writes nothing and does not hot-loop.
func (r *NextAppReconciler) revisionToNextAppRequests(_ context.Context, obj client.Object) []reconcile.Request {
	rev, ok := obj.(*servingv1.Revision)
	if !ok {
		return nil
	}
	svc := rev.Labels[serving.ServiceLabelKey]
	if svc == "" {
		return nil
	}
	return []reconcile.Request{
		{NamespacedName: types.NamespacedName{Name: svc, Namespace: rev.Namespace}},
	}
}

// NOTE (ADR-0030): the scheduled warm-floor has NO child objects to watch. The
// operator is the single writer of the ksvc min-scale annotation (folded into
// the ksvc it already Owns-watches below) and RequeueAfter's the next window
// boundary itself, so there is no CronJob / patcher RBAC to reconcile. (The
// earlier KEDA and CronJob approaches were both abandoned — KEDA cannot drive a
// Knative Service's /scale, and an external CronJob writer got reverted by the
// operator every reconcile; single-writer is the correct model.)
func (r *NextAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
	b := ctrl.NewControllerManagedBy(mgr).
		// GenerationChangedPredicate on the PRIMARY (For) watch only: a
		// status-only write (metadata.generation is unchanged for status
		// subresource updates) no longer re-enqueues, which — together with the
		// no-op-status guard — kills the idle reconcile hot-loop (#98). NOTE: this
		// also means annotation-only / label-only edits to the NextApp do not
		// reconcile (generation is bumped only on spec changes). That is the
		// accepted trade-off. We do NOT filter the Owns(...) watches: drift in an
		// owned child (ksvc/SA/NetworkPolicy) must still trigger a reconcile.
		//
		// The ONE annotation that does reconcile is the signing-key rotation
		// request (zone_signing_key.go): a rotation, which may answer a suspected
		// key leak, should not wait for the next periodic re-check. Only a change
		// of that annotation's VALUE passes, so it adds no hot-loop: the operator
		// never writes NextApp annotations.
		For(&appsv1alpha1.NextApp{}, builder.WithPredicates(predicate.Or(
			predicate.GenerationChangedPredicate{}, rotationRequestChanged))).
		Owns(&servingv1.Service{}).
		Owns(&corev1.ServiceAccount{}).
		Owns(&networkingv1.NetworkPolicy{}).
		Owns(&appsv1.DaemonSet{}).
		// #365: watch child Knative Revisions so a pure Active-condition flip
		// (scale-to-zero / wake) re-enqueues the owning NextApp and
		// `.status.scaledToZero` converges within a bounded window. Revisions are
		// owned by the Configuration (not the NextApp), so this is a label-mapped
		// Watches rather than an owner-ref Owns; the #98 no-op-status guard keeps a
		// no-change Revision event from writing status or hot-looping.
		Watches(
			&servingv1.Revision{},
			handler.EnqueueRequestsFromMapFunc(r.revisionToNextAppRequests),
		).
		Named("nextapp")
	// PrivateExposure: a newly created DomainMapping re-triggers reconcile of
	// the NextApp it targets. The watch needs the DomainMapping CRD at start-up,
	// so it is registered only when the kind resolves: a Knative install without
	// domain-mapping must not stop the manager. (The condition itself is also
	// re-evaluated on every reconcile, so a CRD installed later is picked up on
	// the next reconcile or operator restart.)
	if _, err := mgr.GetRESTMapper().RESTMapping(
		schema.GroupKind{Group: "serving.knative.dev", Kind: "DomainMapping"}, "v1beta1"); err == nil {
		b = b.Watches(&servingv1beta1.DomainMapping{},
			handler.EnqueueRequestsFromMapFunc(r.domainMappingToNextAppRequests))
	}
	// The platform layer (ADR-0064 D3): the KnextPlatform watch is registered ONLY
	// when discovery reports the CRD, the same precedent as the DomainMapping
	// watch above. An operator upgraded onto a cluster where the CRD was not
	// installed (a partial bundle apply, or a GitOps tool syncing CRDs separately)
	// must start and behave exactly as before: built-in defaults, reported as
	// PlatformDefaultsApplied=NoPlatformCRD. It never crash-loops on a missing
	// kind. A CRD installed LATER is picked up on the next operator restart.
	platformKind := platformv1alpha1.GroupVersion.WithKind("KnextPlatform")
	platformInstalled, discoverErr := platformv1alpha1.CRDInstalled(mgr.GetRESTMapper())
	if discoverErr != nil {
		// Unknown is not absent: a discovery blip must stop start-up rather than
		// silently turn the platform layer off for the life of the process.
		return fmt.Errorf("NextApp controller: %w", discoverErr)
	}
	// Zone functions (ADR-0004 Amendment 2): a BackendService change re-renders
	// its zone (and any zone that lists it, so a cross-zone entry is reported).
	// Status changes count too, because the served proto version lives there.
	// Registered only when the CRD is served, like the platform watch below.
	if r.BackendServiceCRDPresent {
		b = b.Watches(&appsv1alpha1.BackendService{},
			handler.EnqueueRequestsFromMapFunc(r.backendServiceToZoneRequests))
	}
	if platformInstalled && mgr.GetScheme().Recognizes(platformKind) {
		r.PlatformCRDPresent = true
		b = b.Watches(&platformv1alpha1.KnextPlatform{},
			handler.EnqueueRequestsFromMapFunc(r.platformToNextAppRequests),
			// Spec edits (generation) plus create/delete; the platform
			// reconciler's own status writes must not re-render every app.
			builder.WithPredicates(predicate.GenerationChangedPredicate{}))
	} else {
		logf.Log.WithName("setup").Info("KnextPlatform CRD not installed: built-in defaults apply to every NextApp " +
			"(PlatformDefaultsApplied=NoPlatformCRD); install the CRD and restart the operator to enable the platform layer")
	}
	return b.Complete(r)
}

// platformToNextAppRequests re-enqueues EVERY NextApp when the KnextPlatform is
// created, edited or deleted — each one's effective defaults may have moved. The
// rollout limiter, not this fan-out, bounds how fast the changes reach the
// cluster (ADR-0064 F2): an app whose re-render has to wait comes back at its
// slot.
func (r *NextAppReconciler) platformToNextAppRequests(ctx context.Context, _ client.Object) []reconcile.Request {
	var apps appsv1alpha1.NextAppList
	if err := r.List(ctx, &apps); err != nil {
		logf.FromContext(ctx).Error(err, "listing NextApps after a KnextPlatform change; they will pick it up on their next reconcile")
		return nil
	}
	reqs := make([]reconcile.Request, 0, len(apps.Items))
	for i := range apps.Items {
		reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{
			Namespace: apps.Items[i].Namespace, Name: apps.Items[i].Name,
		}})
	}
	return reqs
}
