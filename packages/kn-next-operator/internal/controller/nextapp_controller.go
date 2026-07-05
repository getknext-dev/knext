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
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
	"knative.dev/pkg/apis"
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
)

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
	// DatabaseNamespace is where delegated AppDatabases + their app-db-<app>
	// Secrets live (ADR-0006). Empty => DefaultDatabaseNamespace ("scale-zero-pg").
	// Injectable so tests can point at a fixture namespace.
	DatabaseNamespace string
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
// +kubebuilder:rbac:groups=core,resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=caching.internal.knative.dev,resources=images,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=sources.knative.dev,resources=kafkasources,verbs=get;list;watch;create;update;patch;delete
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
	if nextApp.DeletionTimestamp.IsZero() {
		// Live object: ensure the finalizer(s) are present so we get a chance to
		// run cleanup before the object is GC'd. Use a metadata Patch (not a
		// full Update) so it does not race the later Status().Update: finalizers
		// live in metadata, status in the /status subresource — patching one and
		// updating the other touches disjoint resourceVersions and avoids the
		// "object has been modified" conflict spam (#98).
		patch := client.MergeFrom(nextApp.DeepCopy())
		changed := controllerutil.AddFinalizer(&nextApp, ExternalCleanupFinalizer)
		// db-cleanup finalizer only for apps that delegate a database (ADR-0006
		// §3c): cross-ns AppDatabase teardown cannot ride an ownerRef.
		if databaseEnabled(&nextApp) {
			changed = controllerutil.AddFinalizer(&nextApp, DatabaseCleanupFinalizer) || changed
		}
		if changed {
			if err := r.Patch(ctx, &nextApp, patch); err != nil {
				return ctrl.Result{}, err
			}
		}
	} else {
		// Object is being deleted: run best-effort, bounded cleanup for each
		// finalizer, then remove it so deletion can complete. Neither cleanup
		// returns a hard error for an unreachable dependency (they log + Warning),
		// so we never wedge the CR in Terminating (ADR-0006 §5).
		if controllerutil.ContainsFinalizer(&nextApp, DatabaseCleanupFinalizer) {
			if err := r.cleanupDatabase(ctx, &nextApp); err != nil {
				return ctrl.Result{}, err
			}
			patch := client.MergeFrom(nextApp.DeepCopy())
			controllerutil.RemoveFinalizer(&nextApp, DatabaseCleanupFinalizer)
			if err := r.Patch(ctx, &nextApp, patch); err != nil {
				return ctrl.Result{}, err
			}
		}
		if controllerutil.ContainsFinalizer(&nextApp, ExternalCleanupFinalizer) {
			if err := r.cleanupExternalState(ctx, &nextApp); err != nil {
				return ctrl.Result{}, err
			}
			// Remove the finalizer via a metadata Patch (see the add path above)
			// to keep the metadata vs status writes on disjoint subresources.
			patch := client.MergeFrom(nextApp.DeepCopy())
			controllerutil.RemoveFinalizer(&nextApp, ExternalCleanupFinalizer)
			if err := r.Patch(ctx, &nextApp, patch); err != nil {
				return ctrl.Result{}, err
			}
		}
		// Nothing more to reconcile for a deleting object.
		return ctrl.Result{}, nil
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

	// 0. Delegated database (ADR-0006, #119). When spec.database.enabled, the
	// operator provisions an AppDatabase in the scale-zero-pg namespace, HARD-GATES
	// the app on it reaching Ready, mirrors the DSN Secret into this namespace, and
	// injects DATABASE_URL(+_RO) into the env below. dbSecretHash carries a
	// checksum of the DSN so a rotation rolls a new Revision (§4.3).
	var dbSecretHash string
	if databaseEnabled(&nextApp) {
		wiring, dbResult, dbErr := r.reconcileDatabase(ctx, &nextApp)
		if dbErr != nil {
			logger.Error(dbErr, "Failed to reconcile delegated database")
			r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
				fmt.Sprintf("Failed to reconcile database: %s", dbErr.Error()))
			apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
				Type:               ConditionDatabaseReady,
				Status:             metav1.ConditionFalse,
				ObservedGeneration: nextApp.Generation,
				Reason:             "DatabaseError",
				Message:            dbErr.Error(),
			})
			if !apiequality.Semantic.DeepEqual(observedStatus, &nextApp.Status) {
				_ = r.Status().Update(ctx, &nextApp)
			}
			return ctrl.Result{}, dbErr
		}
		if !wiring.ready {
			// HARD-GATE (§4.1): do NOT create the Knative Service until the DB is
			// Ready. Surface DatabaseReady=False + Ready=False and requeue; the
			// app never boots into a crash-loop on a missing DSN.
			phaseMsg := wiring.phase
			if phaseMsg == "" {
				phaseMsg = "Provisioning"
			}
			r.emitEvent(&nextApp, corev1.EventTypeNormal, ReasonDatabaseProvisioning,
				fmt.Sprintf("Waiting for database %q to become Ready (phase=%s)", nextApp.Status.DatabaseAppName, phaseMsg))
			apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
				Type:               ConditionDatabaseReady,
				Status:             metav1.ConditionFalse,
				ObservedGeneration: nextApp.Generation,
				Reason:             "Provisioning",
				Message:            fmt.Sprintf("AppDatabase %q is not Ready yet (phase=%s)", nextApp.Status.DatabaseAppName, phaseMsg),
			})
			apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
				Type:               ConditionReady,
				Status:             metav1.ConditionFalse,
				ObservedGeneration: nextApp.Generation,
				Reason:             "DatabaseProvisioning",
				Message:            "App deploy is gated on its database becoming Ready",
			})
			if !apiequality.Semantic.DeepEqual(observedStatus, &nextApp.Status) {
				if err := r.Status().Update(ctx, &nextApp); err != nil {
					return ctrl.Result{}, err
				}
			}
			return dbResult, nil
		}
		// Ready: inject DATABASE_URL(+_RO) into the in-memory spec so the existing
		// envMap → SecretKeyRef wiring below picks it up, and record the DSN
		// checksum for the pod-template roll annotation. A stored (ratcheted,
		// ADR-0019) CR that still carries an author envMap DATABASE_URL(_RO)
		// entry has it overridden by the managed mirror — LOUDLY, via a
		// Warning naming the ignored entry, never silently.
		r.warnDatabaseEnvOverride(&nextApp, DefaultDatabaseURLKey)
		if wiring.injectRO {
			r.warnDatabaseEnvOverride(&nextApp, DefaultDatabaseURLROKey)
		}
		injectDatabaseEnv(&nextApp, wiring)
		dbSecretHash = wiring.dsnHash
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionDatabaseReady,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: nextApp.Generation,
			Reason:             "Provisioned",
			Message:            fmt.Sprintf("Database %q Ready; DATABASE_URL wired into the app", nextApp.Status.DatabaseAppName),
		})
	} else if databaseBound(&nextApp) {
		// 0b. BYO binding (ADR-0019): spec.database.secretRef maps an EXISTING
		// same-namespace Secret onto DATABASE_URL(+_RO) through the same
		// in-memory envMap injection the managed mode uses. No provisioning,
		// no hard-gate (envMap semantics: a missing Secret surfaces on the pod
		// as CreateContainerConfigError). Mode exclusivity vs enabled is
		// enforced at admission.
		r.injectBoundDatabaseEnv(&nextApp)
		nextApp.Status.DatabaseSecretName = nextApp.Spec.Database.SecretRef.Name
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionDatabaseReady,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: nextApp.Generation,
			Reason:             "Bound",
			Message:            fmt.Sprintf("Bound existing Secret %q as DATABASE_URL", nextApp.Spec.Database.SecretRef.Name),
		})
	} else {
		// 0c. spec.database removed/emptied: the status must stop claiming a
		// database. Clear the bound/mirrored Secret name and drop the
		// DatabaseReady condition. Status.DatabaseAppName is deliberately
		// RETAINED (see its godoc): the delete-time db-cleanup finalizer still
		// needs it to reclaim an AppDatabase orphaned by a managed→BYO/none
		// switch (ADR-0019 — cleanup-on-mode-switch is follow-up scope).
		nextApp.Status.DatabaseSecretName = ""
		apimeta.RemoveStatusCondition(&nextApp.Status.Conditions, ConditionDatabaseReady)
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
	if nextApp.Spec.Cache != nil && nextApp.Spec.Cache.EnableBytecodeCache {
		size := nextApp.Spec.Cache.BytecodeCacheSize
		if size == "" {
			size = "512Mi"
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
			pvc.Spec.Resources.Requests[corev1.ResourceStorage] = resource.MustParse(size)
			return ctrl.SetControllerReference(&nextApp, pvc, r.Scheme)
		})
		if err != nil {
			logger.Error(err, "Failed to reconcile PVC")
			r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonReconcileFailed,
				fmt.Sprintf("Failed to reconcile bytecode-cache PVC: %s", err.Error()))
			return ctrl.Result{}, err
		}
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

	// Determine health check path
	healthPath := "/api/health"
	if nextApp.Spec.HealthCheckPath != "" {
		healthPath = nextApp.Spec.HealthCheckPath
	}

	// 4. Create/Update Knative Service
	ksvc := &servingv1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nextApp.Name,
			Namespace: nextApp.Namespace,
		},
	}
	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, ksvc, func() error {
		if ksvc.Labels == nil {
			ksvc.Labels = make(map[string]string)
		}
		ksvc.Labels["app"] = nextApp.Name
		ksvc.Labels["generated-by"] = "kn-next-operator"

		annotations := map[string]string{
			"autoscaling.knative.dev/min-scale": "0",
			"autoscaling.knative.dev/max-scale": "10",
		}
		// Rotation roll (ADR-0006 §4.3): stamp a checksum of the delegated
		// DATABASE_URL so a credential rotation in the source Secret produces a
		// new pod-template hash → a new Knative Revision → pods re-read the DSN
		// (secretKeyRef is resolved at pod START only).
		if dbSecretHash != "" {
			annotations[databaseSecretHashAnnotation] = dbSecretHash
		}
		if nextApp.Spec.Scaling != nil {
			annotations["autoscaling.knative.dev/min-scale"] = fmt.Sprintf("%d", nextApp.Spec.Scaling.MinScale)
			annotations["autoscaling.knative.dev/max-scale"] = fmt.Sprintf("%d", nextApp.Spec.Scaling.MaxScale)
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
			if nextApp.Spec.Cache.EnableBytecodeCache {
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
					r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonEnvVarIgnored,
						fmt.Sprintf("spec.env[%s] ignored: name is reserved/managed by %s", name, source))
					continue
				}
				envVars = append(envVars, corev1.EnvVar{Name: name, Value: nextApp.Spec.Env[name]})
			}
		}

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

		cc := int64(100)
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
			if nextApp.Spec.Resources.CPURequest != "" {
				resourceRequests[corev1.ResourceCPU] = resource.MustParse(nextApp.Spec.Resources.CPURequest)
			}
			if nextApp.Spec.Resources.MemoryRequest != "" {
				resourceRequests[corev1.ResourceMemory] = resource.MustParse(nextApp.Spec.Resources.MemoryRequest)
			}
			if nextApp.Spec.Resources.CPULimit != "" {
				resourceLimits[corev1.ResourceCPU] = resource.MustParse(nextApp.Spec.Resources.CPULimit)
			}
			if nextApp.Spec.Resources.MemoryLimit != "" {
				resourceLimits[corev1.ResourceMemory] = resource.MustParse(nextApp.Spec.Resources.MemoryLimit)
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
		ksvc.Spec.Traffic = buildTrafficTargets(&nextApp)

		return ctrl.SetControllerReference(&nextApp, ksvc, r.Scheme)
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
	revalidationDeferred := kafkaRequested && !ptr.Deref(nextApp.Spec.Revalidation.ProvisionKafkaSource, false)
	if kafkaRequested && !revalidationDeferred {
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

	// 6. Update Status: URL + conditions + observed traffic split (#92)
	if ksvc.Status.URL != nil {
		nextApp.Status.URL = ksvc.Status.URL.String()
	}
	nextApp.Status.CurrentTraffic = mapTrafficStatus(ksvc.Status.Traffic)

	// 6a. Honest Ready: gate NextApp Ready on the CHILD Knative Service's OWN
	// readiness — not on the fact that we successfully wrote the ksvc. Writing the
	// ksvc spec says nothing about whether its pods actually came up: a NextApp
	// whose image is CrashLoopBackOff / ImagePullBackOff would otherwise report a
	// false-green Ready=True, misleading operators and rollback / traffic-split
	// automation during the exact incident they need to detect.
	//
	// We read the ksvc's "Ready" condition (knative's living condition set rolls
	// Configuration + Route readiness into it) and only mark NextApp Ready=True
	// when that is True. Otherwise Ready=False / Degraded=True with the ksvc's own
	// reason+message (the pull/crash detail), and we schedule a bounded RequeueAfter
	// so status converges toward real health instead of waiting solely on the
	// Owns(ksvc) watch (which may be quiet between status transitions).
	ksvcReadyCond := ksvc.Status.GetCondition(servingv1.ServiceConditionReady)
	ksvcReady := ksvcReadyCond.IsTrue()

	apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
		Type:               ConditionReconciling,
		Status:             metav1.ConditionFalse,
		ObservedGeneration: nextApp.Generation,
		Reason:             "ReconcileSuccess",
		Message:            "Reconciliation complete",
	})

	if ksvcReady {
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionReady,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: nextApp.Generation,
			Reason:             "ReconcileSuccess",
			Message:            "NextApp reconciled successfully; Knative Service is Ready",
		})
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionDegraded,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: nextApp.Generation,
			Reason:             "ReconcileSuccess",
			Message:            "No errors detected",
		})
	} else {
		// Surface the ksvc's own reason/message so operators see the pull/crash
		// detail (e.g. ImagePullBackOff / RevisionFailed) directly on the NextApp.
		ksvcReason := "Pending"
		ksvcMessage := "Knative Service has not reported Ready yet"
		if ksvcReadyCond != nil {
			if ksvcReadyCond.Reason != "" {
				ksvcReason = ksvcReadyCond.Reason
			}
			if ksvcReadyCond.Message != "" {
				ksvcMessage = ksvcReadyCond.Message
			}
		}
		readyReason := "KnativeServiceNotReady"
		readyMessage := fmt.Sprintf("Knative Service is not Ready (%s): %s",
			ksvcReason, ksvcMessage)
		// Loud failure on silent ingress stalls (#208): Knative's own message
		// ("Ingress has not yet been reconciled.") reads as "wait longer" even
		// when NO ingress controller serves the configured class and the route
		// will never program. Past the window, replace the opaque pending state
		// with a specific reason + Warning event naming the likely fix.
		//
		// Churn guards: the condition message is STATIC ("for more than <window>")
		// — embedding the live elapsed would make every 30s requeue produce a new
		// message, defeating the #98 no-op status guard with a status write +
		// self-watch echo per requeue. The live elapsed goes in the EVENT only,
		// and the event fires only on TRANSITION into the stall (the previous
		// Ready reason wasn't already IngressNotProgrammed), not on every pass.
		if elapsed, stalled := ingressProgrammingStalled(ksvc, time.Now()); stalled {
			readyReason = ReasonIngressNotProgrammed
			ksvcReason = ReasonIngressNotProgrammed
			readyMessage = fmt.Sprintf(
				"route programming has stalled: the Knative Route's ingress (KIngress) has been "+
					"unreconciled for more than %s (%s). This usually means no ingress controller "+
					"serves the cluster's configured ingress-class — check the `ingress-class` key in "+
					"the config-network ConfigMap (knative-serving namespace); on Knative-Operator-managed "+
					"clusters the KnativeServing CR overwrites that ConfigMap, so fix the class in the CR. "+
					"net-kourier serves %q (NOT the short `kourier.knative.dev` form).",
				ingressProgrammingStallWindow, ksvcIngressNotConfiguredReason, kourierServedIngressClass)
			ksvcMessage = readyMessage
			prevReady := apimeta.FindStatusCondition(nextApp.Status.Conditions, ConditionReady)
			if prevReady == nil || prevReady.Reason != ReasonIngressNotProgrammed {
				r.emitEvent(&nextApp, corev1.EventTypeWarning, ReasonIngressNotProgrammed,
					fmt.Sprintf("%s (stalled for %s)", readyMessage, elapsed.Round(time.Second)))
			}
		}
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: nextApp.Generation,
			Reason:             readyReason,
			Message:            readyMessage,
		})
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionDegraded,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: nextApp.Generation,
			Reason:             ksvcReason,
			Message:            ksvcMessage,
		})
		// Bounded requeue so status converges toward the ksvc's real health.
		result.RequeueAfter = ksvcNotReadyRequeueAfter
	}

	// Non-fatal RevalidationDeferred condition: surface (but don't fail on) a kafka
	// revalidation request whose consumer hasn't been provisioned yet (issue #95).
	if revalidationDeferred {
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionRevalidationDeferred,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: nextApp.Generation,
			Reason:             "ConsumerNotProvisioned",
			Message: "revalidation.queue=kafka requested but no KafkaSource was provisioned: " +
				"the {app}-revalidator consumer is design-now/build-later (#95). Set " +
				"spec.revalidation.provisionKafkaSource=true once you deploy an external consumer.",
		})
	} else {
		apimeta.SetStatusCondition(&nextApp.Status.Conditions, metav1.Condition{
			Type:               ConditionRevalidationDeferred,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: nextApp.Generation,
			Reason:             "NotDeferred",
			Message:            "Kafka revalidation not deferred",
		})
	}

	// No-op-status guard (#98): only write status when the freshly-computed
	// desired status differs from what we observed at the top of the pass. On an
	// idle, converged object every field is identical, so this skips the write
	// and the watch event it would otherwise generate — settling the loop.
	if !apiequality.Semantic.DeepEqual(observedStatus, &nextApp.Status) {
		if err := r.Status().Update(ctx, &nextApp); err != nil {
			return ctrl.Result{}, err
		}
	}

	r.emitEvent(&nextApp, corev1.EventTypeNormal, ReasonReconciled,
		fmt.Sprintf("NextApp reconciled successfully (image %s)", nextApp.Spec.Image))
	logger.Info("Successfully reconciled NextApp", "name", nextApp.Name, "url", nextApp.Status.URL)
	// Preserve any bounded RequeueAfter set while the child Knative Service is
	// not-yet-Ready (6a) so status converges toward real health.
	return result, nil
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
		Named("nextapp").
		Complete(r)
}
