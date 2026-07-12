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
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// Unit tests for the pure decision helper behind PinnedRevisionNotFound
// (ADR-0014 follow-up): degrade ONLY when the pinned Revision GET returned
// NotFound AND the ksvc's RoutesReady/Ready condition has been non-True for
// longer than the stall window — a STATELESS race guard derived from Knative's
// own lastTransitionTime (the ingressProgrammingStalled discipline), so it
// survives leader failover with no in-memory grace passes or annotations.

func ksvcWithCondition(
	condType apis.ConditionType, status corev1.ConditionStatus, reason string, age time.Duration, now time.Time,
) *servingv1.Service {
	ksvc := &servingv1.Service{}
	ksvc.Status.SetConditions(apis.Conditions{
		{
			Type:               condType,
			Status:             status,
			Reason:             reason,
			LastTransitionTime: apis.VolatileTime{Inner: metav1.NewTime(now.Add(-age))},
		},
	})
	return ksvc
}

func TestPinnedRevisionMissingStalled_RevisionFoundNeverStalls(t *testing.T) {
	now := time.Now()
	ksvc := ksvcWithCondition(servingv1.ServiceConditionRoutesReady,
		corev1.ConditionFalse, "RevisionMissing", pinnedRevisionStallWindow+time.Hour, now)
	if _, stalled := pinnedRevisionMissingStalled(false, ksvc, now); stalled {
		t.Fatal("revision exists (notFound=false): must never report a stall")
	}
}

func TestPinnedRevisionMissingStalled_NotFoundAndRouteFailedPastWindow(t *testing.T) {
	now := time.Now()
	ksvc := ksvcWithCondition(servingv1.ServiceConditionRoutesReady,
		corev1.ConditionFalse, "RevisionMissing", pinnedRevisionStallWindow+time.Minute, now)
	elapsed, stalled := pinnedRevisionMissingStalled(true, ksvc, now)
	if !stalled {
		t.Fatal("NotFound + RoutesReady=False older than the window must stall")
	}
	if elapsed < pinnedRevisionStallWindow {
		t.Fatalf("elapsed %v must be at least the window %v", elapsed, pinnedRevisionStallWindow)
	}
}

func TestPinnedRevisionMissingStalled_ExactlyAtWindowBoundaryStalls(t *testing.T) {
	now := time.Now()
	ksvc := ksvcWithCondition(servingv1.ServiceConditionRoutesReady,
		corev1.ConditionFalse, "RevisionMissing", pinnedRevisionStallWindow, now)
	if _, stalled := pinnedRevisionMissingStalled(true, ksvc, now); !stalled {
		t.Fatal("elapsed == window must count as stalled (>= semantics)")
	}
}

func TestPinnedRevisionMissingStalled_FreshTransitionIsADeployWindow(t *testing.T) {
	now := time.Now()
	ksvc := ksvcWithCondition(servingv1.ServiceConditionRoutesReady,
		corev1.ConditionUnknown, "Deploying", 0, now)
	if _, stalled := pinnedRevisionMissingStalled(true, ksvc, now); stalled {
		t.Fatal("a fresh (within-window) transition is a normal deploy window — must NOT stall")
	}
}

func TestPinnedRevisionMissingStalled_ReadyTrueRouteMeansKnativeHasNotReactedYet(t *testing.T) {
	now := time.Now()
	ksvc := &servingv1.Service{}
	old := apis.VolatileTime{Inner: metav1.NewTime(now.Add(-24 * time.Hour))}
	ksvc.Status.SetConditions(apis.Conditions{
		{Type: servingv1.ServiceConditionReady, Status: corev1.ConditionTrue, LastTransitionTime: old},
		{Type: servingv1.ServiceConditionRoutesReady, Status: corev1.ConditionTrue, LastTransitionTime: old},
	})
	if _, stalled := pinnedRevisionMissingStalled(true, ksvc, now); stalled {
		t.Fatal("while the ksvc still reports Ready=True Knative has not yet processed the pin — must NOT stall")
	}
}

func TestPinnedRevisionMissingStalled_FallsBackToReadyCondition(t *testing.T) {
	now := time.Now()
	ksvc := ksvcWithCondition(servingv1.ServiceConditionReady,
		corev1.ConditionUnknown, "Deploying", pinnedRevisionStallWindow+time.Minute, now)
	if _, stalled := pinnedRevisionMissingStalled(true, ksvc, now); !stalled {
		t.Fatal("with RoutesReady absent, an old non-True Ready condition must stall")
	}
}

func TestPinnedRevisionMissingStalled_NoConditionsIsTooEarly(t *testing.T) {
	now := time.Now()
	if _, stalled := pinnedRevisionMissingStalled(true, &servingv1.Service{}, now); stalled {
		t.Fatal("a ksvc with no status conditions yet is too early to judge — must NOT stall")
	}
}

func TestPinnedRevisionMissingStalled_ZeroLastTransitionTimeIsIgnored(t *testing.T) {
	now := time.Now()
	ksvc := &servingv1.Service{}
	ksvc.Status.SetConditions(apis.Conditions{
		{Type: servingv1.ServiceConditionRoutesReady, Status: corev1.ConditionFalse, Reason: "RevisionMissing"},
	})
	// SetConditions may stamp a transition time; force it to zero to pin the guard.
	conds := ksvc.Status.GetConditions()
	for i := range conds {
		conds[i].LastTransitionTime = apis.VolatileTime{}
	}
	ksvc.Status.SetConditions(conds)
	cond := ksvc.Status.GetCondition(servingv1.ServiceConditionRoutesReady)
	if cond == nil || !cond.LastTransitionTime.Inner.IsZero() {
		t.Skip("cannot construct a zero LastTransitionTime through the knative accessor on this version")
	}
	if _, stalled := pinnedRevisionMissingStalled(true, ksvc, now); stalled {
		t.Fatal("a zero LastTransitionTime carries no age signal — must NOT stall")
	}
}
