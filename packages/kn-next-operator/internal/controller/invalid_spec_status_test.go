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

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The invalid-spec outcome is user-visible: a Degraded/Ready pair on status and a
// Warning Event. These tests pin the exact observable result through the real
// Reconcile so the outcome can live in the verdict path (status_verdict.go)
// without a byte of it changing, and pin the event-reason policy: InvalidImage for
// an image that fails digest pinning (what users already filter on), InvalidSpec
// for every other spec failure.

const (
	invalidSpecReadyMessage = "Spec does not meet validation requirements"
)

// overBudgetSpec is invalid under the built-in connection budget (9*9 = 81 > 80)
// while its image is perfectly well pinned.
func overBudgetSpec(a *appsv1alpha1.NextApp) {
	a.Spec.Scaling = &appsv1alpha1.ScalingSpec{MaxScale: 9, PoolMax: 9}
}

func reconcileExpectingError(t *testing.T, h *platformHarness, name string) (requeues bool, err error) {
	t.Helper()
	res, err := h.r.Reconcile(context.Background(),
		reconcile.Request{NamespacedName: types.NamespacedName{Namespace: "default", Name: name}})
	if err == nil {
		t.Fatalf("reconcile %s: want a validation error, got nil", name)
	}
	return res.RequeueAfter != 0, err
}

func TestInvalidSpec_StatusAndEventAreObservablyStable(t *testing.T) {
	h := newPlatformHarness(t, appNamed("bad", overBudgetSpec))
	requeues, err := reconcileExpectingError(t, h, "bad")
	if requeues {
		t.Error("an invalid spec must not requeue on its own: the error return drives the backoff")
	}

	app := h.app("bad")
	degraded := h.condition("bad", ConditionDegraded)
	ready := h.condition("bad", ConditionReady)
	if degraded == nil || ready == nil {
		t.Fatalf("want Degraded and Ready, got %+v", app.Status.Conditions)
	}
	if degraded.Status != metav1.ConditionTrue || degraded.Reason != lcInvalidSpec ||
		degraded.Message != err.Error() || degraded.ObservedGeneration != app.Generation {
		t.Errorf("Degraded = %+v, want True/InvalidSpec carrying the validation error %q at generation %d",
			degraded, err.Error(), app.Generation)
	}
	if ready.Status != metav1.ConditionFalse || ready.Reason != lcInvalidSpec ||
		ready.Message != invalidSpecReadyMessage || ready.ObservedGeneration != app.Generation {
		t.Errorf("Ready = %+v, want False/InvalidSpec %q at generation %d",
			ready, invalidSpecReadyMessage, app.Generation)
	}
	// Append order is part of the persisted contract: Degraded then Ready.
	if len(app.Status.Conditions) != 2 ||
		app.Status.Conditions[0].Type != ConditionDegraded || app.Status.Conditions[1].Type != ConditionReady {
		t.Errorf("conditions = %+v, want exactly [Degraded, Ready] in that order", app.Status.Conditions)
	}

	events := h.drainEvents()
	if len(events) != 1 {
		t.Fatalf("want exactly one event, got %v", events)
	}
	if !strings.HasPrefix(events[0], corev1.EventTypeWarning+" ") ||
		!strings.HasSuffix(events[0], "Spec rejected: "+err.Error()) {
		t.Errorf("event = %q, want a Warning ending in %q", events[0], "Spec rejected: "+err.Error())
	}
}

func TestInvalidSpec_ARepeatedPassDoesNotRewriteStatus(t *testing.T) {
	h := newPlatformHarness(t, appNamed("bad", overBudgetSpec))
	_, _ = reconcileExpectingError(t, h, "bad")
	first := h.app("bad").ResourceVersion
	_, _ = reconcileExpectingError(t, h, "bad")
	if got := h.app("bad").ResourceVersion; got != first {
		t.Errorf("resourceVersion %s -> %s: a persistently-invalid CR must not rewrite an unchanged status", first, got)
	}
}

func TestInvalidSpec_EventReasonNamesTheCause(t *testing.T) {
	cases := []struct {
		name   string
		mut    func(*appsv1alpha1.NextApp)
		reason string
	}{
		{"unpinned image keeps the reason users already filter on", func(a *appsv1alpha1.NextApp) {
			a.Spec.Image = "registry.example.com/app:latest"
		}, ReasonInvalidImage},
		{"tag-only image keeps InvalidImage", func(a *appsv1alpha1.NextApp) {
			a.Spec.Image = "registry.example.com/app:v1"
		}, ReasonInvalidImage},
		{"over-budget scaling is a spec error, not an image error", overBudgetSpec, ReasonInvalidSpec},
		{"a non-image spec error is InvalidSpec", func(a *appsv1alpha1.NextApp) {
			a.Spec.Scaling = &appsv1alpha1.ScalingSpec{MinScale: -1}
		}, ReasonInvalidSpec},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newPlatformHarness(t, appNamed("bad", c.mut))
			_, _ = reconcileExpectingError(t, h, "bad")
			events := h.drainEvents()
			if len(events) != 1 || !strings.HasPrefix(events[0], "Warning "+c.reason+" ") {
				t.Errorf("events = %v, want one Warning with reason %s", events, c.reason)
			}
			// The condition reason is InvalidSpec in every case.
			if r := h.condition("bad", ConditionReady); r == nil || r.Reason != lcInvalidSpec {
				t.Errorf("Ready = %+v, want reason InvalidSpec", r)
			}
		})
	}
}
