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

	apiequality "k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// KnextPlatform status conditions (ADR-0064).
const (
	// PlatformConditionAccepted: the object is the singleton and its spec passed
	// the operator's own validation. A platform that is not accepted is IGNORED.
	PlatformConditionAccepted = "Accepted"
	// PlatformConditionDefaultsPropagated: every NextApp has been rendered against
	// the current configuration, or Progressing with counts.
	PlatformConditionDefaultsPropagated = "DefaultsPropagated"
	// PlatformConditionReady: the platform is accepted and usable.
	PlatformConditionReady = "Ready"
)

// KnextPlatformReconciler maintains the KnextPlatform's own status. It is the
// ONLY writer of that object and writes only its status subresource: the spec is
// the cluster admin's (kubectl / GitOps), never the operator's and never the CLI's.
type KnextPlatformReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// computePlatformStatus is the PURE status computation for the platform: given
// the object and every NextApp, what Accepted / DefaultsPropagated / Ready say
// and how far the rollout has got. No I/O, so it is unit-testable without a
// cluster (platform_controller_test.go).
func computePlatformStatus(p *platformv1alpha1.KnextPlatform, apps []appsv1alpha1.NextApp) platformv1alpha1.KnextPlatformStatus {
	st := platformv1alpha1.KnextPlatformStatus{ObservedGeneration: p.Generation}

	acceptErr := validation.ValidatePlatformSpec(&p.Spec)
	if p.Name != platformv1alpha1.SingletonName {
		acceptErr = fmt.Errorf("only a KnextPlatform named %q is honoured, this one is %q",
			platformv1alpha1.SingletonName, p.Name)
	}

	if acceptErr != nil {
		msg := acceptErr.Error()
		st.Conditions = []metav1.Condition{
			{Type: PlatformConditionAccepted, Status: metav1.ConditionFalse, Reason: "NotAccepted", Message: msg, ObservedGeneration: p.Generation},
			{Type: PlatformConditionDefaultsPropagated, Status: metav1.ConditionFalse, Reason: "NotAccepted",
				Message: "this platform is ignored, so nothing is propagated from it: built-in defaults apply", ObservedGeneration: p.Generation},
			{Type: PlatformConditionReady, Status: metav1.ConditionFalse, Reason: "NotAccepted", Message: msg, ObservedGeneration: p.Generation},
		}
		return st
	}

	acceptedMsg := "the spec is valid and this is the singleton"
	if p.Spec.Profile == platformv1alpha1.ProfileFastColdStart {
		// Honest status: the enum value is part of the API, its effect is not.
		acceptedMsg = "the spec is valid; profile fastColdStart is accepted but sets no value in this release"
	}

	want := platformSpecHash(&p.Spec)
	var rollout platformv1alpha1.PlatformRolloutStatus
	for i := range apps {
		app := &apps[i]
		switch {
		case isHeldByPlatform(app):
			rollout.Held++
		case app.Status.Platform != nil && app.Status.Platform.SpecHash == want:
			rollout.Applied++
		default:
			rollout.Pending++
		}
	}
	st.Rollout = &rollout

	prop := metav1.Condition{
		Type: PlatformConditionDefaultsPropagated, ObservedGeneration: p.Generation,
	}
	switch {
	case rollout.Pending > 0:
		prop.Status, prop.Reason = metav1.ConditionFalse, "Progressing"
		prop.Message = fmt.Sprintf("%d pending, %d applied, %d held", rollout.Pending, rollout.Applied, rollout.Held)
	case rollout.Held > 0:
		prop.Status, prop.Reason = metav1.ConditionFalse, "Held"
		prop.Message = fmt.Sprintf("%d app(s) are held because the platform would make their effective spec invalid; %d applied",
			rollout.Held, rollout.Applied)
	default:
		prop.Status, prop.Reason = metav1.ConditionTrue, "Propagated"
		prop.Message = fmt.Sprintf("%d app(s) rendered against this configuration", rollout.Applied)
	}

	st.Conditions = []metav1.Condition{
		{Type: PlatformConditionAccepted, Status: metav1.ConditionTrue, Reason: "Accepted", Message: acceptedMsg, ObservedGeneration: p.Generation},
		prop,
		{Type: PlatformConditionReady, Status: metav1.ConditionTrue, Reason: "Ready", Message: "the platform is in force", ObservedGeneration: p.Generation},
	}
	return st
}

// isHeldByPlatform reports whether the app's last verdict was a hold because of
// the platform's values.
func isHeldByPlatform(app *appsv1alpha1.NextApp) bool {
	c := apimeta.FindStatusCondition(app.Status.Conditions, ConditionPlatformDefaultsApplied)
	return c != nil && c.Status == metav1.ConditionFalse && c.Reason == ReasonEffectiveSpecInvalid
}

// +kubebuilder:rbac:groups=platform.kn-next.dev,resources=knextplatforms,verbs=get;list;watch
// +kubebuilder:rbac:groups=platform.kn-next.dev,resources=knextplatforms/status,verbs=get;update;patch

// Reconcile recomputes the platform's status from the cluster's NextApps.
func (r *KnextPlatformReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var p platformv1alpha1.KnextPlatform
	if err := r.Get(ctx, req.NamespacedName, &p); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	var apps appsv1alpha1.NextAppList
	if err := r.List(ctx, &apps); err != nil {
		return ctrl.Result{}, err
	}

	observed := p.Status.DeepCopy()
	desired := computePlatformStatus(&p, apps.Items)

	p.Status.ObservedGeneration = desired.ObservedGeneration
	p.Status.Rollout = desired.Rollout
	// SetStatusCondition preserves LastTransitionTime on an unchanged condition,
	// so the no-op guard below holds for a converged object.
	p.Status.Conditions = observed.DeepCopy().Conditions
	for _, c := range desired.Conditions {
		apimeta.SetStatusCondition(&p.Status.Conditions, c)
	}

	if apiequality.Semantic.DeepEqual(observed, &p.Status) {
		return ctrl.Result{}, nil
	}
	logf.FromContext(ctx).V(1).Info("updating KnextPlatform status", "name", p.Name)
	return ctrl.Result{}, r.Status().Update(ctx, &p)
}

// nextAppToPlatformRequests maps ANY NextApp event to the singleton: its rollout
// counts depend on every app's status.
func nextAppToPlatformRequests(context.Context, client.Object) []reconcile.Request {
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: platformv1alpha1.SingletonName}}}
}

// platformRelevantNextAppChange fires only when something the platform status is
// computed from moved: the app appeared or went away, its status.platform
// changed, or its PlatformDefaultsApplied condition changed. Every other NextApp
// status write (URL, traffic, ...) would otherwise re-run a list over every app.
var platformRelevantNextAppChange = predicate.Funcs{
	UpdateFunc: func(e event.UpdateEvent) bool {
		oldApp, ok1 := e.ObjectOld.(*appsv1alpha1.NextApp)
		newApp, ok2 := e.ObjectNew.(*appsv1alpha1.NextApp)
		if !ok1 || !ok2 {
			return true
		}
		if !apiequality.Semantic.DeepEqual(oldApp.Status.Platform, newApp.Status.Platform) {
			return true
		}
		oldC := apimeta.FindStatusCondition(oldApp.Status.Conditions, ConditionPlatformDefaultsApplied)
		newC := apimeta.FindStatusCondition(newApp.Status.Conditions, ConditionPlatformDefaultsApplied)
		return !apiequality.Semantic.DeepEqual(oldC, newC)
	},
}

// SetupWithManager wires the platform reconciler. Call it only when
// PlatformCRDInstalled: without the CRD there is no kind to watch.
func (r *KnextPlatformReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		// Spec edits only: this controller's own status writes must not re-enter it.
		For(&platformv1alpha1.KnextPlatform{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Watches(&appsv1alpha1.NextApp{},
			handler.EnqueueRequestsFromMapFunc(nextAppToPlatformRequests),
			builder.WithPredicates(platformRelevantNextAppChange)).
		Named("knextplatform").
		Complete(r)
}
