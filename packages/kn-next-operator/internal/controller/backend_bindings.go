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

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// The zone half of a function binding (ADR-0004 Amendment 2 Decisions 2, 3, 7).
//
// The NextApp reconciler is the ONLY renderer of the zone's Knative Service, so
// it renders the binding env itself, from the BackendServices it binds:
//
//	<NAME>_SERVICE_URL            http://<service>.<namespace>.svc.cluster.local
//	<NAME>_SERVICE_PROTO_VERSION  the function's status.servedProtoVersion (unset until served)
//	KNEXT_WAKE_FUNCTIONS          sorted, comma-separated binding names, minus opt-outs
//
// <NAME> is the backends[] entry's name upper-cased with '-' -> '_', the same
// derivation as the generated client's (packages/grpc config.ts urlEnvFor); the
// shared fixture testdata/zone-binding-env.json is asserted on both sides.
//
// It NEVER writes NextApp.spec: the values live only in the rendered template,
// so the CLI or a GitOps controller re-applying the user's spec never fights
// the operator (ADR-0001).

// WakeFunctionsEnv names the zone's wake list: the binding names the zone's
// process-start primer wakes, resolved through <NAME>_SERVICE_URL. Operator-
// owned; a public contract with the runtime (ADR-0066 D3).
const WakeFunctionsEnv = "KNEXT_WAKE_FUNCTIONS"

const (
	bindingURLSuffix          = "_SERVICE_URL"
	bindingProtoVersionSuffix = "_SERVICE_PROTO_VERSION"
)

// bindingEnvPrefix derives <NAME> from a backends[] entry's name.
func bindingEnvPrefix(name string) string {
	return strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
}

// BindingURLEnv is the variable holding a bound function's address.
func BindingURLEnv(name string) string { return bindingEnvPrefix(name) + bindingURLSuffix }

// BindingProtoVersionEnv is the variable holding a bound function's served
// contract version.
func BindingProtoVersionEnv(name string) string {
	return bindingEnvPrefix(name) + bindingProtoVersionSuffix
}

// functionURL is the cluster-local address of a function's Knative Service.
func functionURL(service, namespace string) string {
	return fmt.Sprintf("http://%s.%s.svc.cluster.local", service, namespace)
}

// zoneBindingState is the outcome of resolving one backends[] entry.
type zoneBindingState string

const (
	// bindingBound: the function names this zone in spec.zone (both halves agree).
	bindingBound zoneBindingState = "Bound"
	// bindingFunctionNotFound: no such BackendService (or it is being deleted).
	bindingFunctionNotFound zoneBindingState = "FunctionNotFound"
	// bindingCrossZone: the BackendService names ANOTHER zone. Refused.
	bindingCrossZone zoneBindingState = "CrossZone"
	// bindingConflictingOwner: the BackendService names this zone but carries a
	// controller ownerReference to another object. Refused, never overwritten.
	bindingConflictingOwner zoneBindingState = "ConflictingOwner"
)

// zoneBinding is one resolved backends[] entry.
type zoneBinding struct {
	name    string
	service string
	state   zoneBindingState
	// functionZone is the zone the BackendService names (for a cross-zone entry).
	functionZone       string
	servedProtoVersion string
	wakeAhead          bool
}

// zoneBindings is the resolved zone half. The zero value means "no
// spec.backends": nothing is rendered and no condition is reported.
type zoneBindings struct {
	// crdMissing: spec.backends is set but the BackendService kind is not
	// served by the cluster, so nothing can bind.
	crdMissing bool
	entries    []zoneBinding
}

// bindingEnvResult is what renderBindingEnv returns.
type bindingEnvResult struct {
	// env is the binding env to append, sorted by name. nil when none.
	env []corev1.EnvVar
	// collisions are the binding variables NOT rendered because the zone already
	// sets a same-named variable, sorted. nil when none.
	collisions []string
}

// renderBindingEnv computes the binding env for the zone's container. existing
// is the env the container already carries (operator system env, envMap,
// spec.env); a binding variable with a name already in it is skipped and
// reported, never overwritten. Only Bound entries render anything.
func renderBindingEnv(namespace string, existing []corev1.EnvVar, b zoneBindings) bindingEnvResult {
	taken := make(map[string]bool, len(existing))
	for _, e := range existing {
		taken[e.Name] = true
	}
	var res bindingEnvResult
	add := func(name, value string) {
		if taken[name] {
			res.collisions = append(res.collisions, name)
			return
		}
		res.env = append(res.env, corev1.EnvVar{Name: name, Value: value})
	}

	var wake []string
	for _, e := range b.entries {
		if e.state != bindingBound {
			continue
		}
		add(BindingURLEnv(e.name), functionURL(e.service, namespace))
		if e.servedProtoVersion != "" {
			add(BindingProtoVersionEnv(e.name), e.servedProtoVersion)
		}
		if e.wakeAhead {
			wake = append(wake, e.name)
		}
	}
	if len(wake) > 0 {
		sort.Strings(wake)
		add(WakeFunctionsEnv, strings.Join(wake, ","))
	}
	sort.Slice(res.env, func(i, j int) bool { return res.env[i].Name < res.env[j].Name })
	sort.Strings(res.collisions)
	return res
}

// applyBindingEnv appends the binding env to the zone's container (the one the
// NextApp reconciler builds) and returns the collisions. With no Bound entry it
// changes nothing at all, so a zone without bindings renders byte-identically.
func applyBindingEnv(ksvc *servingv1.Service, namespace string, b zoneBindings) []string {
	containers := ksvc.Spec.Template.Spec.Containers
	if len(containers) == 0 {
		return nil
	}
	res := renderBindingEnv(namespace, containers[0].Env, b)
	if len(res.env) > 0 {
		containers[0].Env = append(containers[0].Env, res.env...)
	}
	return res.collisions
}

// resolveZoneBindings resolves every spec.backends[] entry against the
// BackendServices in the zone's namespace (read from the informer cache). It
// never writes anything.
func (r *NextAppReconciler) resolveZoneBindings(ctx context.Context, app *appsv1alpha1.NextApp) (zoneBindings, error) {
	if len(app.Spec.Backends) == 0 {
		return zoneBindings{}, nil
	}
	if !r.BackendServiceCRDPresent {
		return zoneBindings{crdMissing: true}, nil
	}
	var out zoneBindings
	for _, entry := range app.Spec.Backends {
		zb := zoneBinding{name: entry.Name, service: entry.Service}
		bs := &appsv1alpha1.BackendService{}
		err := r.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: entry.Service}, bs)
		switch {
		case apimeta.IsNoMatchError(err):
			// The CRD went away after start-up: nothing can bind.
			return zoneBindings{crdMissing: true}, nil
		case errors.IsNotFound(err):
			zb.state = bindingFunctionNotFound
		case err != nil:
			return zoneBindings{}, err
		case !bs.DeletionTimestamp.IsZero():
			zb.state = bindingFunctionNotFound
		case bs.Spec.Zone != app.Name:
			zb.state = bindingCrossZone
			zb.functionZone = bs.Spec.Zone
		case conflictingController(bs, app) != "":
			zb.state = bindingConflictingOwner
		default:
			zb.state = bindingBound
			zb.servedProtoVersion = bs.Status.ServedProtoVersion
			zb.wakeAhead = bs.Spec.WakeAhead == nil || *bs.Spec.WakeAhead
		}
		out.entries = append(out.entries, zb)
	}
	sort.Slice(out.entries, func(i, j int) bool { return out.entries[i].name < out.entries[j].name })
	return out, nil
}

// conflictingController returns a description of the BackendService's
// controller ownerReference when it is NOT the given zone's NextApp, or "".
// A missing controller reference is not a conflict (the BackendService
// reconciler sets it).
func conflictingController(bs *appsv1alpha1.BackendService, zone *appsv1alpha1.NextApp) string {
	ref := metav1.GetControllerOf(bs)
	if ref == nil {
		return ""
	}
	if ref.Kind == "NextApp" && ref.Name == zone.Name && ref.UID == zone.UID &&
		strings.HasPrefix(ref.APIVersion, appsv1alpha1.GroupVersion.Group+"/") {
		return ""
	}
	return fmt.Sprintf("%s %s (uid %s)", ref.Kind, ref.Name, ref.UID)
}

// --- status (computed in computeStatusVerdict, never in Reconcile) -----------

const (
	// ConditionBackendBindings reports whether every spec.backends[] entry is
	// bound. Informational: Ready keeps reflecting whether the zone serves.
	// Absent when spec.backends is empty.
	ConditionBackendBindings = "BackendBindings"

	ReasonBackendsBound            = "Bound"
	ReasonCrossZoneBinding         = "CrossZoneBinding"
	ReasonConflictingFunctionOwner = "ConflictingFunctionOwner"
	ReasonBindingEnvCollision      = "BindingEnvCollision"
	ReasonBackendNotFound          = "BackendNotFound"
	ReasonBackendServiceCRDMissing = "BackendServiceCRDMissing"
)

// backendBindingsCondition builds the BackendBindings condition. The message is
// static for a given state, so a converged object's status write stays a no-op.
// Reason precedence: a cross-zone entry (a refused binding attempt) first, then
// a conflicting owner, then an env collision, then a missing function.
func backendBindingsCondition(app *appsv1alpha1.NextApp, b zoneBindings, collisions []string) metav1.Condition {
	c := metav1.Condition{Type: ConditionBackendBindings, ObservedGeneration: app.Generation}
	if b.crdMissing {
		c.Status = metav1.ConditionFalse
		c.Reason = ReasonBackendServiceCRDMissing
		c.Message = "spec.backends is set but the cluster does not serve the BackendService kind: " +
			"no function can bind. Install the operator's BackendService CRD."
		return c
	}
	var crossZone, conflicting, missing, bound []string
	for _, e := range b.entries {
		switch e.state {
		case bindingCrossZone:
			crossZone = append(crossZone, fmt.Sprintf("%q names BackendService %q, which belongs to zone %q", e.name, e.service, e.functionZone))
		case bindingConflictingOwner:
			conflicting = append(conflicting, fmt.Sprintf("%q names BackendService %q, which another object controls", e.name, e.service))
		case bindingFunctionNotFound:
			missing = append(missing, fmt.Sprintf("%q names BackendService %q, which does not exist", e.name, e.service))
		case bindingBound:
			bound = append(bound, e.name)
		}
	}
	var problems []string
	if len(crossZone) > 0 {
		problems = append(problems, "cross-zone binding refused: "+strings.Join(crossZone, "; "))
	}
	if len(conflicting) > 0 {
		problems = append(problems, "refused: "+strings.Join(conflicting, "; "))
	}
	if len(collisions) > 0 {
		problems = append(problems, "not rendered because spec.env or spec.secrets.envMap already sets them: "+
			strings.Join(collisions, ", "))
	}
	if len(missing) > 0 {
		problems = append(problems, "not bound: "+strings.Join(missing, "; "))
	}
	switch {
	case len(crossZone) > 0:
		c.Reason = ReasonCrossZoneBinding
	case len(conflicting) > 0:
		c.Reason = ReasonConflictingFunctionOwner
	case len(collisions) > 0:
		c.Reason = ReasonBindingEnvCollision
	case len(missing) > 0:
		c.Reason = ReasonBackendNotFound
	}
	if c.Reason != "" {
		c.Status = metav1.ConditionFalse
		c.Message = strings.Join(problems, ". ")
		return c
	}
	c.Status = metav1.ConditionTrue
	c.Reason = ReasonBackendsBound
	c.Message = fmt.Sprintf("%d function(s) bound: %s", len(bound), strings.Join(bound, ", "))
	return c
}

// backendServiceToZoneRequests maps a BackendService event to the zones that
// must re-render: the zone it names, and every zone in the namespace whose
// spec.backends lists it (so a cross-zone entry is reported as soon as the
// function appears). Lists come from the informer cache, namespace-scoped.
func (r *NextAppReconciler) backendServiceToZoneRequests(ctx context.Context, obj client.Object) []reconcile.Request {
	bs, ok := obj.(*appsv1alpha1.BackendService)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	var reqs []reconcile.Request
	enqueue := func(name string) {
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: bs.Namespace, Name: name}})
	}
	enqueue(bs.Spec.Zone)
	var apps appsv1alpha1.NextAppList
	if err := r.List(ctx, &apps, client.InNamespace(bs.Namespace)); err != nil {
		logf.FromContext(ctx).Error(err, "listing zones after a BackendService change; they re-render on their next reconcile")
		return reqs
	}
	for i := range apps.Items {
		for _, entry := range apps.Items[i].Spec.Backends {
			if entry.Service == bs.Name {
				enqueue(apps.Items[i].Name)
			}
		}
	}
	return reqs
}
