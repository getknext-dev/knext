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
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// The BackendService status verdict: the PURE half of the reconciler, the
// counterpart of computeStatusVerdict for NextApp (architecture.md §4: honest
// status is computed in one pure function, never in branches of Reconcile).
// Reconcile observes (functionObservation), this computes, and
// applyFunctionVerdict applies. backendservice_inline_status_guard_test.go
// fails if a status condition is set anywhere else in the reconciler.

const (
	// ConditionFunctionBound: both halves of the binding agree (the zone exists,
	// lists the function in spec.backends, and the controller ownerReference is
	// the zone's).
	ConditionFunctionBound = "Bound"
	// ConditionSovereigntyCompliant: every Secret and ConfigMap reference passes
	// the credential allowlist, which IS the data-sovereignty control.
	ConditionSovereigntyCompliant = "SovereigntyCompliant"
	// ConditionDatabaseHostLint: the env-literal database-host heuristic. A LINT:
	// False is a warning and never stops the function from rendering.
	ConditionDatabaseHostLint = "DatabaseHostLint"

	// ConditionJWKSTrusted: the zone's JWKS ConfigMap is mounted only when the
	// zone's NextApp controls it. True: it does, and it is mounted. Unknown: it
	// does not exist yet (the mount is optional) or nothing is rendered. False
	// (JWKSUntrusted): another object holds the name, so it is NOT mounted and
	// the function refuses every call except health.
	ConditionJWKSTrusted = "JWKSTrusted"

	ReasonJWKSControlled   = "Controlled"
	ReasonJWKSNotPublished = "NotPublished"
	ReasonJWKSUntrusted    = "JWKSUntrusted"
	ReasonJWKSNotRendered  = "NotRendered"

	ReasonFunctionBound           = "Bound"
	ReasonZoneNotFound            = "ZoneNotFound"
	ReasonZoneNotListed           = "ZoneNotListed"
	ReasonConflictingOwner        = "ConflictingOwner"
	ReasonCompliant               = "Compliant"
	ReasonSecretNotAllowed        = "SecretNotAllowed"
	ReasonSecretsUnverified       = "SecretsUnverified"
	ReasonSovereigntyViolation    = "SovereigntyViolation"
	ReasonNoForeignDatabaseHost   = "NoForeignDatabaseHost"
	ReasonForeignDatabaseHost     = "ForeignDatabaseHost"
	ReasonKnativeServiceNameTaken = "KnativeServiceNameTaken"
	ReasonFunctionNotReady        = "KnativeServiceNotReady"
	ReasonFunctionReady           = "Ready"

	// functionNotReadyRequeueAfter re-checks a rendered function that is not Ready.
	functionNotReadyRequeueAfter = 30 * time.Second
	// functionRevalidateAfter re-runs the allowlist periodically: a Secret's
	// marks can change without any event the operator watches (it holds no
	// Secret list/watch, by design).
	functionRevalidateAfter = 10 * time.Minute
)

// databaseHostLintDisclaimer is part of every DatabaseHostLint message, so no
// status ever presents the heuristic as the control (ADR-0004 Amendment 2
// Decision 6).
const databaseHostLintDisclaimer = "This is a lint (a heuristic over env literals), not the data-sovereignty " +
	"control: an IP address, an ExternalName Service or a URL built at run time gets past it. " +
	"The control is the credential allowlist: the function holds no credential for another zone's database."

// functionObservation is everything Reconcile observed this pass.
type functionObservation struct {
	// invalidImage is the image validation error, or "".
	invalidImage string
	// zone is the resolved owning NextApp; nil when it does not exist.
	zone *appsv1alpha1.NextApp
	// conflictingOwner describes a controller ownerReference that is not the
	// zone's, or "".
	conflictingOwner string
	// zoneListed: the zone's spec.backends[] names this function (zone half).
	zoneListed bool
	violations []sovereigntyViolation
	// unverified are referenced Secrets whose metadata could not be read: no
	// answer, so neither a violation nor a pass (#2498).
	unverified []unverifiedSecret
	lint       []databaseHostFinding
	// renderErr is a failure to render a child that is not an API hiccup (a
	// name already controlled by another object), or "".
	renderErr string
	// ksvc is the function's Knative Service as rendered this pass; nil when the
	// function is refused (nothing rendered).
	ksvc *servingv1.Service
	// jwks is what was found at the zone's JWKS ConfigMap name; jwksDetail says
	// why it is untrusted.
	jwks       zoneJWKSState
	jwksDetail string
}

// accepted reports whether the function may be rendered: a valid image, both
// halves of the binding, the zone's own controller reference, and no allowlist
// violation. Fail closed: anything else renders nothing.
func (o functionObservation) accepted() bool {
	return o.invalidImage == "" && o.zone != nil && o.conflictingOwner == "" && o.zoneListed && len(o.violations) == 0
}

// undecided reports whether the function would be accepted but for Secret
// lookups that returned no answer. Reconcile must then neither render nor tear
// down: it returns the error and requeues, leaving the function as it is.
func (o functionObservation) undecided() bool {
	return len(o.unverified) > 0 && o.accepted()
}

// unverifiedNames lists the Secrets whose metadata could not be read.
func (o functionObservation) unverifiedNames() string {
	names := make([]string, 0, len(o.unverified))
	for _, u := range o.unverified {
		names = append(names, fmt.Sprintf("Secret %q", u.name))
	}
	return strings.Join(names, ", ")
}

// functionVerdict is the full status outcome of one pass.
type functionVerdict struct {
	// conditions are set in this order (the persisted order is part of the
	// no-op status guard, as for NextApp).
	conditions   []metav1.Condition
	events       []verdictEvent
	requeueAfter time.Duration
	// refusal is the Ready reason when the function newly ENTERED a refusal
	// this pass (a transition), for the refusals metric; "" otherwise.
	refusal string
}

// computeBackendServiceVerdict computes conditions, transition-gated events
// and the requeue. Messages are static for a given state, so a converged
// object's status write is a no-op.
func computeBackendServiceVerdict(bs *appsv1alpha1.BackendService, o functionObservation) functionVerdict {
	var v functionVerdict
	gen := bs.Generation
	cond := func(t string, s metav1.ConditionStatus, reason, msg string) metav1.Condition {
		return metav1.Condition{Type: t, Status: s, ObservedGeneration: gen, Reason: reason, Message: msg}
	}

	// Bound — names the missing half.
	var bound metav1.Condition
	switch {
	case o.zone == nil:
		bound = cond(ConditionFunctionBound, metav1.ConditionFalse, ReasonZoneNotFound, fmt.Sprintf(
			"zone %q (a NextApp in namespace %q) does not exist: nothing is rendered or mounted", bs.Spec.Zone, bs.Namespace))
	case o.conflictingOwner != "":
		bound = cond(ConditionFunctionBound, metav1.ConditionFalse, ReasonConflictingOwner, fmt.Sprintf(
			"the controller ownerReference is %s, not zone %q; the operator never overwrites it. "+
				"Remove it and the operator sets the zone's", o.conflictingOwner, bs.Spec.Zone))
	case !o.zoneListed:
		bound = cond(ConditionFunctionBound, metav1.ConditionFalse, ReasonZoneNotListed, fmt.Sprintf(
			"zone %q does not list this function in spec.backends (the zone half of the binding is missing): "+
				"nothing is rendered or mounted until it does", bs.Spec.Zone))
	default:
		bound = cond(ConditionFunctionBound, metav1.ConditionTrue, ReasonFunctionBound, fmt.Sprintf(
			"bound to zone %q: the function names it and the zone lists the function", bs.Spec.Zone))
	}
	v.conditions = append(v.conditions, bound)

	// SovereigntyCompliant — the control.
	var sov metav1.Condition
	switch {
	case len(o.violations) > 0:
		parts := make([]string, 0, len(o.violations))
		for _, viol := range o.violations {
			parts = append(parts, viol.String())
		}
		sov = cond(ConditionSovereigntyCompliant, metav1.ConditionFalse, ReasonSecretNotAllowed,
			"refused by the credential allowlist (nothing is rendered): "+strings.Join(parts, "; "))
	case o.zone == nil:
		sov = cond(ConditionSovereigntyCompliant, metav1.ConditionUnknown, ReasonZoneNotFound,
			"the allowlist cannot be evaluated without the zone")
	case o.undecided():
		// No answer, which is not a violation: the function is neither rendered
		// nor removed this pass (a static message: it names Secrets, never the
		// transient error, so a persistent condition does not churn status).
		sov = cond(ConditionSovereigntyCompliant, metav1.ConditionUnknown, ReasonSecretsUnverified,
			"could not read the metadata of "+o.unverifiedNames()+
				"; retrying with backoff. A running function is left as it is, and one never rendered stays unrendered")
	default:
		sov = cond(ConditionSovereigntyCompliant, metav1.ConditionTrue, ReasonCompliant,
			"every Secret reference is the zone's own database Secret or marked for the zone")
	}
	v.conditions = append(v.conditions, sov)

	// JWKSTrusted — whether the zone's key set reaches the function. Evaluated
	// only for a function that renders; a refused one mounts nothing.
	jwksName := ZoneJWKSConfigMapName(bs.Spec.Zone)
	var jwks metav1.Condition
	switch {
	case o.undecided():
		// Nothing was re-evaluated this pass: carry the last verdict forward.
		if prev := apimeta.FindStatusCondition(bs.Status.Conditions, ConditionJWKSTrusted); prev != nil {
			jwks = cond(ConditionJWKSTrusted, prev.Status, prev.Reason, prev.Message)
		} else {
			jwks = cond(ConditionJWKSTrusted, metav1.ConditionUnknown, ReasonJWKSNotRendered,
				"the function is not rendered, so no JWKS is mounted")
		}
	case !o.accepted():
		jwks = cond(ConditionJWKSTrusted, metav1.ConditionUnknown, ReasonJWKSNotRendered,
			"the function is not rendered, so no JWKS is mounted")
	case o.jwks == zoneJWKSUntrusted:
		jwks = cond(ConditionJWKSTrusted, metav1.ConditionFalse, ReasonJWKSUntrusted, fmt.Sprintf(
			"ConfigMap %q exists but is not controlled by zone %q (%s), so it is NOT mounted: the function has no "+
				"key set and refuses every call except the health check. The zone reports JWKSConfigMapConflict. "+
				"Remove the ConfigMap and the operator publishes the zone's keys", jwksName, bs.Spec.Zone, o.jwksDetail))
	case o.jwks == zoneJWKSControlled:
		jwks = cond(ConditionJWKSTrusted, metav1.ConditionTrue, ReasonJWKSControlled, fmt.Sprintf(
			"ConfigMap %q is controlled by zone %q and is mounted into the function", jwksName, bs.Spec.Zone))
	default:
		jwks = cond(ConditionJWKSTrusted, metav1.ConditionUnknown, ReasonJWKSNotPublished, fmt.Sprintf(
			"ConfigMap %q does not exist yet: the mount is optional, and the function refuses every call except "+
				"the health check until the zone publishes its keys", jwksName))
	}
	v.conditions = append(v.conditions, jwks)

	// DatabaseHostLint — a warning only.
	var lint metav1.Condition
	if len(o.lint) > 0 {
		parts := make([]string, 0, len(o.lint))
		for _, f := range o.lint {
			parts = append(parts, f.String())
		}
		lint = cond(ConditionDatabaseHostLint, metav1.ConditionFalse, ReasonForeignDatabaseHost,
			"warning: "+strings.Join(parts, "; ")+". "+databaseHostLintDisclaimer)
		prev := apimeta.FindStatusCondition(bs.Status.Conditions, ConditionDatabaseHostLint)
		if prev == nil || prev.Status != lint.Status || prev.Message != lint.Message {
			v.events = append(v.events, verdictEvent{corev1.EventTypeWarning, ReasonForeignDatabaseHost, lint.Message})
		}
	} else {
		lint = cond(ConditionDatabaseHostLint, metav1.ConditionTrue, ReasonNoForeignDatabaseHost,
			"no env literal names another zone's database host. "+databaseHostLintDisclaimer)
	}
	v.conditions = append(v.conditions, lint)

	// Ready — the roll-up, in order of precedence.
	var ready metav1.Condition
	switch {
	case o.invalidImage != "":
		ready = cond(ConditionReady, metav1.ConditionFalse, ReasonInvalidImage, o.invalidImage)
	case bound.Status != metav1.ConditionTrue:
		ready = cond(ConditionReady, metav1.ConditionFalse, bound.Reason, bound.Message)
	case len(o.violations) > 0:
		ready = cond(ConditionReady, metav1.ConditionFalse, ReasonSovereigntyViolation, sov.Message)
	case o.undecided() && o.ksvc == nil:
		ready = cond(ConditionReady, metav1.ConditionFalse, ReasonSecretsUnverified, sov.Message)
	case o.renderErr != "":
		ready = cond(ConditionReady, metav1.ConditionFalse, ReasonKnativeServiceNameTaken, o.renderErr)
	case jwks.Status == metav1.ConditionFalse:
		// Rendered, but with no key set: it refuses every call, so it is not
		// Ready however healthy its pods are. A policy fact, so it outranks the
		// wait for the Knative Service.
		ready = cond(ConditionReady, metav1.ConditionFalse, ReasonJWKSUntrusted, jwks.Message)
	case o.ksvc == nil || !o.ksvc.Status.GetCondition(servingv1.ServiceConditionReady).IsTrue():
		reason, msg := "Pending", "the function's Knative Service has not reported Ready yet"
		if o.ksvc != nil {
			if c := o.ksvc.Status.GetCondition(servingv1.ServiceConditionReady); c != nil {
				if c.Reason != "" {
					reason = c.Reason
				}
				if c.Message != "" {
					msg = c.Message
				}
			}
		}
		ready = cond(ConditionReady, metav1.ConditionFalse, ReasonFunctionNotReady,
			fmt.Sprintf("Knative Service is not Ready (%s): %s", reason, msg))
		v.requeueAfter = functionNotReadyRequeueAfter
	default:
		msg := "the function is bound, compliant and its Knative Service is Ready"
		if o.undecided() {
			msg = "the function is bound and its Knative Service is Ready; its Secret references could not be " +
				"re-verified this pass (SovereigntyCompliant is Unknown)"
		}
		ready = cond(ConditionReady, metav1.ConditionTrue, ReasonFunctionReady, msg)
	}
	v.conditions = append(v.conditions, ready)

	if ready.Status != metav1.ConditionTrue && ready.Reason != ReasonFunctionNotReady {
		prev := apimeta.FindStatusCondition(bs.Status.Conditions, ConditionReady)
		if prev == nil || prev.Reason != ready.Reason || prev.Message != ready.Message {
			v.events = append(v.events, verdictEvent{corev1.EventTypeWarning, ready.Reason, ready.Message})
			if prev == nil || prev.Reason != ready.Reason {
				v.refusal = ready.Reason
			}
		}
	}
	if v.requeueAfter == 0 {
		v.requeueAfter = functionRevalidateAfter
	}
	return v
}
