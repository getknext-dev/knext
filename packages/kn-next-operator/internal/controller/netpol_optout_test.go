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
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The spec.security.networkPolicy=false opt-out removes pod-level isolation.
// Both kinds say so in status and, once on entry, in a Warning event; a kind
// that never opted out keeps its persisted conditions byte-identical (#98).

func falsePtr() *bool { b := false; return &b }

func optedOutApp() *appsv1alpha1.NextApp {
	app := verdictApp()
	app.Spec.Security = &appsv1alpha1.SecuritySpec{NetworkPolicy: falsePtr()}
	return app
}

func nextAppVerdictForOptOut(app *appsv1alpha1.NextApp, enabled bool, now time.Time) statusVerdict {
	return computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{enabled: enabled}, envMapCollisionReport{},
		privateExposureState{}, podCreationState{}, now)
}

func hasWarningEvent(events []verdictEvent, reason string) bool {
	for _, e := range events {
		if e.reason == reason && e.eventType == corev1.EventTypeWarning {
			return true
		}
	}
	return false
}

func TestNextAppNetworkPolicyOptOutIsReportedWithAWarning(t *testing.T) {
	now := time.Now()
	v := nextAppVerdictForOptOut(optedOutApp(), false, now)

	c := findVerdictCondition(t, v, ConditionNetworkPolicyDisabled)
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonNetworkPolicyOptedOut {
		t.Fatalf("NetworkPolicyDisabled = %s/%s, want True/%s", c.Status, c.Reason, ReasonNetworkPolicyOptedOut)
	}
	if !strings.Contains(c.Message, "spec.security.networkPolicy") || !strings.Contains(c.Message, "isolation") {
		t.Fatalf("the message must name the field and the lost isolation: %q", c.Message)
	}
	if c.ObservedGeneration != 3 {
		t.Fatalf("ObservedGeneration = %d, want the app's generation 3", c.ObservedGeneration)
	}
	if !hasWarningEvent(v.events, ReasonNetworkPolicyOptedOut) {
		t.Fatalf("expected a Warning event on entry, got %+v", v.events)
	}
	// Ready is untouched: the workload is healthy, only its isolation is gone.
	if ready := findVerdictCondition(t, v, ConditionReady); ready.Status != metav1.ConditionTrue {
		t.Fatalf("Ready must be unchanged by the warning, got %+v", ready)
	}
	// Enforcement is not claimed for a policy that is not reconciled.
	for _, ct := range conditionTypes(v) {
		if ct == ConditionNetworkPolicyEnforced {
			t.Fatalf("an opted-out app must not report enforcement, got %v", conditionTypes(v))
		}
	}
}

func TestNextAppNetworkPolicyOptOutWarningIsTransitionGated(t *testing.T) {
	now := time.Now()
	app := optedOutApp()
	first := nextAppVerdictForOptOut(app, false, now)
	app.Status.Conditions = []metav1.Condition{findVerdictCondition(t, first, ConditionNetworkPolicyDisabled)}

	second := nextAppVerdictForOptOut(app, false, now)
	if hasWarningEvent(second.events, ReasonNetworkPolicyOptedOut) {
		t.Fatalf("the event must not re-fire while the condition already stands: %+v", second.events)
	}
	if got, want := findVerdictCondition(t, second, ConditionNetworkPolicyDisabled).Message, app.Status.Conditions[0].Message; got != want {
		t.Fatalf("the message must be static for a converged object (#98): %q vs %q", got, want)
	}
}

func TestNextAppNetworkPolicyOptOutIsAbsentByDefaultAndClearedOnReEnable(t *testing.T) {
	now := time.Now()
	// Default-on app that never opted out: no condition and no removal.
	v := nextAppVerdictForOptOut(verdictApp(), true, now)
	for _, ct := range conditionTypes(v) {
		if ct == ConditionNetworkPolicyDisabled {
			t.Fatalf("a default-on app must not carry NetworkPolicyDisabled, got %v", conditionTypes(v))
		}
	}
	if containsStr(v.removeConditions, ConditionNetworkPolicyDisabled) {
		t.Fatalf("a never-opted-out app must not schedule a removal (byte-identical order, #98)")
	}
	// Opted out earlier, re-enabled now: the warning is dropped.
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionNetworkPolicyDisabled, Status: metav1.ConditionTrue, Reason: ReasonNetworkPolicyOptedOut, Message: "prior",
	}}
	v = nextAppVerdictForOptOut(app, true, now)
	if !containsStr(v.removeConditions, ConditionNetworkPolicyDisabled) {
		t.Fatalf("re-enabling must drop the stale warning; removeConditions=%v", v.removeConditions)
	}
}

func optedOutBS() *appsv1alpha1.BackendService {
	bs := jwksBS()
	bs.Spec.Security = &appsv1alpha1.BackendServiceSecuritySpec{NetworkPolicy: falsePtr()}
	return bs
}

func TestBackendServiceNetworkPolicyOptOutIsReportedWithAWarning(t *testing.T) {
	v := computeBackendServiceVerdict(optedOutBS(), acceptedObservation(zoneJWKSControlled, ""))

	c := verdictCondition(t, v, ConditionNetworkPolicyDisabled)
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonNetworkPolicyOptedOut {
		t.Fatalf("NetworkPolicyDisabled = %s/%s, want True/%s", c.Status, c.Reason, ReasonNetworkPolicyOptedOut)
	}
	if !strings.Contains(c.Message, "spec.security.networkPolicy") || !strings.Contains(c.Message, "isolation") {
		t.Fatalf("the message must name the field and the lost isolation: %q", c.Message)
	}
	if !hasWarningEvent(v.events, ReasonNetworkPolicyOptedOut) {
		t.Fatalf("expected a Warning event on entry, got %+v", v.events)
	}
	if ready := verdictCondition(t, v, ConditionReady); ready.Status != metav1.ConditionTrue {
		t.Fatalf("Ready must be unchanged by the warning, got %+v", ready)
	}
}

func TestBackendServiceNetworkPolicyOptOutWarningIsTransitionGated(t *testing.T) {
	bs := optedOutBS()
	first := computeBackendServiceVerdict(bs, acceptedObservation(zoneJWKSControlled, ""))
	bs.Status.Conditions = []metav1.Condition{verdictCondition(t, first, ConditionNetworkPolicyDisabled)}

	second := computeBackendServiceVerdict(bs, acceptedObservation(zoneJWKSControlled, ""))
	if hasWarningEvent(second.events, ReasonNetworkPolicyOptedOut) {
		t.Fatalf("the event must not re-fire while the condition already stands: %+v", second.events)
	}
	if apimeta.FindStatusCondition(second.conditions, ConditionNetworkPolicyDisabled) == nil {
		t.Fatalf("the condition must keep being set while the opt-out stands")
	}
}

func TestBackendServiceNetworkPolicyOptOutIsAbsentByDefaultAndClearedOnReEnable(t *testing.T) {
	v := computeBackendServiceVerdict(jwksBS(), acceptedObservation(zoneJWKSControlled, ""))
	if apimeta.FindStatusCondition(v.conditions, ConditionNetworkPolicyDisabled) != nil {
		t.Fatalf("a default-on function must not carry NetworkPolicyDisabled, got %+v", v.conditions)
	}
	if containsStr(v.removeConditions, ConditionNetworkPolicyDisabled) {
		t.Fatalf("a never-opted-out function must not schedule a removal (byte-identical order, #98)")
	}
	bs := jwksBS()
	bs.Status.Conditions = []metav1.Condition{{
		Type: ConditionNetworkPolicyDisabled, Status: metav1.ConditionTrue, Reason: ReasonNetworkPolicyOptedOut, Message: "prior",
	}}
	v = computeBackendServiceVerdict(bs, acceptedObservation(zoneJWKSControlled, ""))
	if !containsStr(v.removeConditions, ConditionNetworkPolicyDisabled) {
		t.Fatalf("re-enabling must drop the stale warning; removeConditions=%v", v.removeConditions)
	}
}

// Reconcile-level proof: the warning reaches PERSISTED status and the event
// stream exactly once, and re-enabling the policy drops it. Uses the same
// fake-client harness as the unverified-Secret reconcile tests.
func TestReconcilePersistsTheFunctionNetworkPolicyOptOutAndAnnouncesItOnce(t *testing.T) {
	resetSeries(t)
	h := newUnverifiedHarnessSpec(t, true, appsv1alpha1.BackendServiceSpec{
		Security: &appsv1alpha1.BackendServiceSecuritySpec{NetworkPolicy: falsePtr()},
	}, interceptor.Funcs{})

	optOutEvents := func() int {
		n := 0
		for {
			select {
			case e := <-h.rec.Events:
				if strings.Contains(e, ReasonNetworkPolicyOptedOut) {
					n++
				}
			default:
				return n
			}
		}
	}

	if err := h.reconcile(); err != nil {
		t.Fatal(err)
	}
	c := apimeta.FindStatusCondition(h.get(t).Status.Conditions, ConditionNetworkPolicyDisabled)
	if c == nil || c.Status != metav1.ConditionTrue || c.Reason != ReasonNetworkPolicyOptedOut {
		t.Fatalf("the opt-out must be persisted in status, got %+v", c)
	}
	if n := optOutEvents(); n != 1 {
		t.Fatalf("the opt-out Warning must be emitted once on entry, got %d", n)
	}
	if err := h.reconcile(); err != nil {
		t.Fatal(err)
	}
	if n := optOutEvents(); n != 0 {
		t.Fatalf("a converged pass must not re-announce the opt-out, got %d", n)
	}

	bs := h.get(t)
	bs.Spec.Security = nil
	if err := h.c.Update(context.Background(), bs); err != nil {
		t.Fatal(err)
	}
	if err := h.reconcile(); err != nil {
		t.Fatal(err)
	}
	if apimeta.FindStatusCondition(h.get(t).Status.Conditions, ConditionNetworkPolicyDisabled) != nil {
		t.Fatalf("re-enabling the policy must drop the warning from status, got %+v", h.get(t).Status.Conditions)
	}
}

// An opt-out is reported even for a function that is refused (nothing rendered):
// the field is a fact about the spec, not about the render.
func TestBackendServiceNetworkPolicyOptOutIsReportedWhenRefused(t *testing.T) {
	v := computeBackendServiceVerdict(optedOutBS(), functionObservation{})
	if apimeta.FindStatusCondition(v.conditions, ConditionNetworkPolicyDisabled) == nil {
		t.Fatalf("the opt-out must be reported whatever the render outcome, got %+v", v.conditions)
	}
}
