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
	"strconv"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
	"knative.dev/pkg/apis"
	"knative.dev/serving/pkg/apis/serving"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
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
)

// ksvcNotReadyRequeueAfter bounds how often the reconciler re-checks a child
// Knative Service that has not yet reported Ready. The Owns(ksvc) watch handles
// most transitions, but a bounded periodic requeue guarantees NextApp status
// converges toward the ksvc's real health even if a status event is missed.
const ksvcNotReadyRequeueAfter = 30 * time.Second

// defaultContainerConcurrency is the per-pod concurrent-request soft target
// stamped on the generated Knative Service when spec.scaling.containerConcurrency
// is unset (#377, ADR-0028). Lowered from 100 → 20: at 100 a single pod
// absorbed 100 concurrent requests before Knative added a 2nd replica, making
// reactive scale-to-N effectively inert. 20 is the documented high-traffic
// interim; W1 (#376) refines it from the concurrency→latency curve.
const defaultContainerConcurrency = 20

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
// +kubebuilder:rbac:groups=serving.knative.dev,resources=services,verbs=get;list;watch;create;update;patch;delete
// Revisions: READ-ONLY — the reconciler GETs the spec.traffic.revisionName pin to
// surface a GC'd revision as PinnedRevisionNotFound (ADR-0014). Never written.
// +kubebuilder:rbac:groups=serving.knative.dev,resources=revisions,verbs=get;list;watch
// +kubebuilder:rbac:groups=apps,resources=daemonsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
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
// Secrets: needed to MIRROR the delegated database DSN (app-db-<app>) into the
// app's own namespace (ADR-0006 §3b). Cross-ns SecretKeyRef is impossible, so the
// operator writes a same-ns copy ownerRef'd to the NextApp. The read of the SOURCE
// Secret in the scale-zero-pg namespace is additionally granted by the scoped Role
// there (config/rbac/appdb_driver.yaml); the appdatabases verbs live in that same
// scoped Role (namespaced, NOT cluster-wide) — least privilege, no storage-plane access.
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create;update;patch;delete

func (r *NextAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (result ctrl.Result, retErr error) {
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
	// In-cluster children (ksvc/SA/PVC) keep using ownerRef GC.
	if deleting, err := r.reconcileFinalizers(ctx, &nextApp); err != nil || deleting {
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
	if err := validation.ValidateNextAppSpec(&nextApp.Spec); err != nil {
		logger.Error(err, "Rejecting NextApp: spec failed validation")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonInvalidImage,
			fmt.Sprintf("Spec rejected: %s", err.Error()))
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionDegraded,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: nextApp.Generation,
			Reason:             "InvalidSpec",
			Message:            err.Error(),
		})
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: nextApp.Generation,
			Reason:             "InvalidSpec",
			Message:            "Spec does not meet validation requirements",
		})
		// Only write when the status actually changed (#98 no-op guard) so a
		// persistently-invalid CR does not hot-loop on its own status writes.
		if !apiequality.Semantic.DeepEqual(observedStatus, &nextApp.Status) {
			_ = r.Status().Update(ctx, &nextApp)
		}
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
		sa.AutomountServiceAccountToken = ptr.To(false)
		return ctrl.SetControllerReference(&nextApp, sa, r.Scheme)
	})
	if err != nil {
		logger.Error(err, "Failed to reconcile ServiceAccount")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
			fmt.Sprintf("Failed to reconcile ServiceAccount: %s", err.Error()))
		return ctrl.Result{}, err
	}

	// 2. Create/Update PVC if Bytecode Caching is enabled
	if err := r.reconcileBytecodeCachePVC(ctx, &nextApp); err != nil {
		logger.Error(err, "Failed to reconcile PVC")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
			fmt.Sprintf("Failed to reconcile bytecode-cache PVC: %s", err.Error()))
		return ctrl.Result{}, err
	}

	// 3. Create/Update Image Cache (pre-pull for faster cold starts)
	imageCache := &unstructured.Unstructured{}
	imageCache.SetAPIVersion("caching.internal.knative.dev/v1alpha1")
	imageCache.SetKind("Image")
	imageCache.SetName(nextApp.Name + "-image-cache")
	imageCache.SetNamespace(nextApp.Namespace)

	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, imageCache, func() error {
		imageCache.Object["spec"] = map[string]interface{}{
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

	// 4. Create/Update Knative Service
	ksvc := &servingv1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name,
			Namespace: nextApp.Namespace,
		},
	}
	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, ksvc, func() error {
		return r.buildDesiredKsvc(&nextApp, ksvc)
	})
	if err != nil {
		logger.Error(err, "Failed to reconcile Knative Service")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
			fmt.Sprintf("Failed to reconcile Knative Service: %s", err.Error()))
		return ctrl.Result{}, err
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
	if err := r.reconcileImagePrewarmDaemonSet(ctx, &nextApp); err != nil {
		logger.Error(err, "Failed to reconcile image-prewarm DaemonSet")
		r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
			fmt.Sprintf("Failed to reconcile image-prewarm DaemonSet: %s", err.Error()))
		return ctrl.Result{}, err
	}

	// 5. Create/Update KafkaSource for ISR revalidation.
	//
	// We provision the KafkaSource ONLY when kafka is selected AND the operator is
	// explicitly opted in via spec.revalidation.provisionKafkaSource=true. The sink
	// the source targets — the `{app}-revalidator` Knative Service — is not yet built
	// (design-now/build-later, issue #95). Provisioning by default would wire eventing
	// to a non-existent service and deliver revalidation events nowhere. When kafka is
	// requested but opt-in is off, we record a non-fatal RevalidationDeferred condition
	// (Ready stays True) below instead of creating a dangling source.
	kafkaRequested := nextApp.Spec.Revalidation != nil && nextApp.Spec.Revalidation.Queue == "kafka"
	if kafkaRequested && !revalidationDeferred(&nextApp) {
		// Unstructured to avoid Eventing proto deps.
		topic := fmt.Sprintf("%s-revalidation", nextApp.Name)
		kafkaSource := &unstructured.Unstructured{}
		kafkaSource.SetAPIVersion("sources.knative.dev/v1beta1")
		kafkaSource.SetKind("KafkaSource")
		kafkaSource.SetName(nextApp.Name + "-revalidation-source")
		kafkaSource.SetNamespace(nextApp.Namespace)

		_, err = controllerutil.CreateOrUpdate(ctx, r.Client, kafkaSource, func() error {
			spec := map[string]interface{}{
				"consumerGroup": nextApp.Name + "-revalidation",
				"bootstrapServers": []interface{}{
					nextApp.Spec.Revalidation.KafkaBrokerUrl,
				},
				"topics": []interface{}{
					topic,
				},
				"sink": map[string]interface{}{
					"ref": map[string]interface{}{
						"apiVersion": "serving.knative.dev/v1",
						"kind":       "Service",
						"name":       nextApp.Name + "-revalidator",
					},
				},
			}
			kafkaSource.Object["spec"] = spec
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

	// 6. Update Status: URL + conditions + observed traffic split (#92)
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
					revisionActive = ptr.To(true)
				case active.IsFalse():
					revisionActive = ptr.To(false)
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
	ic := imageCacheState{enabled: imagePrewarmEnabled(&nextApp)}
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
				ic.ready = prewarmDS.Status.UpdatedNumberScheduled
				if prewarmDS.Status.NumberReady < ic.ready {
					ic.ready = prewarmDS.Status.NumberReady
				}
			}
		}
	}

	verdict := computeStatusVerdict(&nextApp, ksvc, db, revCheck, ic, time.Now())
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

// reconcileBytecodeCachePVC creates/updates the bytecode-cache PVC when
// spec.cache.enableBytecodeCache is set (no-op otherwise). Moved VERBATIM out
// of Reconcile (#254 companion move).
func (r *NextAppReconciler) reconcileBytecodeCachePVC(ctx context.Context, nextApp *appsv1alpha1.NextApp) error {
	if nextApp.Spec.Cache == nil || !nextApp.Spec.Cache.EnableBytecodeCache {
		return nil
	}
	size := nextApp.Spec.Cache.BytecodeCacheSize
	if size == "" {
		size = "512Mi"
	}
	// #431: never MustParse unvalidated CR input inside the reconciler — a
	// malformed quantity would panic the whole controller. Validation
	// (validateBytecodeCacheSize) rejects bad sizes upstream; this
	// error-returning parse is the defense-in-depth for stored CRs that
	// predate that check.
	quantity, err := resource.ParseQuantity(size)
	if err != nil {
		return fmt.Errorf(
			"spec.cache.bytecodeCacheSize %q is not a valid Kubernetes quantity: %w", size, err,
		)
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name + "-bytecode-cache",
			Namespace: nextApp.Namespace,
		},
	}
	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, pvc, func() error {
		if pvc.Spec.AccessModes == nil {
			pvc.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
		}
		if pvc.Spec.Resources.Requests == nil {
			pvc.Spec.Resources.Requests = corev1.ResourceList{}
		}
		pvc.Spec.Resources.Requests[corev1.ResourceStorage] = quantity
		return ctrl.SetControllerReference(nextApp, pvc, r.Scheme)
	})
	return err
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

// buildDesiredKsvc mutates ksvc toward the desired state derived from the
// NextApp spec: labels, autoscaling/observability annotations, the full env
// assembly (system env, storage/cache/revalidation, observability, secrets
// envFrom/envMap, spec.env with collision warnings), probes, resources,
// runtime command, the build-id revision label (#93), and the traffic split
// (#92). Moved VERBATIM out of the CreateOrUpdate closure in Reconcile (#254
// companion move) — behavior-preserving; the rendered-output envtests
// (reconcile_output_test.go, spec_env_test.go) are the characterization net.
// Not fully pure: a colliding spec.env name emits a Warning event (#186).
// readinessProbePath returns the SHALLOW health path that backs the Knative
// readiness + liveness probes (#338, ADR-0026). It must NOT resolve to a handler
// that deep-checks a scale-to-zero DB, or readiness flaps on every cold wake. It
// honours spec.healthCheckPath when set (the app owns the shallow endpoint),
// defaulting to /api/health (which the app serves shallow).
func readinessProbePath(nextApp *appsv1alpha1.NextApp) string {
	if nextApp.Spec.HealthCheckPath != "" {
		return nextApp.Spec.HealthCheckPath
	}
	return "/api/health"
}

// deepHealthPath is the DEEP dependency-reachability path used by
// observability/alerting only — never wired to a probe (#338, ADR-0026).
func deepHealthPath(nextApp *appsv1alpha1.NextApp) string {
	return readinessProbePath(nextApp) + "/deep"
}

func (r *NextAppReconciler) buildDesiredKsvc(nextApp *appsv1alpha1.NextApp, ksvc *servingv1.Service) error {
	// Determine the SHALLOW readiness/liveness probe path (#338).
	healthPath := readinessProbePath(nextApp)

	if ksvc.Labels == nil {
		ksvc.Labels = make(map[string]string)
	}
	ksvc.Labels["app"] = nextApp.Name
	ksvc.Labels["generated-by"] = "kn-next-operator"

	annotations := map[string]string{
		"autoscaling.knative.dev/min-scale": "0",
		"autoscaling.knative.dev/max-scale": "10",
	}
	// Effective min-scale = max(Spec.MinScale, active warm-schedule floor). The
	// OPERATOR is the SINGLE writer of min-scale (ADR-0030, #380): on every
	// reconcile it evaluates the warmSchedule windows against NOW and folds the
	// active-window floor into the min-scale it stamps here. No external writer
	// (no CronJob) ever races the operator, so there is no revert/thrash. Outside
	// every window the floor is Spec.MinScale (default 0), preserving
	// scale-to-zero. Reconcile() additionally RequeueAfter's the next window
	// boundary so the floor flips at start/end without waiting for an unrelated
	// reconcile.
	minScale := int32(0)
	if nextApp.Spec.Scaling != nil {
		minScale = nextApp.Spec.Scaling.MinScale
		annotations["autoscaling.knative.dev/max-scale"] = fmt.Sprintf("%d", nextApp.Spec.Scaling.MaxScale)
	}
	if floor, _, _ := warmScheduleFloor(nextApp, r.now()); floor > minScale {
		minScale = floor
	}
	annotations["autoscaling.knative.dev/min-scale"] = fmt.Sprintf("%d", minScale)

	// TargetBurstCapacity (#411, ADR-0032): whether the activator stays in the
	// request path as a burst buffer. Only stamped when the field is
	// EXPLICITLY set — nil leaves the annotation absent so the Knative
	// cluster default (200) applies unmanaged, exactly as before this field
	// existed (byte-identical back-compat). Written into the SAME annotations
	// map as min-scale/max-scale/containerConcurrency, and is untouched by
	// the preview-env override below (that override rewrites only
	// max-scale/min-scale/retention-period, so a stamped TBC always
	// survives it).
	if nextApp.Spec.Scaling != nil && nextApp.Spec.Scaling.TargetBurstCapacity != nil {
		annotations["autoscaling.knative.dev/target-burst-capacity"] = fmt.Sprintf("%d", *nextApp.Spec.Scaling.TargetBurstCapacity)
	}

	// PanicWindowPercentage / PanicThresholdPercentage (#413, ADR-0033): how
	// fast the KPA reacts to an unpredicted surge. Only stamped when
	// EXPLICITLY set — nil leaves the annotation absent so the Knative
	// cluster defaults (10% window / 200% threshold) apply unmanaged, exactly
	// as before this field existed (byte-identical back-compat). Written into
	// the SAME annotations map as min-scale/max-scale/containerConcurrency/
	// targetBurstCapacity, and is untouched by the preview-env override below
	// (that override rewrites only max-scale/min-scale/retention-period, so a
	// stamped panic annotation always survives it).
	if nextApp.Spec.Scaling != nil && nextApp.Spec.Scaling.PanicWindowPercentage != nil {
		annotations["autoscaling.knative.dev/panic-window-percentage"] = fmt.Sprintf("%d", *nextApp.Spec.Scaling.PanicWindowPercentage)
	}
	if nextApp.Spec.Scaling != nil && nextApp.Spec.Scaling.PanicThresholdPercentage != nil {
		annotations["autoscaling.knative.dev/panic-threshold-percentage"] = fmt.Sprintf("%d", *nextApp.Spec.Scaling.PanicThresholdPercentage)
	}

	// Observability annotations — aligned with CLI
	if nextApp.Spec.Observability != nil && nextApp.Spec.Observability.Enabled {
		annotations["prometheus.io/scrape"] = "true"
		annotations["prometheus.io/port"] = "9091"
		annotations["prometheus.io/path"] = "/metrics"
	}

	if nextApp.Spec.Preview != nil && nextApp.Spec.Preview.Enabled {
		ksvc.Labels["environment"] = "preview"
		ksvc.Labels["pr-id"] = nextApp.Spec.Preview.PRID

		// Override max-scale to 1 to save cluster resources on previews
		annotations["autoscaling.knative.dev/max-scale"] = "1"
		annotations["autoscaling.knative.dev/min-scale"] = "0"
		// Set a very short scale-to-zero window
		annotations["autoscaling.knative.dev/scale-to-zero-pod-retention-period"] = "30s"
	}

	envVars, envFrom := r.buildKsvcEnv(nextApp)

	var volumes []corev1.Volume
	var volumeMounts []corev1.VolumeMount
	if nextApp.Spec.Cache != nil && nextApp.Spec.Cache.EnableBytecodeCache {
		volumes = append(volumes, corev1.Volume{
			Name: "bytecode-cache",
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
					ClaimName: nextApp.Name + "-bytecode-cache",
				},
			},
		})
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name:      "bytecode-cache",
			MountPath: "/cache/bytecode",
		})
	}

	// ContainerConcurrency default (#377, ADR-0028). Lowered from 100 → 20: a
	// pod absorbing 100 concurrent requests before Knative added a 2nd replica
	// made reactive scale-to-N effectively inert. 20 is the documented
	// high-traffic interim; W1 (#376) refines the exact value from the
	// concurrency→latency curve. Still overridable via
	// spec.scaling.containerConcurrency. NOTE: a lower cc scales apps to more
	// pods sooner, which raises DB connection pressure — the connection-wall
	// invariant (maxScale × poolMax ≤ max_connections) is enforced in
	// validation.ValidateNextAppSpec when a poolMax is declared.
	cc := int64(defaultContainerConcurrency)
	if nextApp.Spec.Scaling != nil && nextApp.Spec.Scaling.ContainerConcurrency > 0 {
		cc = int64(nextApp.Spec.Scaling.ContainerConcurrency)
	}

	// Resource limits — aligned with CLI defaults
	resourceRequests := corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("250m"),
		corev1.ResourceMemory: resource.MustParse("512Mi"),
	}
	resourceLimits := corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("1000m"),
		corev1.ResourceMemory: resource.MustParse("1Gi"),
	}
	if nextApp.Spec.Resources != nil {
		// #435: never MustParse unvalidated CR input inside the SHARED reconcile
		// loop — a malformed quantity ("500", "1GB", "0.5 CPU") would panic the
		// whole controller and stop EVERY NextApp on the cluster from
		// reconciling. Validation (validation.validateResources) rejects bad
		// values upstream at admission / as a status condition; these
		// error-returning parses are the defense-in-depth for stored CRs that
		// predate that check.
		if v := nextApp.Spec.Resources.CPURequest; v != "" {
			q, err := resource.ParseQuantity(v)
			if err != nil {
				return fmt.Errorf("spec.resources.cpuRequest %q is not a valid Kubernetes quantity: %w", v, err)
			}
			resourceRequests[corev1.ResourceCPU] = q
		}
		if v := nextApp.Spec.Resources.MemoryRequest; v != "" {
			q, err := resource.ParseQuantity(v)
			if err != nil {
				return fmt.Errorf("spec.resources.memoryRequest %q is not a valid Kubernetes quantity: %w", v, err)
			}
			resourceRequests[corev1.ResourceMemory] = q
		}
		if v := nextApp.Spec.Resources.CPULimit; v != "" {
			q, err := resource.ParseQuantity(v)
			if err != nil {
				return fmt.Errorf("spec.resources.cpuLimit %q is not a valid Kubernetes quantity: %w", v, err)
			}
			resourceLimits[corev1.ResourceCPU] = q
		}
		if v := nextApp.Spec.Resources.MemoryLimit; v != "" {
			q, err := resource.ParseQuantity(v)
			if err != nil {
				return fmt.Errorf("spec.resources.memoryLimit %q is not a valid Kubernetes quantity: %w", v, err)
			}
			resourceLimits[corev1.ResourceMemory] = q
		}
	}

	// TimeoutSeconds: default 300s when unset (matches knative-manifest.ts hardcoded value)
	timeoutSeconds := int64(300)
	if nextApp.Spec.TimeoutSeconds > 0 {
		timeoutSeconds = int64(nextApp.Spec.TimeoutSeconds)
	}

	// Runtime: select bun or node to exec server.js
	var containerCommand []string
	if nextApp.Spec.Runtime == "bun" {
		containerCommand = []string{"bun", "run", "server.js"}
	}

	ksvc.Spec.Template.ObjectMeta.Annotations = annotations

	// Skew protection (#93): stamp the deploy's BUILD_ID onto the revision
	// (pod) template as a label. Knative propagates template labels to every
	// Revision, so the CLI's deploy-time asset GC can resolve a live revision
	// back to its build-id (read-only) and never reap a live build's assets.
	if nextApp.Spec.BuildID != "" {
		if ksvc.Spec.Template.ObjectMeta.Labels == nil {
			ksvc.Spec.Template.ObjectMeta.Labels = make(map[string]string)
		}
		ksvc.Spec.Template.ObjectMeta.Labels[appsv1alpha1.BuildIDLabel] = nextApp.Spec.BuildID
	}

	ksvc.Spec.Template.Spec.ServiceAccountName = nextApp.Name + "-sa"
	ksvc.Spec.Template.Spec.ContainerConcurrency = &cc
	ksvc.Spec.Template.Spec.TimeoutSeconds = &timeoutSeconds
	ksvc.Spec.Template.Spec.Containers = []corev1.Container{
		{
			Image:        nextApp.Spec.Image,
			Command:      containerCommand,
			Env:          envVars,
			EnvFrom:      envFrom,
			VolumeMounts: volumeMounts,
			Ports: []corev1.ContainerPort{
				{ContainerPort: 3000},
			},
			Resources: corev1.ResourceRequirements{
				Requests: resourceRequests,
				Limits:   resourceLimits,
			},
			// Probe values aligned with CLI: initialDelay=2, period=3 for readiness
			ReadinessProbe: &corev1.Probe{
				ProbeHandler: corev1.ProbeHandler{
					HTTPGet: &corev1.HTTPGetAction{
						Path: healthPath,
						Port: intstr.FromInt(3000),
					},
				},
				InitialDelaySeconds: 2,
				PeriodSeconds:       3,
			},
			LivenessProbe: &corev1.Probe{
				ProbeHandler: corev1.ProbeHandler{
					HTTPGet: &corev1.HTTPGetAction{
						Path: healthPath,
						Port: intstr.FromInt(3000),
					},
				},
				InitialDelaySeconds: 5,
				PeriodSeconds:       10,
			},
		},
	}
	ksvc.Spec.Template.Spec.Volumes = volumes

	// Traffic split (issue #92): render the rollback/canary intent from
	// spec.traffic. nil => clear any prior split so Knative reverts to
	// 100% latest-ready (no stale pin on transition back).
	ksvc.Spec.Traffic = buildTrafficTargets(nextApp)

	return ctrl.SetControllerReference(nextApp, ksvc, r.Scheme)
}

// buildKsvcEnv assembles the container env (operator-managed system env,
// storage/cache/revalidation/observability wiring, then the Secret-backed
// envFrom/envMap entries) and finishes with the spec.env merge. Moved VERBATIM
// out of buildDesiredKsvc (#254 companion move) — behavior-preserving; the env
// ordering is part of the rendered-output characterization (spec_env_test.go).
func (r *NextAppReconciler) buildKsvcEnv(nextApp *appsv1alpha1.NextApp) ([]corev1.EnvVar, []corev1.EnvFromSource) {
	var envVars []corev1.EnvVar
	// HOSTNAME=0.0.0.0 overrides kubelet's HOSTNAME=<pod-name> so a bare
	// `next start`/server.js entrypoint binds all interfaces instead of the
	// pod IP only (Knative's queue-proxy dials 127.0.0.1:USER_PORT).
	// Verified benign for middleware rewrites (#178): with 0.0.0.0 the
	// router initUrl and the middleware-visible origin match. The knext
	// runtime entry (node-server.ts buildChildEnv) now additionally empties
	// HOSTNAME for its spawned standalone child, making this injection moot
	// there — kept as defense-in-depth for custom images that run server.js
	// directly. Do NOT change this to a loopback IP or hostname.
	//
	// Pod identity for tracing (#184): this override clobbers kubelet's
	// HOSTNAME=<pod-name>, and we can NOT restore it via the downward API —
	// valueFrom.fieldRef in ksvc env is feature-gated on stock Knative
	// (`kubernetes.podspec-fieldref`, Disabled by default: serving
	// pkg/apis/config/features.go; the validation webhook rejects the
	// Service via EnvVarSourceMask, k8s_validation.go). Requiring a
	// cluster-wide config-features edit is not acceptable for a default
	// path. Instead the knext runtime (buildChildEnv) recovers the pod
	// name from the KERNEL hostname (os.hostname() — kubelet sets the
	// pod's OS hostname to the pod name; this env override does not touch
	// it) and exports it as KNEXT_POD_NAME → otel host.name. Do NOT add a
	// fieldRef env here; it would break deploys on stock Knative.
	envVars = append(envVars, corev1.EnvVar{Name: "HOSTNAME", Value: "0.0.0.0"})
	envVars = append(envVars, corev1.EnvVar{Name: "NODE_ENV", Value: "production"})

	// KNEXT_DB_POOL_MAX (#378, W3, ADR-0029): close the declared-vs-runtime
	// poolMax drift the W2 system-designer flagged. ADR-0028 made
	// spec.scaling.poolMax a VALIDATION-only field — the operator gates
	// maxScale × poolMax ≤ 80 at admission, but the app was never TOLD its
	// per-pod cap, so @knext/lib's pg Pool could open more than poolMax
	// connections/pod and blow the budget at runtime. We inject the declared
	// cap so getDbPool() enforces the same number the operator gated. Only
	// injected when poolMax is DECLARED (>0): an undeclared poolMax is the
	// documented-only wall (ADR-0028 §3), so no env is stamped — back-compat
	// for every CR that never set poolMax (it keeps its DB_POOL_MAX default).
	if nextApp.Spec.Scaling != nil && nextApp.Spec.Scaling.PoolMax > 0 {
		envVars = append(envVars, corev1.EnvVar{
			Name:  "KNEXT_DB_POOL_MAX",
			Value: strconv.Itoa(int(nextApp.Spec.Scaling.PoolMax)),
		})
	}

	if nextApp.Spec.Storage != nil && nextApp.Spec.Storage.Provider != "" {
		envVars = append(envVars, corev1.EnvVar{Name: "STORAGE_PROVIDER", Value: nextApp.Spec.Storage.Provider})
		envVars = append(envVars, corev1.EnvVar{Name: "GCS_BUCKET_NAME", Value: nextApp.Spec.Storage.Bucket})
		// S3/MinIO provider fields — aligned with CLI knative-manifest.ts storageEnvVarGenerators
		if nextApp.Spec.Storage.Region != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "CACHE_BUCKET_REGION", Value: nextApp.Spec.Storage.Region})
		}
		if nextApp.Spec.Storage.Endpoint != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "S3_ENDPOINT", Value: nextApp.Spec.Storage.Endpoint})
		}
	}
	if nextApp.Spec.Cache != nil && nextApp.Spec.Cache.Provider != "" {
		envVars = append(envVars, corev1.EnvVar{Name: "CACHE_PROVIDER", Value: nextApp.Spec.Cache.Provider})
		envVars = append(envVars, corev1.EnvVar{Name: "REDIS_URL", Value: nextApp.Spec.Cache.URL})
		if nextApp.Spec.Cache.KeyPrefix != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "REDIS_KEY_PREFIX", Value: nextApp.Spec.Cache.KeyPrefix})
		}
	}
	// #431 — the bytecode cache is a V8 compile cache governing server BOOT
	// SPEED; the data-cache Provider governs ISR/data caching. Orthogonal
	// concerns that merely share the CRD's spec.cache block. This env block
	// used to be NESTED inside the `Provider != ""` branch above, so an app
	// with no data-cache provider got the PVC provisioned AND mounted (both
	// gate on EnableBytecodeCache alone) while NODE_COMPILE_CACHE stayed
	// unset — 512Mi of storage buying nothing. Gate it exactly the way the
	// PVC and the volumeMount already do.
	if nextApp.Spec.Cache != nil && nextApp.Spec.Cache.EnableBytecodeCache {
		envVars = append(envVars, corev1.EnvVar{Name: "NODE_COMPILE_CACHE", Value: "/cache/bytecode/latest"})
		// Bun analog of NODE_COMPILE_CACHE: Bun has no runtime bytecode
		// cache (`bun build --bytecode` hard-fails on the Next standalone
		// server), but its runtime transpiler cache persists transpiled
		// modules ≥ ~50KB across cold starts. Measured on next@16.2.4
		// standalone (Bun 1.3.5): warm cache ≈ -20% time-to-first-response;
		// unwritable dir is fail-open. Same PVC as NODE_COMPILE_CACHE
		// (mounted at /cache/bytecode), sibling dir so the two runtimes'
		// artifacts never collide. Only meaningful under runtime=bun —
		// NODE_COMPILE_CACHE stays set regardless (inert under Bun).
		if nextApp.Spec.Runtime == "bun" {
			envVars = append(envVars, corev1.EnvVar{Name: "BUN_RUNTIME_TRANSPILER_CACHE_PATH", Value: "/cache/bytecode/bun-transpiler"})
		}
	}
	if nextApp.Spec.Revalidation != nil && nextApp.Spec.Revalidation.Queue != "" {
		envVars = append(envVars, corev1.EnvVar{Name: "KAFKA_BROKER_URL", Value: nextApp.Spec.Revalidation.KafkaBrokerUrl})
		envVars = append(envVars, corev1.EnvVar{Name: "KAFKA_REVALIDATION_TOPIC", Value: fmt.Sprintf("%s-revalidation", nextApp.Name)})
	}

	// Observability env vars — aligned with CLI
	if nextApp.Spec.Observability != nil && nextApp.Spec.Observability.Enabled {
		envVars = append(envVars, corev1.EnvVar{Name: "KN_APP_NAME", Value: nextApp.Name})

		// RUM (#94): activate the client Web Vitals beacon. NEXT_PUBLIC_*
		// vars are baked into the client bundle so the reporter no-ops
		// unless enabled here. Default OFF (only set when Rum.Enabled).
		if rum := nextApp.Spec.Observability.Rum; rum != nil && rum.Enabled {
			envVars = append(envVars, corev1.EnvVar{Name: "NEXT_PUBLIC_RUM_ENABLED", Value: "true"})
			if rum.SampleRate != "" {
				envVars = append(envVars, corev1.EnvVar{Name: "NEXT_PUBLIC_RUM_SAMPLE_RATE", Value: rum.SampleRate})
			}
		}

		// Tracing (#30): server-side OTel. Default OFF — only set
		// OTEL_TRACING_ENABLED when Tracing.Enabled, so unconfigured apps
		// initialize no exporter (the runtime hook returns null). The
		// endpoint/sampler args are passed through only when set; the runtime
		// applies a cluster-local default endpoint otherwise (ADR-0012).
		if tracing := nextApp.Spec.Observability.Tracing; tracing != nil && tracing.Enabled {
			envVars = append(envVars, corev1.EnvVar{Name: "OTEL_TRACING_ENABLED", Value: "true"})
			if tracing.Endpoint != "" {
				envVars = append(envVars, corev1.EnvVar{Name: "OTEL_EXPORTER_OTLP_ENDPOINT", Value: tracing.Endpoint})
			}
			if tracing.SampleRate != "" {
				envVars = append(envVars, corev1.EnvVar{Name: "OTEL_TRACES_SAMPLER_ARG", Value: tracing.SampleRate})
			}
		}
	}

	var envFrom []corev1.EnvFromSource
	if nextApp.Spec.Secrets != nil {
		// envFrom: inject entire secrets as env vars
		for _, secretName := range nextApp.Spec.Secrets.EnvFrom {
			envFrom = append(envFrom, corev1.EnvFromSource{
				SecretRef: &corev1.SecretEnvSource{
					LocalObjectReference: corev1.LocalObjectReference{Name: secretName},
				},
			})
		}
		// envMap: map specific secret keys to env var names — aligned with CLI
		for envName, entry := range nextApp.Spec.Secrets.EnvMap {
			envVars = append(envVars, corev1.EnvVar{
				Name: envName,
				ValueFrom: &corev1.EnvVarSource{
					SecretKeyRef: &corev1.SecretKeySelector{
						LocalObjectReference: corev1.LocalObjectReference{Name: entry.SecretName},
						Key:                  entry.SecretKey,
					},
				},
			})
		}
	}

	return r.appendUserEnv(nextApp, envVars), envFrom
}

// appendUserEnv merges spec.env (#186) into the assembled env. Moved VERBATIM
// out of buildDesiredKsvc (#254 companion move).
func (r *NextAppReconciler) appendUserEnv(nextApp *appsv1alpha1.NextApp, envVars []corev1.EnvVar) []corev1.EnvVar {
	// spec.env (#186): plain NON-SECRET name/value config flags. Appended
	// LAST and de-duplicated so it can never override operator-injected
	// system env (HOSTNAME/NODE_ENV/... — the #178/#184 hazard) or a
	// Secret-backed envMap entry; a colliding name is dropped WITH a
	// Warning event naming the authoritative source (never silently).
	// Reserved names (HOSTNAME, PORT, K_*) are additionally rejected at
	// admission by CRD CEL validation. Sorted for deterministic reconcile
	// output. NOTE: secrets.envFrom collisions cannot be detected here —
	// the referenced Secrets' keys are invisible at reconcile time and
	// kubelet applies envFrom BEFORE env, so a spec.env name matching a
	// key inside an envFrom Secret shadows it at runtime (documented user
	// responsibility, docs/operator/crd-nextapp.md).
	if len(nextApp.Spec.Env) > 0 {
		// name → authoritative source, for the Warning message. Entries
		// with ValueFrom are the spec.secrets.envMap Secret mappings; all
		// plain-Value entries before this point are operator-managed.
		taken := make(map[string]string, len(envVars))
		for _, ev := range envVars {
			if ev.ValueFrom != nil {
				taken[ev.Name] = "spec.secrets.envMap"
			} else {
				taken[ev.Name] = "operator-managed system env"
			}
		}
		names := make([]string, 0, len(nextApp.Spec.Env))
		for name := range nextApp.Spec.Env {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if source, exists := taken[name]; exists {
				r.emitEvent(nextApp, corev1.EventTypeWarning, ReasonEnvVarIgnored,
					fmt.Sprintf("spec.env[%s] ignored: name is reserved/managed by %s", name, source))
				continue
			}
			envVars = append(envVars, corev1.EnvVar{Name: name, Value: nextApp.Spec.Env[name]})
		}
	}

	return envVars
}

// buildTrafficTargets renders the Knative Service spec.traffic block from the
// NextApp's spec.traffic intent (issue #92 — rollback / canary).
//
// Semantics:
//   - nil Traffic OR empty RevisionName => nil: emit no spec.traffic so Knative
//     defaults to 100% of the latest-ready revision (byte-identical to pre-#92).
//   - RevisionName set, CanaryPercent == 0 => one target: 100% to the pinned
//     revision (a full rollback).
//   - RevisionName set, CanaryPercent in 1..99 => two targets: (100-p)% to the
//     pinned revision + p% to the latest-ready revision (a canary back toward
//     latest). The sum is always 100.
func buildTrafficTargets(app *appsv1alpha1.NextApp) []servingv1.TrafficTarget {
	if app.Spec.Traffic == nil || app.Spec.Traffic.RevisionName == "" {
		return nil
	}
	t := app.Spec.Traffic
	canary := t.CanaryPercent
	if canary <= 0 || canary >= 100 {
		// Full pin: 100% to the named revision.
		return []servingv1.TrafficTarget{
			{
				RevisionName:   t.RevisionName,
				LatestRevision: ptr.To(false),
				Percent:        ptr.To(int64(100)),
			},
		}
	}
	// Canary: (100-p)% pinned, p% latest-ready.
	return []servingv1.TrafficTarget{
		{
			RevisionName:   t.RevisionName,
			LatestRevision: ptr.To(false),
			Percent:        ptr.To(int64(100 - canary)),
		},
		{
			LatestRevision: ptr.To(true),
			Percent:        ptr.To(int64(canary)),
		},
	}
}

// mapTrafficStatus mirrors the Knative Service's observed traffic distribution
// into NextApp.Status.CurrentTraffic, nil-safe on the *Percent / *LatestRevision
// pointers. Returns nil for an empty input so the status field stays omitted.
func mapTrafficStatus(targets []servingv1.TrafficTarget) []appsv1alpha1.TrafficStatus {
	if len(targets) == 0 {
		return nil
	}
	out := make([]appsv1alpha1.TrafficStatus, 0, len(targets))
	for _, t := range targets {
		ts := appsv1alpha1.TrafficStatus{RevisionName: t.RevisionName}
		if t.Percent != nil {
			ts.Percent = *t.Percent
		}
		if t.LatestRevision != nil {
			ts.LatestRevision = *t.LatestRevision
		}
		out = append(out, ts)
	}
	return out
}

// networkPolicyEnabled reports whether the in-cluster NetworkPolicy should be
// reconciled for this NextApp. Semantics: nil (unset) or true => enabled
// (DEFAULT-ON); false => disabled.
func networkPolicyEnabled(nextApp *appsv1alpha1.NextApp) bool {
	if nextApp.Spec.Security == nil || nextApp.Spec.Security.NetworkPolicy == nil {
		return true
	}
	return *nextApp.Spec.Security.NetworkPolicy
}

// reconcileNetworkPolicy emits a Kubernetes NetworkPolicy that restricts ingress
// to the app's pods to in-cluster sources only: the Knative serving system
// (`knative-serving`), the Kourier gateway (`kourier-system`), and the app's own
// namespace. This is defense-in-depth for the (already Bearer-authed) mutating
// cache endpoints (`POST /api/cache/invalidate`, `DELETE /api/cache/events`).
//
// IMPORTANT (honesty): a NetworkPolicy is L3/L4 — it filters by source pod/
// namespace at the network layer, NOT by HTTP path. It therefore CANNOT isolate a
// specific route; it makes the whole POD unreachable for direct traffic from
// outside the cluster / disallowed namespaces. True per-path isolation would
// require a separate internal-only route. Enforcement also depends on the cluster
// CNI supporting NetworkPolicy (no-op where unsupported).
//
// The policy is owner-referenced to the NextApp so it is garbage-collected on
// delete. When disabled (spec.security.networkPolicy=false), any previously
// created policy is deleted.
func (r *NextAppReconciler) reconcileNetworkPolicy(ctx context.Context, nextApp *appsv1alpha1.NextApp) error {
	np := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name + "-allow-ingress",
			Namespace: nextApp.Namespace,
		},
	}

	if !networkPolicyEnabled(nextApp) {
		// Disabled: best-effort delete of any previously-created policy.
		if err := r.Delete(ctx, np); err != nil && !errors.IsNotFound(err) {
			return err
		}
		return nil
	}

	inNamespaceLabels := func(names ...string) networkingv1.NetworkPolicyPeer {
		return networkingv1.NetworkPolicyPeer{
			NamespaceSelector: &metav1.LabelSelector{
				MatchExpressions: []metav1.LabelSelectorRequirement{
					{
						Key:      "kubernetes.io/metadata.name",
						Operator: metav1.LabelSelectorOpIn,
						Values:   names,
					},
				},
			},
		}
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, np, func() error {
		if np.Labels == nil {
			np.Labels = make(map[string]string)
		}
		np.Labels["app"] = nextApp.Name
		np.Labels["generated-by"] = "kn-next-operator"

		// Target the app's Knative serving pods. Knative stamps every revision pod
		// with `serving.knative.dev/service=<ksvc name>`, which equals the NextApp name.
		np.Spec.PodSelector = metav1.LabelSelector{
			MatchLabels: map[string]string{
				"serving.knative.dev/service": nextApp.Name,
			},
		}
		np.Spec.PolicyTypes = []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}
		np.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{
			{
				From: []networkingv1.NetworkPolicyPeer{
					// Knative serving system (activator handles scale-from-zero) and the
					// Kourier ingress gateway namespace.
					inNamespaceLabels("knative-serving", "kourier-system"),
					// Same namespace: an empty PodSelector matches all pods in the
					// policy's own namespace (NamespaceSelector nil => same namespace).
					{
						PodSelector: &metav1.LabelSelector{},
					},
				},
			},
		}
		return ctrl.SetControllerReference(nextApp, np, r.Scheme)
	})
	return err
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
	d := next.Sub(now)
	if d < warmRequeueMin {
		d = warmRequeueMin
	}
	if d > warmRequeueMax {
		d = warmRequeueMax
	}
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
	return ctrl.NewControllerManagedBy(mgr).
		// GenerationChangedPredicate on the PRIMARY (For) watch only: a
		// status-only write (metadata.generation is unchanged for status
		// subresource updates) no longer re-enqueues, which — together with the
		// no-op-status guard — kills the idle reconcile hot-loop (#98). NOTE: this
		// also means annotation-only / label-only edits to the NextApp do not
		// reconcile (generation is bumped only on spec changes). That is the
		// accepted trade-off. We do NOT filter the Owns(...) watches: drift in an
		// owned child (ksvc/SA/PVC/NetworkPolicy) must still trigger a reconcile.
		For(&appsv1alpha1.NextApp{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Owns(&servingv1.Service{}).
		Owns(&corev1.PersistentVolumeClaim{}).
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
		Named("nextapp").
		Complete(r)
}
