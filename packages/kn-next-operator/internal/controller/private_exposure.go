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
	"sort"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/types"
	"knative.dev/serving/pkg/apis/serving"
	servingv1beta1 "knative.dev/serving/pkg/apis/serving/v1beta1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// PrivateExposure: a Knative DomainMapping that targets a cluster-local
// NextApp's ksvc renders its KIngress with visibility ExternalIP — even when
// the DomainMapping itself is labelled cluster-local — so the "private" app is
// reachable through the public load balancer. spec.networking.visibility only
// labels the ksvc and cannot prevent that, so the operator DETECTS it and says
// so, read-only: the DomainMapping is the user's object and is never deleted or
// mutated here (the CR is the single source of truth, ADR-0001).

// ConditionPrivateExposure is True while at least one DomainMapping publishes a
// cluster-local app. It is a Warning-class condition: Ready is deliberately
// untouched, because the workload is healthy — the problem is exposure, not
// availability. The condition is absent whenever there is nothing to report.
const ConditionPrivateExposure = "PrivateExposure"

// ReasonDomainMappingPublishesPrivateApp is the reason (and Warning Event
// reason) for ConditionPrivateExposure.
const ReasonDomainMappingPublishesPrivateApp = "DomainMappingPublishesPrivateApp"

// privateExposureState carries the detection outcome into computeStatusVerdict
// (the verdict never does I/O).
type privateExposureState struct {
	// private mirrors spec.networking.visibility == cluster-local.
	private bool
	// domainMappings are the names of same-namespace DomainMappings whose
	// spec.ref targets this app's ksvc, sorted (message stability, #98).
	domainMappings []string
	// unknown: the list failed for a reason other than the CRD being absent.
	// A transient error is not evidence the exposure is gone, so the verdict
	// keeps whatever it said before.
	unknown bool
}

func isPrivate(app *appsv1alpha1.NextApp) bool {
	return app.Spec.Networking != nil && app.Spec.Networking.Visibility == appsv1alpha1.VisibilityClusterLocal
}

// ownerAppOf resolves which NextApp (== ksvc name) a DomainMapping ref
// publishes, or "" when it addresses something else. A ref may point at any
// addressable object in the namespace, and three shapes all reach the app
// through the same public path:
//   - the Knative Service (serving.knative.dev/v1 Service <app>);
//   - the Route every ksvc creates under the same name (serving.knative.dev/v1
//     Route <app>);
//   - a core v1 Service: the ksvc placeholder (<app>) or a per-revision
//     Service (<app>-00001), which carries the authoritative label
//     serving.knative.dev/service=<app>. The label is read with a Get rather
//     than guessing from a name prefix, which would false-match another app
//     whose name merely starts with this one's.
//
// err is non-nil only for a failed Get that is not a plain NotFound.
func (r *NextAppReconciler) ownerAppOf(ctx context.Context, dm *servingv1beta1.DomainMapping) (string, error) {
	ref := dm.Spec.Ref
	if ref.Name == "" {
		return "", nil
	}
	ns := ref.Namespace
	if ns == "" {
		ns = dm.Namespace
	}
	switch {
	case ref.APIVersion == "serving.knative.dev/v1" && (ref.Kind == "Service" || ref.Kind == "Route"):
		return ref.Name, nil
	case (ref.APIVersion == "v1" || ref.APIVersion == "") && ref.Kind == "Service":
		svc := &corev1.Service{}
		reader := r.APIReader
		if reader == nil {
			reader = r.Client
		}
		if reader == nil {
			return ref.Name, nil
		}
		if err := reader.Get(ctx, types.NamespacedName{Name: ref.Name, Namespace: ns}, svc); err != nil {
			if apierrors.IsNotFound(err) {
				// No such Service to resolve: the ksvc placeholder shares the
				// app's name, so the name itself still identifies the app.
				return ref.Name, nil
			}
			return "", err
		}
		if app := svc.Labels[serving.ServiceLabelKey]; app != "" {
			return app, nil
		}
		return ref.Name, nil
	}
	return "", nil
}

// detectPrivateExposure lists DomainMappings in the app's namespace and returns
// those targeting its ksvc. Only cluster-local apps are inspected. An absent
// DomainMapping CRD (Knative without domain-mapping) reads as "none".
func (r *NextAppReconciler) detectPrivateExposure(ctx context.Context, app *appsv1alpha1.NextApp) privateExposureState {
	st := privateExposureState{private: isPrivate(app)}
	if !st.private {
		return st
	}
	list := &servingv1beta1.DomainMappingList{}
	if err := r.List(ctx, list, client.InNamespace(app.Namespace)); err != nil {
		if apimeta.IsNoMatchError(err) {
			return st
		}
		st.unknown = true
		return st
	}
	for i := range list.Items {
		dm := &list.Items[i]
		if dm.Namespace != app.Namespace {
			continue
		}
		owner, err := r.ownerAppOf(ctx, dm)
		if err != nil {
			st.unknown = true
			return st
		}
		if owner == app.Name && (dm.Spec.Ref.Namespace == "" || dm.Spec.Ref.Namespace == app.Namespace) {
			st.domainMappings = append(st.domainMappings, dm.Name)
		}
	}
	sort.Strings(st.domainMappings)
	return st
}

// domainMappingToNextAppRequests maps a DomainMapping to the NextApp (== ksvc
// name) it targets, so creating one re-triggers reconcile promptly.
func (r *NextAppReconciler) domainMappingToNextAppRequests(ctx context.Context, obj client.Object) []reconcile.Request {
	dm, ok := obj.(*servingv1beta1.DomainMapping)
	if !ok {
		return nil
	}
	owner, err := r.ownerAppOf(ctx, dm)
	if err != nil || owner == "" {
		return nil
	}
	ns := dm.Spec.Ref.Namespace
	if ns == "" {
		ns = dm.Namespace
	}
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: owner, Namespace: ns}}}
}
