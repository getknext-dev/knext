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
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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

// refGetTimeout bounds the per-DomainMapping uncached Get.
const refGetTimeout = 5 * time.Second

// ownerAppOf resolves which NextApp (== ksvc name) a DomainMapping ref
// publishes, or "" when it addresses something else. A ref may point at ANY
// addressable object in the namespace (Knative Service, Route, Revision, a
// core Service, ...), so the match is generic rather than a list of shapes:
//   - the ksvc itself (serving.knative.dev/v1 Service) matches by name;
//   - every other ref is fetched as unstructured (uncached) and matches by the
//     label serving.knative.dev/service=<app>, which Knative stamps on the
//     Routes, Revisions and Route-owned k8s Services of a ksvc. A label is
//     authoritative where a name prefix would false-match a different app.
//
// A Service/Route that does not exist yet still identifies the app by name
// (the ksvc placeholder shares it). A failed Get (forbidden, unknown kind,
// transient) returns the ref name alongside the error so the caller can
// decide; the detector fails closed when that name equals the app's.
func (r *NextAppReconciler) ownerAppOf(ctx context.Context, dm *servingv1beta1.DomainMapping) (string, error) {
	ref := dm.Spec.Ref
	if ref.Name == "" {
		return "", nil
	}
	ns := ref.Namespace
	if ns == "" {
		ns = dm.Namespace
	}
	if ref.APIVersion == "serving.knative.dev/v1" && ref.Kind == "Service" {
		return ref.Name, nil
	}
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	if reader == nil {
		return ref.Name, nil
	}
	obj := &unstructured.Unstructured{}
	obj.SetAPIVersion(ref.APIVersion)
	obj.SetKind(ref.Kind)
	// Bound the uncached Get so a slow apiserver cannot stall a reconcile or
	// the watch map func.
	ctx, cancel := context.WithTimeout(ctx, refGetTimeout)
	defer cancel()
	if err := reader.Get(ctx, types.NamespacedName{Name: ref.Name, Namespace: ns}, obj); err != nil {
		if apierrors.IsNotFound(err) {
			if ref.Kind == "Service" || ref.Kind == "Route" {
				return ref.Name, nil
			}
			return "", nil
		}
		return ref.Name, err
	}
	return obj.GetLabels()[serving.ServiceLabelKey], nil
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
	// One unresolvable mapping must not stop the scan: a persistently failing
	// ref (say, Forbidden every time) would otherwise blind detection for every
	// private app in the namespace. Exposure found wins over unknowns.
	unresolved := false
	for i := range list.Items {
		dm := &list.Items[i]
		if dm.Namespace != app.Namespace {
			continue
		}
		owner, err := r.ownerAppOf(ctx, dm)
		if err != nil {
			// Cannot resolve the ref (forbidden, unknown kind, transient). If its
			// NAME equals the app's it is far more likely a leak than not, and a
			// false positive is only a warning, so fail closed; otherwise keep
			// the prior verdict rather than guess.
			if dm.Spec.Ref.Name == app.Name {
				st.domainMappings = append(st.domainMappings, dm.Name)
				continue
			}
			unresolved = true
			continue
		}
		if owner == app.Name && (dm.Spec.Ref.Namespace == "" || dm.Spec.Ref.Namespace == app.Namespace) {
			st.domainMappings = append(st.domainMappings, dm.Name)
		}
	}
	sort.Strings(st.domainMappings)
	if len(st.domainMappings) == 0 && unresolved {
		st.unknown = true
	}
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
	if err != nil {
		// A failed Get must not drop the event, and the ref name need not be a
		// NextApp (a Revision or Service name is not): enqueue every
		// cluster-local NextApp in the namespace, whose reconcile re-runs
		// detection with the same fail-closed rule. Public apps are skipped.
		apps := &appsv1alpha1.NextAppList{}
		if lerr := r.List(ctx, apps, client.InNamespace(dm.Namespace)); lerr != nil {
			return nil
		}
		var reqs []reconcile.Request
		for i := range apps.Items {
			if isPrivate(&apps.Items[i]) {
				reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{
					Name: apps.Items[i].Name, Namespace: apps.Items[i].Namespace}})
			}
		}
		return reqs
	}
	if owner == "" {
		return nil
	}
	ns := dm.Spec.Ref.Namespace
	if ns == "" {
		ns = dm.Namespace
	}
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: owner, Namespace: ns}}}
}
