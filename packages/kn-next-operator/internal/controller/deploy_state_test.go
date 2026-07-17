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
	"k8s.io/utils/ptr"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Unit tests for deriveDeployState, the pure helper that fills the NextApp's
// scale-state + last-successful-deploy status fields (#312) from the child
// Knative Service status the operator already reconciles. No I/O, no envtest.

// readyKsvcWithRevision returns a ksvc whose rolled-up Ready is True and whose
// latest-ready revision is named rev.
func readyKsvcWithRevision(rev string, now time.Time) *servingv1.Service {
	ksvc := &servingv1.Service{}
	ksvc.Status.SetConditions(apis.Conditions{{
		Type:               servingv1.ServiceConditionReady,
		Status:             corev1.ConditionTrue,
		LastTransitionTime: apis.VolatileTime{Inner: metav1.NewTime(now)},
	}})
	ksvc.Status.LatestReadyRevisionName = rev
	return ksvc
}

func TestDeriveDeployState_ReadyStampsRevisionAndDeployTime(t *testing.T) {
	now := time.Now()
	app := verdictApp() // prior status empty
	ksvc := readyKsvcWithRevision("shop-00003", now)

	ds := deriveDeployState(app, ksvc, ptr.To(true), now)

	if ds.observedRevision != "shop-00003" {
		t.Fatalf("observedRevision: got %q, want shop-00003", ds.observedRevision)
	}
	if ds.lastSuccessfulDeployTime == nil {
		t.Fatal("lastSuccessfulDeployTime: want it stamped when ksvc first Ready, got nil")
	}
	if !ds.lastSuccessfulDeployTime.Time.Equal(now) {
		t.Fatalf("lastSuccessfulDeployTime: got %v, want %v", ds.lastSuccessfulDeployTime.Time, now)
	}
}

func TestDeriveDeployState_ScaledToZeroFromInactiveRevision(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	ksvc := readyKsvcWithRevision("shop-00003", now)

	// active=false => the revision is Ready but Inactive == scaled to zero.
	ds := deriveDeployState(app, ksvc, ptr.To(false), now)

	if ds.scaledToZero == nil || *ds.scaledToZero != true {
		t.Fatalf("scaledToZero: got %v, want true (inactive revision)", ds.scaledToZero)
	}
}

func TestDeriveDeployState_ActiveRevisionNotScaledToZero(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	ksvc := readyKsvcWithRevision("shop-00003", now)

	ds := deriveDeployState(app, ksvc, ptr.To(true), now)

	if ds.scaledToZero == nil || *ds.scaledToZero != false {
		t.Fatalf("scaledToZero: got %v, want false (active revision)", ds.scaledToZero)
	}
}

func TestDeriveDeployState_UnknownActivenessOmitsScaledToZero(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	ksvc := readyKsvcWithRevision("shop-00003", now)

	// active=nil => revision activeness unknown (GET failed / no revision):
	// omit the field rather than guessing.
	ds := deriveDeployState(app, ksvc, nil, now)

	if ds.scaledToZero != nil {
		t.Fatalf("scaledToZero: got %v, want nil when activeness unknown", ds.scaledToZero)
	}
}

func TestDeriveDeployState_PreservesPriorDeployTimeWhenRevisionUnchanged(t *testing.T) {
	earlier := time.Now().Add(-time.Hour)
	now := time.Now()
	app := verdictApp()
	// Prior status already recorded the same revision + an earlier deploy time.
	app.Status.ObservedRevision = "shop-00003"
	app.Status.LastSuccessfulDeployTime = &metav1.Time{Time: earlier}
	ksvc := readyKsvcWithRevision("shop-00003", now)

	ds := deriveDeployState(app, ksvc, ptr.To(true), now)

	if ds.lastSuccessfulDeployTime == nil || !ds.lastSuccessfulDeployTime.Time.Equal(earlier) {
		t.Fatalf("lastSuccessfulDeployTime: got %v, want preserved earlier %v",
			ds.lastSuccessfulDeployTime, earlier)
	}
}

func TestDeriveDeployState_NewRevisionAdvancesDeployTime(t *testing.T) {
	earlier := time.Now().Add(-time.Hour)
	now := time.Now()
	app := verdictApp()
	app.Status.ObservedRevision = "shop-00002"
	app.Status.LastSuccessfulDeployTime = &metav1.Time{Time: earlier}
	ksvc := readyKsvcWithRevision("shop-00003", now) // NEW ready revision

	ds := deriveDeployState(app, ksvc, ptr.To(true), now)

	if ds.observedRevision != "shop-00003" {
		t.Fatalf("observedRevision: got %q, want shop-00003", ds.observedRevision)
	}
	if ds.lastSuccessfulDeployTime == nil || !ds.lastSuccessfulDeployTime.Time.Equal(now) {
		t.Fatalf("lastSuccessfulDeployTime: got %v, want advanced to now %v",
			ds.lastSuccessfulDeployTime, now)
	}
}

func TestDeriveDeployState_NotReadyPreservesPriorDeployTime(t *testing.T) {
	earlier := time.Now().Add(-time.Hour)
	now := time.Now()
	app := verdictApp()
	app.Status.ObservedRevision = "shop-00003"
	app.Status.LastSuccessfulDeployTime = &metav1.Time{Time: earlier}
	// ksvc NOT ready (e.g. new bad revision failing) — do not stamp a new deploy
	// time; the last SUCCESSFUL deploy is still the earlier one.
	ksvc := ksvcWithCondition(servingv1.ServiceConditionReady,
		corev1.ConditionFalse, "RevisionFailed", time.Minute, now)
	ksvc.Status.LatestReadyRevisionName = "shop-00003"

	ds := deriveDeployState(app, ksvc, nil, now)

	if ds.lastSuccessfulDeployTime == nil || !ds.lastSuccessfulDeployTime.Time.Equal(earlier) {
		t.Fatalf("lastSuccessfulDeployTime: got %v, want preserved %v (ksvc not Ready)",
			ds.lastSuccessfulDeployTime, earlier)
	}
}
