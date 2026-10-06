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

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/types"
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

// refTargetsKsvc reports whether a DomainMapping ref addresses the Service
// named like the NextApp (the ksvc name == the NextApp name). Both the Knative
// Service ref and a plain Kubernetes Service ref of that name resolve to the
// same routable name, so both count.
func refTargetsKsvc(dm *servingv1beta1.DomainMapping, app *appsv1alpha1.NextApp) bool {
	ref := dm.Spec.Ref
	if ref.Name != app.Name || ref.Kind != "Service" {
		return false
	}
	if ref.Namespace != "" && ref.Namespace != app.Namespace {
		return false
	}
	return ref.APIVersion == "v1" || ref.APIVersion == "serving.knative.dev/v1" || ref.APIVersion == ""
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
		if refTargetsKsvc(&list.Items[i], app) {
			st.domainMappings = append(st.domainMappings, list.Items[i].Name)
		}
	}
	sort.Strings(st.domainMappings)
	return st
}

// domainMappingToNextAppRequests maps a DomainMapping to the NextApp (== ksvc
// name) it targets, so creating one re-triggers reconcile promptly.
func (r *NextAppReconciler) domainMappingToNextAppRequests(_ context.Context, obj client.Object) []reconcile.Request {
	dm, ok := obj.(*servingv1beta1.DomainMapping)
	if !ok || dm.Spec.Ref.Name == "" {
		return nil
	}
	ns := dm.Spec.Ref.Namespace
	if ns == "" {
		ns = dm.Namespace
	}
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: dm.Spec.Ref.Name, Namespace: ns}}}
}
