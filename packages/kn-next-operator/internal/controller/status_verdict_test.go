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

// Unit tests for computeStatusVerdict, the pure status-verdict function behind
// Reconcile (#254): given the NextApp (spec + prior status), the child ksvc
// status, the database-check state, the pinned-revision check result, and a
// clock, it must reproduce the exact conditions / reasons / messages / events /
// requeue the reconciler historically composed inline. The envtest matrix
// (ready_health / ingress_stall / pinned_revision / database binding / #98
// no-op guards) is the end-to-end characterization net; these tests pin the
// same strings at the pure seam so future honest-status work can be exercised
// without envtest.

const (
	// reasonReconcileSuccess / reasonKsvcNotReady pin the exact healthy /
	// generic-unhealthy Ready reasons the reconciler has always written.
	reasonReconcileSuccess = "ReconcileSuccess"
	reasonKsvcNotReady     = "KnativeServiceNotReady"
)

func verdictApp() *appsv1alpha1.NextApp {
	app := &appsv1alpha1.NextApp{}
	app.Name = "shop"
	app.Namespace = "prod"
	app.Generation = 3
	return app
}

// readyKsvc returns a ksvc whose rolled-up Ready condition is True.
func readyKsvc(now time.Time) *servingv1.Service {
	return ksvcWithCondition(servingv1.ServiceConditionReady, corev1.ConditionTrue, "", time.Minute, now)
}

func findVerdictCondition(t *testing.T, v statusVerdict, condType string) metav1.Condition {
	t.Helper()
	for _, c := range v.conditions {
		if c.Type == condType {
			return c
		}
	}
	t.Fatalf("verdict has no %s condition (got %+v)", condType, v.conditions)
	return metav1.Condition{}
}

func conditionTypes(v statusVerdict) []string {
	out := make([]string, 0, len(v.conditions))
	for _, c := range v.conditions {
		out = append(out, c.Type)
	}
	return out
}

func assertConditionOrder(t *testing.T, v statusVerdict, want []string) {
	t.Helper()
	got := conditionTypes(v)
	if len(got) != len(want) {
		t.Fatalf("condition order: got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("condition order: got %v, want %v (append order is part of the #98 no-op contract)", got, want)
		}
	}
}

func TestComputeStatusVerdict_BoundSecret(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Database = &appsv1alpha1.DatabaseSpec{
		SecretRef: &appsv1alpha1.DatabaseSecretRef{Name: "shop-db"},
	}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeBound},
		revisionCheck{}, imageCacheState{}, now)

	// BYO binding: DatabaseReady=True (Bound), then the step-6 roll-up.
	assertConditionOrder(t, v, []string{
		ConditionDatabaseReady, ConditionReconciling, ConditionReady, ConditionDegraded,
		ConditionRevalidationDeferred,
	})
	dbCond := findVerdictCondition(t, v, ConditionDatabaseReady)
	if dbCond.Status != metav1.ConditionTrue || dbCond.Reason != "Bound" ||
		dbCond.Message != "Bound existing Secret \"shop-db\" as DATABASE_URL" {
		t.Fatalf("DatabaseReady: got %+v", dbCond)
	}
	if c := findVerdictCondition(t, v, ConditionReady); c.Status != metav1.ConditionTrue ||
		c.Reason != reasonReconcileSuccess {
		t.Fatalf("Ready: got %+v", c)
	}
	if len(v.events) != 0 {
		t.Fatalf("events: got %+v, want none on a healthy bound pass", v.events)
	}
}

func TestComputeStatusVerdict_NoDatabaseRemovesCondition(t *testing.T) {
	now := time.Now()
	app := verdictApp()

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)

	if len(v.removeConditions) != 1 || v.removeConditions[0] != ConditionDatabaseReady {
		t.Fatalf("removeConditions: got %v, want [DatabaseReady]", v.removeConditions)
	}
	assertConditionOrder(t, v, []string{
		ConditionReconciling, ConditionReady, ConditionDegraded, ConditionRevalidationDeferred,
	})
}

func TestComputeStatusVerdict_KsvcNotReadySurfacesKsvcDetail(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	ksvc := &servingv1.Service{}
	ksvc.Status.SetConditions(apis.Conditions{{
		Type:               servingv1.ServiceConditionReady,
		Status:             corev1.ConditionFalse,
		Reason:             "RevisionFailed",
		Message:            "Revision \"shop-00007\" failed with message: back-off pulling image.",
		LastTransitionTime: apis.VolatileTime{Inner: metav1.NewTime(now.Add(-time.Minute))},
	}})

	v := computeStatusVerdict(app, ksvc, databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)

	readyCond := findVerdictCondition(t, v, ConditionReady)
	if readyCond.Status != metav1.ConditionFalse || readyCond.Reason != reasonKsvcNotReady {
		t.Fatalf("Ready: got %+v", readyCond)
	}
	wantMsg := "Knative Service is not Ready (RevisionFailed): Revision \"shop-00007\" failed with message: back-off pulling image."
	if readyCond.Message != wantMsg {
		t.Fatalf("Ready message: got %q, want %q", readyCond.Message, wantMsg)
	}
	degraded := findVerdictCondition(t, v, ConditionDegraded)
	if degraded.Status != metav1.ConditionTrue || degraded.Reason != "RevisionFailed" ||
		degraded.Message != "Revision \"shop-00007\" failed with message: back-off pulling image." {
		t.Fatalf("Degraded: got %+v", degraded)
	}
	if v.requeueAfter != ksvcNotReadyRequeueAfter {
		t.Fatalf("requeueAfter: got %s, want %s", v.requeueAfter, ksvcNotReadyRequeueAfter)
	}
	if len(v.events) != 0 {
		t.Fatalf("events: got %+v, want none for a plain not-yet-ready ksvc", v.events)
	}
}

func TestComputeStatusVerdict_KsvcNotReadyNilConditionDefaults(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	ksvc := &servingv1.Service{} // no conditions at all

	v := computeStatusVerdict(app, ksvc, databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)

	readyCond := findVerdictCondition(t, v, ConditionReady)
	wantMsg := "Knative Service is not Ready (Pending): Knative Service has not reported Ready yet"
	if readyCond.Message != wantMsg {
		t.Fatalf("Ready message: got %q, want %q", readyCond.Message, wantMsg)
	}
	degraded := findVerdictCondition(t, v, ConditionDegraded)
	if degraded.Reason != "Pending" || degraded.Message != "Knative Service has not reported Ready yet" {
		t.Fatalf("Degraded: got %+v", degraded)
	}
}

// ingressStallMessage is the exact static condition message for #208 (static —
// the live elapsed goes only into the transition event, per the #98 churn guard).
const ingressStallMessage = "route programming has stalled: the Knative Route's ingress (KIngress) has been " +
	"unreconciled for more than 2m0s (IngressNotConfigured). This usually means no ingress controller " +
	"serves the cluster's configured ingress-class — check the `ingress-class` key in " +
	"the config-network ConfigMap (knative-serving namespace); on Knative-Operator-managed " +
	"clusters the KnativeServing CR overwrites that ConfigMap, so fix the class in the CR. " +
	"net-kourier serves \"kourier.ingress.networking.knative.dev\" (NOT the short `kourier.knative.dev` form)."

func TestComputeStatusVerdict_IngressStallVerdictAndTransitionEvent(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	ksvc := ksvcWithCondition(servingv1.ServiceConditionRoutesReady, corev1.ConditionUnknown,
		ksvcIngressNotConfiguredReason, ingressProgrammingStallWindow+3*time.Minute, now)

	v := computeStatusVerdict(app, ksvc, databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)

	readyCond := findVerdictCondition(t, v, ConditionReady)
	if readyCond.Reason != ReasonIngressNotProgrammed || readyCond.Message != ingressStallMessage {
		t.Fatalf("Ready: got reason=%q message=%q", readyCond.Reason, readyCond.Message)
	}
	degraded := findVerdictCondition(t, v, ConditionDegraded)
	if degraded.Reason != ReasonIngressNotProgrammed || degraded.Message != ingressStallMessage {
		t.Fatalf("Degraded: got %+v", degraded)
	}
	if len(v.events) != 1 || v.events[0].eventType != corev1.EventTypeWarning ||
		v.events[0].reason != ReasonIngressNotProgrammed ||
		v.events[0].message != ingressStallMessage+" (stalled for 5m0s)" {
		t.Fatalf("events: got %+v", v.events)
	}

	// Transition-only: with the prior Ready reason already IngressNotProgrammed
	// the SAME verdict must carry NO event (the #98 anti-churn discipline).
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionReady, Status: metav1.ConditionFalse,
		Reason: ReasonIngressNotProgrammed, Message: ingressStallMessage,
	}}
	v = computeStatusVerdict(app, ksvc, databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)
	if len(v.events) != 0 {
		t.Fatalf("events on an already-stalled pass: got %+v, want none", v.events)
	}
	if c := findVerdictCondition(t, v, ConditionReady); c.Message != ingressStallMessage {
		t.Fatalf("stall condition message must stay static, got %q", c.Message)
	}
}

const pinnedNotFoundMessage = "pinned revision \"shop-00007\" does not exist in namespace \"prod\" — it may have been " +
	"garbage-collected, so the declared traffic pin can never resolve and Knative keeps " +
	"serving the last-good route. Run `kubectl get revisions -n prod` to list surviving " +
	"revisions, then re-pin via `kn-next rollback shop --to <existing-revision>` or clear " +
	"spec.traffic to return to latest-ready."

func TestComputeStatusVerdict_PinnedRevisionNotFoundTakesPrecedence(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Traffic = &appsv1alpha1.TrafficSpec{RevisionName: "shop-00007"}
	// RoutesReady has sat in IngressNotConfigured past BOTH windows: the pinned
	// verdict must win over the generic ingress stall (more specific diagnosis).
	ksvc := ksvcWithCondition(servingv1.ServiceConditionRoutesReady, corev1.ConditionFalse,
		ksvcIngressNotConfiguredReason, pinnedRevisionStallWindow+3*time.Minute, now)

	v := computeStatusVerdict(app, ksvc, databaseCheckState{mode: databaseModeNone},
		revisionCheck{notFound: true}, imageCacheState{}, now)

	readyCond := findVerdictCondition(t, v, ConditionReady)
	if readyCond.Reason != ReasonPinnedRevisionNotFound || readyCond.Message != pinnedNotFoundMessage {
		t.Fatalf("Ready: got reason=%q message=%q", readyCond.Reason, readyCond.Message)
	}
	degraded := findVerdictCondition(t, v, ConditionDegraded)
	if degraded.Reason != ReasonPinnedRevisionNotFound || degraded.Message != pinnedNotFoundMessage {
		t.Fatalf("Degraded: got %+v", degraded)
	}
	if len(v.events) != 1 || v.events[0].reason != ReasonPinnedRevisionNotFound ||
		v.events[0].message != pinnedNotFoundMessage+" (pin unresolved for 5m0s)" {
		t.Fatalf("events: got %+v (want exactly the pinned transition event, not the ingress one)", v.events)
	}

	// Transition-only: same stalled state again => no event.
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionReady, Status: metav1.ConditionFalse,
		Reason: ReasonPinnedRevisionNotFound, Message: pinnedNotFoundMessage,
	}}
	v = computeStatusVerdict(app, ksvc, databaseCheckState{mode: databaseModeNone},
		revisionCheck{notFound: true}, imageCacheState{}, now)
	if len(v.events) != 0 {
		t.Fatalf("events on an already-degraded pass: got %+v, want none", v.events)
	}
}

func TestComputeStatusVerdict_PinnedCheckUnknownKeepsPriorVerdict(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Traffic = &appsv1alpha1.TrafficSpec{RevisionName: "shop-00007"}
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionReady, Status: metav1.ConditionFalse,
		Reason: ReasonPinnedRevisionNotFound, Message: pinnedNotFoundMessage,
	}}
	ksvc := ksvcWithCondition(servingv1.ServiceConditionRoutesReady, corev1.ConditionFalse,
		"RevisionMissing", pinnedRevisionStallWindow+time.Minute, now)

	v := computeStatusVerdict(app, ksvc, databaseCheckState{mode: databaseModeNone},
		revisionCheck{unknown: true}, imageCacheState{}, now)

	readyCond := findVerdictCondition(t, v, ConditionReady)
	if readyCond.Reason != ReasonPinnedRevisionNotFound || readyCond.Message != pinnedNotFoundMessage {
		t.Fatalf("inconclusive check must keep the prior verdict verbatim, got %+v", readyCond)
	}
	degraded := findVerdictCondition(t, v, ConditionDegraded)
	if degraded.Reason != ReasonPinnedRevisionNotFound || degraded.Message != pinnedNotFoundMessage {
		t.Fatalf("Degraded must mirror the kept verdict, got %+v", degraded)
	}
	if len(v.events) != 0 {
		t.Fatalf("events: got %+v, want none when keeping a prior verdict", v.events)
	}

	// Without a prior PinnedRevisionNotFound verdict there is nothing to keep:
	// fall through to the generic not-ready reason.
	app.Status.Conditions = nil
	v = computeStatusVerdict(app, ksvc, databaseCheckState{mode: databaseModeNone},
		revisionCheck{unknown: true}, imageCacheState{}, now)
	if c := findVerdictCondition(t, v, ConditionReady); c.Reason != reasonKsvcNotReady {
		t.Fatalf("Ready without prior verdict: got %+v", c)
	}
}

func TestComputeStatusVerdict_GhostPinRequeuesWhileKsvcStillReady(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Traffic = &appsv1alpha1.TrafficSpec{RevisionName: "shop-00007"}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{notFound: true}, imageCacheState{}, now)

	// Knative hasn't reacted to the pin yet: do NOT degrade in that window, but
	// keep re-evaluating so the stall window is eventually judged.
	if c := findVerdictCondition(t, v, ConditionReady); c.Status != metav1.ConditionTrue {
		t.Fatalf("Ready must stay True inside the race window, got %+v", c)
	}
	if v.requeueAfter != ksvcNotReadyRequeueAfter {
		t.Fatalf("requeueAfter: got %s, want %s (ghost pin must keep re-evaluating)",
			v.requeueAfter, ksvcNotReadyRequeueAfter)
	}
}

func TestComputeStatusVerdict_RevalidationDeferred(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Revalidation = &appsv1alpha1.RevalidationSpec{Queue: "kafka"}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)

	c := findVerdictCondition(t, v, ConditionRevalidationDeferred)
	if c.Status != metav1.ConditionTrue || c.Reason != "ConsumerNotProvisioned" {
		t.Fatalf("RevalidationDeferred: got %+v", c)
	}
	wantMsg := "revalidation.queue=kafka requested but no KafkaSource was provisioned: " +
		"the {app}-revalidator consumer is design-now/build-later (#95). Set " +
		"spec.revalidation.provisionKafkaSource=true once you deploy an external consumer."
	if c.Message != wantMsg {
		t.Fatalf("RevalidationDeferred message: got %q", c.Message)
	}

	// Opt-in flips it back to not-deferred.
	app.Spec.Revalidation.ProvisionKafkaSource = ptr.To(true)
	v = computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)
	if c := findVerdictCondition(t, v, ConditionRevalidationDeferred); c.Status != metav1.ConditionFalse {
		t.Fatalf("RevalidationDeferred with opt-in: got %+v", c)
	}
}

func TestComputeStatusVerdict_ImageCacheReadyCached(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Scaling = &appsv1alpha1.ScalingSpec{ImagePrewarm: true}

	// Every targeted node has the image pulled+pinned => ImageCacheReady=True.
	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{enabled: true, desired: 3, ready: 3}, now)

	c := findVerdictCondition(t, v, ConditionImageCacheReady)
	if c.Status != metav1.ConditionTrue || c.Reason != "Cached" {
		t.Fatalf("ImageCacheReady: got %+v, want True/Cached", c)
	}
	// It must be appended LAST (order contract, #98) — after RevalidationDeferred.
	got := conditionTypes(v)
	if got[len(got)-1] != ConditionImageCacheReady {
		t.Fatalf("ImageCacheReady must be the last condition, order=%v", got)
	}
}

func TestComputeStatusVerdict_ImageCacheReadyPulling(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Scaling = &appsv1alpha1.ScalingSpec{ImagePrewarm: true}

	// Partial coverage => ImageCacheReady=False/Pulling (never gates Ready).
	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{enabled: true, desired: 3, ready: 1}, now)

	c := findVerdictCondition(t, v, ConditionImageCacheReady)
	if c.Status != metav1.ConditionFalse || c.Reason != "Pulling" {
		t.Fatalf("ImageCacheReady: got %+v, want False/Pulling", c)
	}
	// Non-fatal: app Ready stays True while the prewarmer is still pulling.
	if r := findVerdictCondition(t, v, ConditionReady); r.Status != metav1.ConditionTrue {
		t.Fatalf("Ready must stay True while prewarm is Pulling, got %+v", r)
	}
}

func TestComputeStatusVerdict_ImageCacheDisabledNoCondition(t *testing.T) {
	now := time.Now()
	app := verdictApp()

	// Never prewarmed: no ImageCacheReady condition and no removal (order/#98
	// no-op guard stays byte-identical to the pre-ADR-0037 verdict).
	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)

	for _, c := range v.conditions {
		if c.Type == ConditionImageCacheReady {
			t.Fatalf("ImageCacheReady must be absent when prewarm is disabled, got %+v", c)
		}
	}
	for _, rc := range v.removeConditions {
		if rc == ConditionImageCacheReady {
			t.Fatalf("must not remove a never-present ImageCacheReady (would break the #98 no-op guard)")
		}
	}
}

func TestComputeStatusVerdict_ImageCacheDisabledRemovesStaleCondition(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	// Prior status carried ImageCacheReady (prewarm was on, now turned off).
	app.Status.Conditions = []metav1.Condition{{
		Type:   ConditionImageCacheReady,
		Status: metav1.ConditionTrue,
		Reason: "Cached",
	}}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{enabled: false}, now)

	found := false
	for _, rc := range v.removeConditions {
		if rc == ConditionImageCacheReady {
			found = true
		}
	}
	if !found {
		t.Fatalf("a stale ImageCacheReady must be removed when prewarm is disabled, removeConditions=%v", v.removeConditions)
	}
}
