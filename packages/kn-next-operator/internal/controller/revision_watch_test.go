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
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"knative.dev/serving/pkg/apis/serving"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// #365: a pure Revision Active-condition flip (Active<->Inactive on wake/sleep)
// must re-enqueue the OWNING NextApp so `.status.scaledToZero` converges within a
// bounded window. Knative Revisions are owned by the Configuration, NOT the
// NextApp, so a plain Owns(Revision) owner-ref walk does not resolve back to the
// NextApp. The operator maps a Revision to its NextApp via the Knative
// `serving.knative.dev/service` label (the child ksvc name == the NextApp name).
//
// These tests pin that mapping function directly (the controller envtest suite
// drives Reconcile manually, without a live manager, so the watch wiring itself
// is exercised at the map-function boundary — the deterministic seam).

func TestRevisionToNextAppRequests_MapsViaServiceLabel(t *testing.T) {
	r := &NextAppReconciler{}
	rev := &servingv1.Revision{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "my-app-00007",
			Namespace: "team-a",
			Labels: map[string]string{
				serving.ServiceLabelKey: "my-app",
			},
		},
	}

	got := r.revisionToNextAppRequests(context.Background(), rev)

	want := []reconcile.Request{
		{NamespacedName: types.NamespacedName{Name: "my-app", Namespace: "team-a"}},
	}
	if len(got) != len(want) {
		t.Fatalf("expected %d request(s), got %d: %+v", len(want), len(got), got)
	}
	if got[0] != want[0] {
		t.Fatalf("expected request %+v, got %+v", want[0], got[0])
	}
}

func TestRevisionToNextAppRequests_NoServiceLabel_NoEnqueue(t *testing.T) {
	r := &NextAppReconciler{}
	rev := &servingv1.Revision{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "orphan-00001",
			Namespace: "team-a",
			// No serving.knative.dev/service label: not one of ours.
		},
	}

	got := r.revisionToNextAppRequests(context.Background(), rev)
	if len(got) != 0 {
		t.Fatalf("expected no requests for an unlabeled revision, got %+v", got)
	}
}

func TestRevisionToNextAppRequests_NonRevision_NoEnqueue(t *testing.T) {
	r := &NextAppReconciler{}
	// A non-Revision object must not panic and must enqueue nothing.
	got := r.revisionToNextAppRequests(context.Background(), &servingv1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "svc", Namespace: "team-a"},
	})
	if len(got) != 0 {
		t.Fatalf("expected no requests for a non-Revision object, got %+v", got)
	}
}
