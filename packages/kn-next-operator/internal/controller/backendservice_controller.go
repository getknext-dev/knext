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
	"errors"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
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
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// BackendServiceFinalizer lets the operator take a function's Knative Service
// down synchronously on delete. It never blocks on an unreachable dependency.
const BackendServiceFinalizer = "apps.kn-next.dev/backendservice-cleanup"

// BackendServiceReconciler reconciles zone functions (ADR-0004, Amendments 1
// and 2). For a two-sided binding it renders a cluster-local h2c Knative
// Service, an operator-owned ServiceAccount and a NetworkPolicy; for anything
// else it renders nothing and deletes what it rendered before (fail closed).
//
// It writes only: the BackendService's metadata (the zone's controller
// ownerReference and its finalizer) and status, and the children it owns. It
// never writes the BackendService spec, the zone's NextApp, or the zone's
// Knative Service (the NextApp reconciler is that Service's only renderer).
type BackendServiceReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// APIReader is the UNCACHED reader for Secret metadata (the same-zone-mark
	// allow rule) and for the metadata of the zone's JWKS ConfigMap (the
	// controller-ownership check before it is mounted). The operator holds
	// cluster-wide `get` on Secrets and ConfigMaps and nothing else on them
	// (no list, no watch), so it must never start an informer for either; it
	// reads only metadata (a PartialObjectMetadata GET), never their data.
	APIReader client.Reader
	Recorder  record.EventRecorder
}

// `delete` on backendservices is never exercised by the reconciler: the
// OwnerReferencesPermissionEnforcement admission plugin (on by default in some
// distributions, e.g. OpenShift) refuses "an ownerRef on a resource you can't
// delete", so setting the zone's ownerReference needs it.
// backendservice_rbac_envtest_test.go runs with that plugin on.
// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=backendservices,verbs=get;list;watch;update;patch;delete
// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=backendservices/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps.kn-next.dev,resources=backendservices/finalizers,verbs=update
// The controller ownerReference this reconciler sets on a BackendService carries
// blockOwnerDeletion: true, which the apiserver admits only for a subject that
// may update the OWNER's finalizers (the nextapps/finalizers grant, declared on
// the NextApp reconciler's markers).
// Secrets: GET ONLY, cluster-wide, no list/watch/create (ADR-0004 Amendment 1
// Decision 2). Used solely by the same-zone-mark allow rule, through the
// uncached APIReader, as a metadata-only read. Justified in
// rbac_secrets_guard_test.go and docs/security/threat-model.md.
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get
// ConfigMaps: GET ONLY here, for the same reason and through the same uncached
// reader: a metadata read of the zone's JWKS ConfigMap, to mount it only when the
// zone's NextApp controls it. The grant is shared with the zone-key writer
// (zone_signing_key_reconcile.go declares get;create;update on configmaps).
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get

func (r *BackendServiceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (result ctrl.Result, retErr error) {
	logger := logf.FromContext(ctx)
	defer func() {
		if retErr != nil {
			backendServiceReconcileTotal.WithLabelValues("error").Inc()
		} else {
			backendServiceReconcileTotal.WithLabelValues("success").Inc()
		}
	}()

	bs := &appsv1alpha1.BackendService{}
	if err := r.Get(ctx, req.NamespacedName, bs); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	observed := bs.Status.DeepCopy()

	// Deletion: take the Knative Service down, then release the object.
	if !bs.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(bs, BackendServiceFinalizer) {
			// Best effort, and it never blocks the delete: the children carry this
			// object's controller ownerReference, so garbage collection removes
			// whatever a failed delete leaves behind.
			if rmErr := r.removeRendered(ctx, bs); rmErr != nil {
				logger.Info("could not delete the function's Knative Service before release; "+
					"garbage collection will", "error", rmErr.Error())
			}
			patch := client.MergeFrom(bs.DeepCopy())
			controllerutil.RemoveFinalizer(bs, BackendServiceFinalizer)
			if err := r.Patch(ctx, bs, patch); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}
	if !controllerutil.ContainsFinalizer(bs, BackendServiceFinalizer) {
		patch := client.MergeFrom(bs.DeepCopy())
		controllerutil.AddFinalizer(bs, BackendServiceFinalizer)
		if err := r.Patch(ctx, bs, patch); err != nil {
			return ctrl.Result{}, err
		}
	}

	var obs functionObservation
	if err := validation.ValidateImageRef(bs.Spec.Image); err != nil {
		obs.invalidImage = "spec.image is refused: " + err.Error()
	}

	// The zone (ADR-0004 Amendment 2 Decision 1): spec.zone names a NextApp in
	// this namespace; the operator sets the controller ownerReference itself and
	// never overwrites one that disagrees.
	var zones appsv1alpha1.NextAppList
	if err := r.List(ctx, &zones, client.InNamespace(bs.Namespace)); err != nil {
		return ctrl.Result{}, err
	}
	var others []appsv1alpha1.NextApp
	for i := range zones.Items {
		if zones.Items[i].Name == bs.Spec.Zone {
			obs.zone = zones.Items[i].DeepCopy()
		} else {
			others = append(others, zones.Items[i])
		}
	}
	if obs.zone != nil {
		obs.conflictingOwner = conflictingController(bs, obs.zone)
		if obs.conflictingOwner == "" && metav1.GetControllerOf(bs) == nil {
			patch := client.MergeFrom(bs.DeepCopy())
			if err := controllerutil.SetControllerReference(obs.zone, bs, r.Scheme); err != nil {
				return ctrl.Result{}, err
			}
			if err := r.Patch(ctx, bs, patch); err != nil {
				return ctrl.Result{}, fmt.Errorf("setting the zone's controller ownerReference "+
					"(needs update on nextapps/finalizers for blockOwnerDeletion): %w", err)
			}
		}
		for _, entry := range obs.zone.Spec.Backends {
			if entry.Service == bs.Name {
				obs.zoneListed = true
			}
		}
	}

	// The credential allowlist (the control) and the host lint (a warning).
	lookup := memoSecretLookup(r.secretMetadata(ctx, bs.Namespace))
	obs.violations, obs.unverified = checkFunctionSovereignty(bs, obs.zone, others, lookup)
	obs.lint = lintForeignDatabaseHosts(bs, obs.zone, others)
	// What is RUNNING is read before anything is rendered, but its verdict is
	// acted on ONLY when the spec cannot be rolled out: the pass is undecided, or
	// the rollout fails (a webhook refuses the Service, a mount path is rejected).
	// Then the old template is what stays up, and a Secret revoked since it was
	// rendered must not stay with it. When an accepted spec rolls out, the new
	// template REPLACES the old one, so nothing revoked survives it, and a Secret
	// the old template names that has since gone (a routine rotation: the new
	// version is created, the spec points at it, the old one is pruned) is not a
	// violation and never tears a healthy function down.
	running, err := r.existingFunctionService(ctx, bs)
	if err != nil {
		return ctrl.Result{}, err
	}
	runViolations, runUnverified := checkRunningSovereignty(bs, obs.zone, others, lookup, running)
	if obs.undecided() {
		obs.violations = append(obs.violations, runViolations...)
		obs.unverified = mergeUnverified(obs.unverified, runUnverified)
	}
	now := time.Now()
	obs.deniedSince = nextDeniedSince(bs.Status.SecretsDeniedSince, hasDenied(obs.unverified), now)
	obs.violations, obs.unverified = escalateDeniedSecrets(obs.violations, obs.unverified, obs.deniedSince, now)

	served, revision := bs.Status.ServedProtoVersion, bs.Status.ObservedRevision
	// heldErr is returned AFTER the verdict is applied: an undecided pass reports
	// SecretsUnverified in status, then requeues with backoff.
	var heldErr error
	if obs.undecided() {
		// A Secret lookup that errored (not NotFound) says nothing about the
		// Secret's marks. Like the JWKS read below, hold the error: a running,
		// previously accepted function must not be deleted on an apiserver blip
		// (nothing is rendered, nothing removed), and one never rendered stays
		// unrendered (fail closed on new access).
		heldErr = unverifiedSecretsError(obs.unverified)
		logger.Error(heldErr, "Could not verify the function's Secrets; leaving it as it is")
		obs.ksvc = running
	} else if obs.accepted() {
		ksvc, renderErr, rollErr := r.rollout(ctx, bs, &obs)
		stuckOnRevoked := rollErr != nil && len(runViolations) > 0
		if rollErr != nil && !stuckOnRevoked {
			logger.Error(rollErr, "Failed to roll the function out")
			return ctrl.Result{}, rollErr
		}
		if stuckOnRevoked {
			// The new spec cannot be rolled out, so the RUNNING template stays,
			// and it mounts a Secret that is definitively no longer allowed:
			// refuse it, as a refused function keeps nothing it rendered.
			logger.Error(rollErr, "Failed to roll the function out, and its running Knative Service mounts a Secret it may not")
			obs.violations = append(obs.violations, runViolations...)
			if rmErr := r.removeRendered(ctx, bs); rmErr != nil {
				return ctrl.Result{}, rmErr
			}
			served, revision = "", ""
			heldErr = rollErr
		} else {
			obs.renderErr = renderErr
			obs.ksvc = ksvc
			if ksvc != nil {
				served, revision = r.servedVersion(ctx, ksvc, served, revision)
			}
		}
	} else {
		// Fail closed: a refused function keeps nothing it rendered before.
		if err := r.removeRendered(ctx, bs); err != nil {
			return ctrl.Result{}, err
		}
		served, revision = "", ""
	}

	verdict := computeBackendServiceVerdict(bs, obs)
	bs.Status.ObservedGeneration = verdict.observedGeneration
	bs.Status.SecretsDeniedSince = verdict.secretsDeniedSince
	bs.Status.ServedProtoVersion = served
	bs.Status.ObservedRevision = revision
	if obs.ksvc != nil {
		bs.Status.URL = functionURL(bs.Name, bs.Namespace)
		bs.Status.ServiceAccountName = FunctionServiceAccountName(bs.Name)
	} else {
		bs.Status.URL = ""
		bs.Status.ServiceAccountName = ""
	}
	if err := r.applyFunctionVerdict(ctx, bs, observed, verdict); err != nil {
		return ctrl.Result{}, err
	}
	if heldErr != nil {
		return ctrl.Result{}, heldErr
	}
	return ctrl.Result{RequeueAfter: verdict.requeueAfter}, nil
}

// applyFunctionVerdict emits the verdict's events, sets its conditions in
// order and writes status only when it changed (the no-op guard).
func (r *BackendServiceReconciler) applyFunctionVerdict(
	ctx context.Context,
	bs *appsv1alpha1.BackendService,
	observed *appsv1alpha1.BackendServiceStatus,
	v functionVerdict,
) error {
	for _, ev := range v.events {
		if r.Recorder != nil {
			r.Recorder.Event(bs, ev.eventType, ev.reason, ev.message)
		}
	}
	if v.refusal != "" {
		backendServiceRefusalsTotal.WithLabelValues(v.refusal).Inc()
	}
	for _, c := range v.conditions {
		apimeta.SetStatusCondition(&bs.Status.Conditions, c)
	}
	if apiequality.Semantic.DeepEqual(observed, &bs.Status) {
		return nil
	}
	return r.Status().Update(ctx, bs)
}

// secretMetadata returns a lookup that reads ONLY a Secret's metadata through
// the uncached reader (never its data, never an informer).
func (r *BackendServiceReconciler) secretMetadata(ctx context.Context, namespace string) secretLookup {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	return func(name string) secretMetadata {
		meta := &metav1.PartialObjectMetadata{}
		meta.SetGroupVersionKind(corev1.SchemeGroupVersion.WithKind("Secret"))
		err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, meta)
		switch {
		case err == nil:
			return secretMetadata{found: true, labels: meta.Labels, ownerRefs: meta.OwnerReferences}
		case apierrors.IsNotFound(err):
			return secretMetadata{}
		default:
			// A failed read is never a verdict: it is held, and only a denied
			// one is held for a bounded time.
			return secretMetadata{readErr: err.Error(), denied: classifyReadError(err) == readDenied}
		}
	}
}

// readClass says how a failed Secret metadata read is held. Neither class is a
// verdict: a failed read never refuses a function by itself.
type readClass int

const (
	// readTransient: held without limit. This is the default for EVERY failed
	// read that is not an authorization failure: timeouts, 429, 5xx, transport
	// errors, and anything nobody anticipated. It says nothing about the Secret.
	readTransient readClass = iota
	// readDenied: Forbidden or Unauthorized (401 or 403). Held, but only for
	// secretsDeniedHold counted from the first denial.
	readDenied
)

// classifyReadError sorts a failed read. The default is HELD: an unrecognised
// error must never be able to tear a running function down. The only definitive
// answers are a NotFound (handled before this is called) and a name no Secret
// can have (refused before any read).
func classifyReadError(err error) readClass {
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
		return readDenied
	}
	return readTransient
}

// memoSecretLookup reads each Secret at most once per pass, so the spec's and
// the running template's references to the same Secret agree and cost one GET.
func memoSecretLookup(lookup secretLookup) secretLookup {
	seen := map[string]secretMetadata{}
	return func(name string) secretMetadata {
		if m, ok := seen[name]; ok {
			return m
		}
		m := lookup(name)
		seen[name] = m
		return m
	}
}

// mergeUnverified appends the unverified Secrets of b not already in a.
func mergeUnverified(a, b []unverifiedSecret) []unverifiedSecret {
	for _, u := range b {
		dup := false
		for _, x := range a {
			if x.name == u.name {
				dup = true
			}
		}
		if !dup {
			a = append(a, u)
		}
	}
	return a
}

// rollout rolls the accepted spec out: it reads the zone's JWKS state, then
// renders the function. A non-nil error means the spec could NOT be rolled out
// (and a failed JWKS read is returned, not guessed at: it says nothing about
// ownership, and flipping a running function's mount on an apiserver blip would
// roll a revision for no reason).
func (r *BackendServiceReconciler) rollout(
	ctx context.Context,
	bs *appsv1alpha1.BackendService,
	obs *functionObservation,
) (*servingv1.Service, string, error) {
	var err error
	if obs.jwks, obs.jwksDetail, err = r.observeZoneJWKS(ctx, bs.Namespace, obs.zone); err != nil {
		return nil, "", err
	}
	return r.render(ctx, bs, obs.zone, obs.jwks)
}

// existingFunctionService returns the function's Knative Service as it stands
// (nil when there is none, or when another object controls the name), so a pass
// that rendered nothing still reports what is running.
func (r *BackendServiceReconciler) existingFunctionService(ctx context.Context, bs *appsv1alpha1.BackendService) (*servingv1.Service, error) {
	ksvc := &servingv1.Service{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: bs.Namespace, Name: bs.Name}, ksvc); err != nil {
		return nil, client.IgnoreNotFound(err)
	}
	if !metav1.IsControlledBy(ksvc, bs) {
		return nil, nil
	}
	return ksvc, nil
}

// unverifiedSecretsError names the Secrets whose metadata could not be read.
func unverifiedSecretsError(u []unverifiedSecret) error {
	parts := make([]string, 0, len(u))
	for _, s := range u {
		parts = append(parts, fmt.Sprintf("%q (%s)", s.name, s.err))
	}
	return fmt.Errorf("reading the metadata of Secret(s) %s: no answer, so the function is neither "+
		"rendered nor removed", strings.Join(parts, ", "))
}

// observeZoneJWKS reads the metadata of the ConfigMap at the zone's JWKS name
// through the uncached reader (never its data, never an informer) and says
// whether the zone controls it. NotFound is a state (absent), not an error.
func (r *BackendServiceReconciler) observeZoneJWKS(
	ctx context.Context,
	namespace string,
	zone *appsv1alpha1.NextApp,
) (zoneJWKSState, string, error) {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	name := ZoneJWKSConfigMapName(zone.Name)
	meta := &metav1.PartialObjectMetadata{}
	meta.SetGroupVersionKind(corev1.SchemeGroupVersion.WithKind("ConfigMap"))
	switch err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, meta); {
	case apierrors.IsNotFound(err):
		state, detail := classifyZoneJWKS(nil, zone)
		return state, detail, nil
	case err != nil:
		return zoneJWKSAbsent, "", fmt.Errorf("reading the metadata of ConfigMap %s: %w", name, err)
	default:
		state, detail := classifyZoneJWKS(meta, zone)
		return state, detail, nil
	}
}

// render creates or updates the function's ServiceAccount, Knative Service and
// NetworkPolicy. A child name that another object already controls is reported
// as renderErr (the function is then not Ready), never taken over.
func (r *BackendServiceReconciler) render(
	ctx context.Context,
	bs *appsv1alpha1.BackendService,
	zone *appsv1alpha1.NextApp,
	jwks zoneJWKSState,
) (*servingv1.Service, string, error) {
	sa := &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: FunctionServiceAccountName(bs.Name), Namespace: bs.Namespace}}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, sa, func() error {
		if sa.Labels == nil {
			sa.Labels = map[string]string{}
		}
		for k, v := range functionLabels(bs) {
			sa.Labels[k] = v
		}
		// No Role or RoleBinding is ever created for it, and no token is mounted.
		sa.AutomountServiceAccountToken = ptr.To(false)
		sa.ImagePullSecrets = bs.Spec.ImagePullSecrets
		return ctrl.SetControllerReference(bs, sa, r.Scheme)
	}); err != nil {
		if msg := alreadyOwned(err, "ServiceAccount", sa.Name); msg != "" {
			return nil, msg, nil
		}
		return nil, "", err
	}

	// The zone's rendered Knative Service decides the function's retention.
	var zoneKsvc *servingv1.Service
	candidate := &servingv1.Service{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: zone.Namespace, Name: zone.Name}, candidate); err == nil {
		if metav1.IsControlledBy(candidate, zone) {
			zoneKsvc = candidate
		}
	} else if !apierrors.IsNotFound(err) {
		return nil, "", err
	}

	ksvc := &servingv1.Service{ObjectMeta: metav1.ObjectMeta{Name: bs.Name, Namespace: bs.Namespace}}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, ksvc, func() error {
		if err := buildFunctionKsvc(bs, zoneRetention(zoneKsvc), jwks, ksvc); err != nil {
			return err
		}
		return ctrl.SetControllerReference(bs, ksvc, r.Scheme)
	}); err != nil {
		if msg := alreadyOwned(err, "Knative Service", ksvc.Name); msg != "" {
			return nil, msg, nil
		}
		return nil, "", err
	}

	np := &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: FunctionNetworkPolicyName(bs.Name), Namespace: bs.Namespace}}
	desired := DesiredFunctionNetworkPolicy(bs.Name, bs.Spec.Zone, bs.Namespace)
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, np, func() error {
		np.Labels = desired.Labels
		np.Spec = desired.Spec
		return ctrl.SetControllerReference(bs, np, r.Scheme)
	}); err != nil {
		if msg := alreadyOwned(err, "NetworkPolicy", np.Name); msg != "" {
			return nil, msg, nil
		}
		return nil, "", err
	}
	return ksvc, "", nil
}

// alreadyOwned turns controller-runtime's AlreadyOwnedError into a status
// message; any other error returns "".
func alreadyOwned(err error, kind, name string) string {
	var owned *controllerutil.AlreadyOwnedError
	if errors.As(err, &owned) {
		return fmt.Sprintf("%s %q already exists and is controlled by %s %q; rename the function",
			kind, name, owned.Owner.Kind, owned.Owner.Name)
	}
	return ""
}

// servedVersion reads the version stamped on the function's latest READY
// revision. While none is Ready the previous values stand: the old revision is
// still the one serving.
func (r *BackendServiceReconciler) servedVersion(ctx context.Context, ksvc *servingv1.Service, prevServed, prevRevision string) (string, string) {
	ready := ksvc.Status.LatestReadyRevisionName
	if ready == "" {
		return prevServed, prevRevision
	}
	rev := &servingv1.Revision{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: ksvc.Namespace, Name: ready}, rev); err != nil {
		return prevServed, prevRevision
	}
	return rev.Annotations[ProtoVersionAnnotation], ready
}

// removeRendered deletes the function's Knative Service and NetworkPolicy when
// (and only when) this BackendService controls them, so a refused function never
// takes down an object that belongs to someone else. NotFound is success.
func (r *BackendServiceReconciler) removeRendered(ctx context.Context, bs *appsv1alpha1.BackendService) error {
	for _, obj := range []client.Object{
		&servingv1.Service{ObjectMeta: metav1.ObjectMeta{Name: bs.Name, Namespace: bs.Namespace}},
		&networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: FunctionNetworkPolicyName(bs.Name), Namespace: bs.Namespace}},
	} {
		if err := r.Get(ctx, client.ObjectKeyFromObject(obj), obj); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			return err
		}
		if !metav1.IsControlledBy(obj, bs) {
			continue
		}
		if err := r.Delete(ctx, obj); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

// functionsOfZone lists the BackendServices naming a zone (namespace-scoped, from
// the informer cache).
func (r *BackendServiceReconciler) functionsOfZone(ctx context.Context, namespace, zone string) []reconcile.Request {
	var list appsv1alpha1.BackendServiceList
	if err := r.List(ctx, &list, client.InNamespace(namespace)); err != nil {
		logf.FromContext(ctx).Error(err, "listing functions of a zone; they re-check on their periodic requeue")
		return nil
	}
	var reqs []reconcile.Request
	for i := range list.Items {
		if list.Items[i].Spec.Zone == zone {
			reqs = append(reqs, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&list.Items[i])})
		}
	}
	return reqs
}

// zoneToFunctions re-checks a zone's functions when the zone changes: its
// spec.backends (the zone half), its database Secrets (the allowlist), and any
// other zone's database Secrets (the deny rule) all live on NextApps, so every
// function in the namespace is re-checked when ANY zone there changes.
func (r *BackendServiceReconciler) zoneToFunctions(ctx context.Context, obj client.Object) []reconcile.Request {
	var list appsv1alpha1.BackendServiceList
	if err := r.List(ctx, &list, client.InNamespace(obj.GetNamespace())); err != nil {
		logf.FromContext(ctx).Error(err, "listing functions after a zone change; they re-check on their periodic requeue")
		return nil
	}
	reqs := make([]reconcile.Request, 0, len(list.Items))
	for i := range list.Items {
		reqs = append(reqs, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&list.Items[i])})
	}
	return reqs
}

// zoneKsvcToFunctions re-renders a zone's functions when the zone's own Knative
// Service changes (its retention decides theirs).
func (r *BackendServiceReconciler) zoneKsvcToFunctions(ctx context.Context, obj client.Object) []reconcile.Request {
	ref := metav1.GetControllerOf(obj)
	if ref == nil || ref.Kind != "NextApp" {
		return nil
	}
	return r.functionsOfZone(ctx, obj.GetNamespace(), ref.Name)
}

// SetupWithManager wires the reconciler. Status-only writes to a BackendService
// do not re-enqueue it (GenerationChangedPredicate on the primary watch, as for
// NextApp); owned children and zones do.
func (r *BackendServiceReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&appsv1alpha1.BackendService{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Owns(&servingv1.Service{}).
		Owns(&corev1.ServiceAccount{}).
		Owns(&networkingv1.NetworkPolicy{}).
		Watches(&appsv1alpha1.NextApp{}, handler.EnqueueRequestsFromMapFunc(r.zoneToFunctions)).
		Watches(&servingv1.Service{}, handler.EnqueueRequestsFromMapFunc(r.zoneKsvcToFunctions)).
		Named("backendservice").
		Complete(r)
}
