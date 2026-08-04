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
	"strings"
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
	// The message must NOT tell the user to set provisionKafkaSource: the flag is
	// inert (#475), so instructing them to set it would be the operator advising a
	// value it then ignores.
	if strings.Contains(c.Message, "provisionKafkaSource=true") {
		t.Errorf("RevalidationDeferred message still instructs setting the inert flag: %q", c.Message)
	}
	if !strings.Contains(c.Message, "{app}-revalidator") {
		t.Errorf("RevalidationDeferred message must name the unbuilt consumer: %q", c.Message)
	}
	if len(v.events) != 0 {
		t.Fatalf("events: got %+v, want none when the flag is unset", v.events)
	}
}

// #475 — the flag is INERT, not rejected. Rejecting it narrowed v1alpha1 in place
// (ADR-0017 §2.1 forbids that) and wedged stored CRs on the fail-closed reconciler:
// the app stopped being reconciled entirely on operator upgrade, with no user
// action. So the verdict IGNORES the flag and reports it: still deferred, with a
// distinct reason plus a transition-gated Warning naming the withdrawal.
func TestComputeStatusVerdict_ProvisionKafkaSourceIsInert(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Revalidation = &appsv1alpha1.RevalidationSpec{
		Queue:                "kafka",
		ProvisionKafkaSource: ptr.To(true),
	}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)

	c := findVerdictCondition(t, v, ConditionRevalidationDeferred)
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonProvisionKafkaSourceInert {
		t.Fatalf("RevalidationDeferred with the flag set: got %+v, want True/%s",
			c, ReasonProvisionKafkaSourceInert)
	}
	// Honest about the WITHDRAWAL: the BYO external-consumer path was a documented
	// functional contract, and it is gone — not merely defaulted off.
	for _, want := range []string{"provisionKafkaSource", "ignored", "withdrawn"} {
		if !strings.Contains(c.Message, want) {
			t.Errorf("inert message %q must contain %q", c.Message, want)
		}
	}

	// Ready must stay True — the whole point is that the app keeps reconciling.
	if ready := findVerdictCondition(t, v, ConditionReady); ready.Status != metav1.ConditionTrue {
		t.Fatalf("Ready: got %+v, want True (an inert flag must never degrade the app)", ready)
	}

	// A Warning event fires so the withdrawal is visible in `kubectl describe`.
	if len(v.events) != 1 || v.events[0].eventType != corev1.EventTypeWarning ||
		v.events[0].reason != ReasonProvisionKafkaSourceInert {
		t.Fatalf("events: got %+v, want one Warning/%s", v.events, ReasonProvisionKafkaSourceInert)
	}

	// Transition-gated: a pass whose observed status already carries the reason
	// must not re-emit (the #98 idle-hot-loop contract).
	app.Status.Conditions = []metav1.Condition{{
		Type:   ConditionRevalidationDeferred,
		Status: metav1.ConditionTrue,
		Reason: ReasonProvisionKafkaSourceInert,
	}}
	v = computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, now)
	if len(v.events) != 0 {
		t.Fatalf("events on a repeat pass: got %+v, want none (transition-gated)", v.events)
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

// ---------------------------------------------------------------------------
// #471 item 4 — image-prewarm reconcile failures are DEGRADING, not FATAL.
//
// Before this, a persistent prewarm/RBAC failure returned an error out of
// Reconcile, so an OPT-IN cold-start optimisation blocked the whole app's
// status convergence (Ready never got written on that pass, and the app was
// stuck in the controller's exponential backoff). The decoupling: the failure
// is carried into the pure verdict and surfaces ONLY on ImageCacheReady, with
// a bounded requeue so it is retried and a transition-gated Warning event so
// it is never silent.
// ---------------------------------------------------------------------------

func TestComputeStatusVerdict_ImagePrewarmReconcileErrorDegradesOnlyImageCache(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Scaling = &appsv1alpha1.ScalingSpec{ImagePrewarm: true}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{
			enabled:         true,
			reconcileErrMsg: `daemonsets.apps is forbidden: User "system:serviceaccount:kn-next-operator-system:controller-manager" cannot create resource "daemonsets"`,
		}, now)

	c := findVerdictCondition(t, v, ConditionImageCacheReady)
	if c.Status != metav1.ConditionFalse || c.Reason != ReasonReconcileFailed {
		t.Fatalf("ImageCacheReady: got %+v, want False/%s", c, ReasonReconcileFailed)
	}
	if !strings.Contains(c.Message, "cannot create resource") {
		t.Fatalf("ImageCacheReady message must carry the underlying error, got %q", c.Message)
	}

	// The whole point: the app's own readiness is untouched by a prewarm failure.
	if r := findVerdictCondition(t, v, ConditionReady); r.Status != metav1.ConditionTrue {
		t.Fatalf("Ready must stay True when only the prewarmer failed, got %+v", r)
	}
	for _, cond := range v.conditions {
		if cond.Type == ConditionDegraded && cond.Status == metav1.ConditionTrue {
			t.Fatalf("a prewarm failure must not set Degraded=True, got %+v", cond)
		}
	}

	// Retried, not dropped: Reconcile no longer returns an error, so the ONLY
	// thing that brings the operator back to fix it is this requeue.
	if v.requeueAfter <= 0 {
		t.Fatalf("a prewarm reconcile failure must schedule a bounded requeue, got %v", v.requeueAfter)
	}

	// Never silent: a Warning event fires on entry into the failed state.
	var warned bool
	for _, e := range v.events {
		if e.eventType == corev1.EventTypeWarning && e.reason == ReasonImagePrewarmFailed {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("expected a Warning/%s event, got %+v", ReasonImagePrewarmFailed, v.events)
	}
}

func TestComputeStatusVerdict_ImagePrewarmErrorEventIsTransitionGated(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Scaling = &appsv1alpha1.ScalingSpec{ImagePrewarm: true}
	// Already reported as failing on the previous pass.
	app.Status.Conditions = []metav1.Condition{{
		Type:   ConditionImageCacheReady,
		Status: metav1.ConditionFalse,
		Reason: ReasonReconcileFailed,
	}}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{enabled: true, reconcileErrMsg: "still forbidden"}, now)

	for _, e := range v.events {
		if e.reason == ReasonImagePrewarmFailed {
			t.Fatalf("event must fire only on TRANSITION into the failed state; a persistent "+
				"failure would otherwise flood the event stream every requeue (got %+v)", e)
		}
	}
	// The condition itself still reports the current failure.
	c := findVerdictCondition(t, v, ConditionImageCacheReady)
	if c.Status != metav1.ConditionFalse || c.Reason != ReasonReconcileFailed {
		t.Fatalf("ImageCacheReady: got %+v, want False/%s", c, ReasonReconcileFailed)
	}
}

func TestComputeStatusVerdict_ImagePrewarmCleanupErrorSurfacesInsteadOfRemoving(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	// Prewarm turned OFF, but deleting the leftover DaemonSet failed. Silently
	// removing ImageCacheReady here would leave an orphaned DaemonSet pinning the
	// image on every node with NOTHING in status saying so.
	app.Status.Conditions = []metav1.Condition{{
		Type:   ConditionImageCacheReady,
		Status: metav1.ConditionTrue,
		Reason: "Cached",
	}}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{enabled: false, reconcileErrMsg: "delete forbidden"}, now)

	c := findVerdictCondition(t, v, ConditionImageCacheReady)
	if c.Status != metav1.ConditionFalse || c.Reason != ReasonCleanupFailed {
		t.Fatalf("ImageCacheReady: got %+v, want False/%s", c, ReasonCleanupFailed)
	}
	for _, rc := range v.removeConditions {
		if rc == ConditionImageCacheReady {
			t.Fatalf("must NOT remove ImageCacheReady while the cleanup is still failing")
		}
	}
	if v.requeueAfter <= 0 {
		t.Fatalf("a failed prewarm cleanup must schedule a bounded requeue, got %v", v.requeueAfter)
	}
	if r := findVerdictCondition(t, v, ConditionReady); r.Status != metav1.ConditionTrue {
		t.Fatalf("Ready must stay True when only the prewarm cleanup failed, got %+v", r)
	}
}

func TestComputeStatusVerdict_ImagePrewarmErrorDoesNotOverrideKsvcRequeue(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Scaling = &appsv1alpha1.ScalingSpec{ImagePrewarm: true}
	ksvc := ksvcWithCondition(servingv1.ServiceConditionReady, corev1.ConditionFalse,
		"RevisionFailed", time.Minute, now)

	v := computeStatusVerdict(app, ksvc, databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{enabled: true, reconcileErrMsg: "forbidden"}, now)

	// The ksvc-not-ready requeue is the tighter, more urgent one; the prewarm
	// failure must not lengthen it.
	if v.requeueAfter != ksvcNotReadyRequeueAfter {
		t.Fatalf("requeueAfter: got %v, want the ksvc-not-ready requeue %v",
			v.requeueAfter, ksvcNotReadyRequeueAfter)
	}
}

// Review finding 2 — the DELETE issued when prewarm is disabled is
// unconditional, so a Forbidden on the "operator upgraded without its new
// ClusterRole" path reached this branch for EVERY NextApp in the cluster,
// including every app that never opted in. Those apps would each grow a
// condition asserting a DaemonSet that never existed, a Warning, and a forced
// 2-minute poll — and it broke the byte-identical-conditions invariant the
// disabled branch exists to protect (#98).
func TestComputeStatusVerdict_ImagePrewarmCleanupErrorOnNeverPrewarmedAppIsSilent(t *testing.T) {
	now := time.Now()
	app := verdictApp() // no spec.scaling, no prior ImageCacheReady condition

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{enabled: false, reconcileErrMsg: "delete forbidden"}, now)

	for _, c := range v.conditions {
		if c.Type == ConditionImageCacheReady {
			t.Fatalf("a never-prewarmed app must not grow an ImageCacheReady condition from a "+
				"failed delete of a DaemonSet it never had, got %+v", c)
		}
	}
	for _, rc := range v.removeConditions {
		if rc == ConditionImageCacheReady {
			t.Fatalf("must not remove a never-present condition (breaks the #98 no-op guard)")
		}
	}
	for _, e := range v.events {
		if e.reason == ReasonImagePrewarmFailed {
			t.Fatalf("must not warn about an orphan that cannot exist, got %+v", e)
		}
	}
	if v.requeueAfter != 0 {
		t.Fatalf("must not force a poll on an app that never opted in, got %v", v.requeueAfter)
	}
}

// ...but the orphan case this branch exists for MUST still surface: prewarm was
// on (so the condition is present), it is turned off, and the delete fails.
func TestComputeStatusVerdict_ImagePrewarmCleanupErrorStillSurfacesForARealOrphan(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionImageCacheReady, Status: metav1.ConditionTrue, Reason: "Cached",
	}}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{enabled: false, reconcileErrMsg: "delete forbidden"}, now)

	c := findVerdictCondition(t, v, ConditionImageCacheReady)
	if c.Status != metav1.ConditionFalse || c.Reason != ReasonCleanupFailed {
		t.Fatalf("ImageCacheReady: got %+v, want False/%s", c, ReasonCleanupFailed)
	}
}

// Review finding 3a — CreateOrUpdate is Get-then-Update, so a Conflict is
// ROUTINE. Degrading on it would flip a healthy True/Cached to
// False/ReconcileFailed, emit a Warning, write status, and flip back next pass:
// exactly the condition flapping the #98 no-op guard exists to prevent.
func TestComputeStatusVerdict_ImagePrewarmTransientConflictDoesNotFlapTheCondition(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Scaling = &appsv1alpha1.ScalingSpec{ImagePrewarm: true}
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionImageCacheReady, Status: metav1.ConditionTrue, Reason: "Cached",
	}}

	// Coverage is still complete and still observed — a Conflict says nothing
	// about the DaemonSet's health.
	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{enabled: true, desired: 3, ready: 3, transientErr: true}, now)

	c := findVerdictCondition(t, v, ConditionImageCacheReady)
	if c.Status != metav1.ConditionTrue || c.Reason != "Cached" {
		t.Fatalf("a routine write Conflict must not degrade a healthy cache, got %+v", c)
	}
	for _, e := range v.events {
		if e.reason == ReasonImagePrewarmFailed {
			t.Fatalf("a routine Conflict must not emit a Warning, got %+v", e)
		}
	}
	// It must still be retried — the write did not land.
	if v.requeueAfter <= 0 {
		t.Fatalf("a conflicted write must still be retried, got %v", v.requeueAfter)
	}
}

// Review finding 3b — skipping the DaemonSet GET on error threw away live,
// still-accurate coverage. The failure message must carry it, so an operator
// reading the condition can tell "nothing is cached" from "9 of 10 nodes are
// cached and the 10th update was rejected".
func TestComputeStatusVerdict_ImagePrewarmErrorMessageCarriesObservedCoverage(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Spec.Scaling = &appsv1alpha1.ScalingSpec{ImagePrewarm: true}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{
			enabled: true, desired: 10, ready: 9, reconcileErrMsg: "forbidden",
		}, now)

	c := findVerdictCondition(t, v, ConditionImageCacheReady)
	if !strings.Contains(c.Message, "9/10") {
		t.Fatalf("failure message must report the observed coverage, got %q", c.Message)
	}
	if !strings.Contains(c.Message, "forbidden") {
		t.Fatalf("failure message must still carry the underlying error, got %q", c.Message)
	}
}
