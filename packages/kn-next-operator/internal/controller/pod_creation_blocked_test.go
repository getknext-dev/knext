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
	"errors"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	knnames "knative.dev/serving/pkg/reconciler/revision/resources/names"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// PodCreationBlocked: a LimitRange / ResourceQuota admission rejection of the
// pod the Knative revision's ReplicaSet tries to create. Knative already
// propagates the Deployment's ReplicaFailure condition onto the Revision's
// ResourcesAvailable condition (reason FailedCreate, message = the admission
// error), so the operator reads the Revision — no Events RBAC, no pod mirror.

const (
	limitRangeMsg   = `pods "shop-00001-deployment-abc" is forbidden: [maximum cpu usage per Container is 500m, but limit is 1, cpu max limit to request ratio per Container is 2, but provided ratio is 4.000000]`
	mustSpecifyMsg  = `pods "shop-00001-deployment-abc" is forbidden: failed quota: team-quota: must specify limits.cpu for: queue-proxy; limits.memory for: queue-proxy`
	insufficientMsg = `pods "shop-00001-deployment-abc" is forbidden: insufficient quota to consume: pods`
	quotaMsg        = `pods "shop-00001-deployment-abc" is forbidden: exceeded quota: team-quota, requested: limits.cpu=1, used: limits.cpu=3500m, limited: limits.cpu=4`
)

func blockedRevision(reason, msg string, status corev1.ConditionStatus) *servingv1.Revision {
	rev := &servingv1.Revision{}
	rev.Name = "shop-00001"
	rev.Namespace = "prod"
	rev.Status.Conditions = duckConds(servingv1.RevisionConditionResourcesAvailable, status, reason, msg)
	return rev
}

func duckConds(t apis.ConditionType, s corev1.ConditionStatus, reason, msg string) []apis.Condition {
	return []apis.Condition{{Type: t, Status: s, Reason: reason, Message: msg}}
}

func TestClassifyPodCreationBlock(t *testing.T) {
	cases := []struct {
		name    string
		rev     *servingv1.Revision
		blocked bool
		reason  string
	}{
		{"limitrange", blockedRevision("FailedCreate", limitRangeMsg, corev1.ConditionFalse), true, ReasonLimitRangeRejected},
		{"quota", blockedRevision("FailedCreate", quotaMsg, corev1.ConditionFalse), true, ReasonQuotaExceeded},
		{"failed quota: must specify limits (queue-proxy has none)", blockedRevision("FailedCreate", mustSpecifyMsg, corev1.ConditionFalse), true, ReasonQuotaExceeded},
		{"insufficient quota to consume", blockedRevision("FailedCreate", insufficientMsg, corev1.ConditionFalse), true, ReasonQuotaExceeded},
		{"other FailedCreate (webhook) is out of scope", blockedRevision("FailedCreate", `admission webhook "x" denied the request`, corev1.ConditionFalse), false, ""},
		{"other reason with quota text is out of scope", blockedRevision("ProgressDeadlineExceeded", quotaMsg, corev1.ConditionFalse), false, ""},
		{"healthy", blockedRevision("", "", corev1.ConditionTrue), false, ""},
		{"no conditions", &servingv1.Revision{}, false, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			msg, reason, blocked := classifyPodCreationBlock(c.rev)
			if blocked != c.blocked || reason != c.reason {
				t.Fatalf("got blocked=%v reason=%q, want %v %q", blocked, reason, c.blocked, c.reason)
			}
			if blocked && msg == "" {
				t.Fatal("blocked verdict must carry the admission message")
			}
		})
	}
}

func verdictWithPodCreation(app *appsv1alpha1.NextApp, pc podCreationState, now time.Time) statusVerdict {
	return computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{}, privateExposureState{}, pc, now)
}

func TestPodCreationBlocked_ConditionAndEventOnTransition(t *testing.T) {
	now := time.Now()
	pc := podCreationState{blocked: true, reason: ReasonLimitRangeRejected, revision: "shop-00001", message: limitRangeMsg}
	v := verdictWithPodCreation(verdictApp(), pc, now)
	c := findVerdictCondition(t, v, ConditionPodCreationBlocked)
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonLimitRangeRejected {
		t.Fatalf("got %+v", c)
	}
	if !strings.Contains(c.Message, "maximum cpu usage per Container") || !strings.Contains(c.Message, "shop-00001") {
		t.Fatalf("condition must carry revision + event message, got %q", c.Message)
	}
	if len(v.events) != 1 || v.events[0].eventType != corev1.EventTypeWarning || v.events[0].reason != ReasonLimitRangeRejected {
		t.Fatalf("want one Warning event on entry, got %+v", v.events)
	}

	// Converged pass: same condition already present -> no repeat event (#98).
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{c}
	v2 := verdictWithPodCreation(app, pc, now)
	if len(v2.events) != 0 {
		t.Fatalf("event must be transition-gated, got %+v", v2.events)
	}
}

func TestPodCreationBlocked_ClearedRemovesConditionOnlyIfPresent(t *testing.T) {
	now := time.Now()
	v := verdictWithPodCreation(verdictApp(), podCreationState{}, now)
	for _, c := range v.conditions {
		if c.Type == ConditionPodCreationBlocked {
			t.Fatalf("never-blocked app must not grow the condition: %+v", c)
		}
	}
	if len(v.removeConditions) != 0 && containsStr(v.removeConditions, ConditionPodCreationBlocked) {
		t.Fatalf("nothing to remove for a never-blocked app: %v", v.removeConditions)
	}
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{{Type: ConditionPodCreationBlocked, Status: metav1.ConditionTrue, Reason: ReasonQuotaExceeded}}
	v = verdictWithPodCreation(app, podCreationState{}, now)
	if !containsStr(v.removeConditions, ConditionPodCreationBlocked) {
		t.Fatalf("recovered app must drop the condition, got %v", v.removeConditions)
	}
}

func TestPodCreationBlocked_UnknownKeepsPriorVerdict(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	prior := metav1.Condition{Type: ConditionPodCreationBlocked, Status: metav1.ConditionTrue, Reason: ReasonQuotaExceeded, Message: "m"}
	app.Status.Conditions = []metav1.Condition{prior}
	v := verdictWithPodCreation(app, podCreationState{unknown: true}, now)
	c := findVerdictCondition(t, v, ConditionPodCreationBlocked)
	if c.Reason != ReasonQuotaExceeded || c.Message != "m" {
		t.Fatalf("API hiccup must not flip the condition, got %+v", c)
	}
	if containsStr(v.removeConditions, ConditionPodCreationBlocked) {
		t.Fatal("unknown must not remove")
	}
}

func TestDetectPodCreationBlocked_ReadsLatestCreatedRevision(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := servingv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	rev := blockedRevision("FailedCreate", quotaMsg, corev1.ConditionFalse)
	r := &NextAppReconciler{Client: fake.NewClientBuilder().WithScheme(scheme).WithObjects(rev).Build()}
	ksvc := &servingv1.Service{}
	ksvc.Status.LatestCreatedRevisionName = "shop-00001"
	app := verdictApp()

	st := r.detectPodCreationBlocked(context.Background(), app, ksvc)
	if !st.blocked || st.reason != ReasonQuotaExceeded || st.revision != "shop-00001" {
		t.Fatalf("got %+v", st)
	}

	// No revision created yet -> nothing to report, not an error.
	st = r.detectPodCreationBlocked(context.Background(), app, &servingv1.Service{})
	if st.blocked || st.unknown {
		t.Fatalf("got %+v", st)
	}
	// Named revision missing -> NotFound is "not blocked", not unknown.
	ksvc.Status.LatestCreatedRevisionName = "gone"
	st = r.detectPodCreationBlocked(context.Background(), app, ksvc)
	if st.blocked || st.unknown {
		t.Fatalf("got %+v", st)
	}
}

func TestPodCreationBlocked_UsedNumbersChurnIsQuiet(t *testing.T) {
	now := time.Now()
	first := podCreationState{blocked: true, reason: ReasonQuotaExceeded, revision: "shop-00001", message: quotaMsg}
	v := verdictWithPodCreation(verdictApp(), first, now)
	c := findVerdictCondition(t, v, ConditionPodCreationBlocked)

	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{c}
	drifted := first
	drifted.message = strings.Replace(quotaMsg, "used: limits.cpu=3500m", "used: limits.cpu=3600m", 1)
	v2 := verdictWithPodCreation(app, drifted, now)
	if len(v2.events) != 0 {
		t.Fatalf("a changed used: figure must not re-fire the event, got %+v", v2.events)
	}
	if got := findVerdictCondition(t, v2, ConditionPodCreationBlocked); got.Message != c.Message {
		t.Fatalf("message must stay stable while reason+revision are unchanged (no status rewrite), got %q", got.Message)
	}

	// A different revision IS news.
	other := drifted
	other.revision = "shop-00002"
	v3 := verdictWithPodCreation(app, other, now)
	if len(v3.events) != 1 {
		t.Fatalf("new revision must emit, got %+v", v3.events)
	}
}

func TestPodCreationBlocked_StickyKeepsPriorVerdict(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	prior := metav1.Condition{Type: ConditionPodCreationBlocked, Status: metav1.ConditionTrue, Reason: ReasonQuotaExceeded, Message: "revision shop-00001 cannot create pods"}
	app.Status.Conditions = []metav1.Condition{prior}
	v := verdictWithPodCreation(app, podCreationState{sticky: true}, now)
	if c := findVerdictCondition(t, v, ConditionPodCreationBlocked); c.Message != prior.Message || len(v.events) != 0 {
		t.Fatalf("sticky must carry verbatim, got %+v / %+v", c, v.events)
	}
}

func rejectingDeployment(replicaFailure corev1.ConditionStatus, reason, msg string) *appsv1.Deployment {
	d := &appsv1.Deployment{}
	d.Name = "shop-00001-deployment"
	d.Namespace = "prod"
	d.Status.Conditions = []appsv1.DeploymentCondition{{
		Type: appsv1.DeploymentReplicaFailure, Status: replicaFailure, Reason: reason, Message: msg,
	}}
	return d
}

func TestDetectPodCreationBlocked_StaysBlockedAfterProgressDeadline(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := servingv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionPodCreationBlocked, Status: metav1.ConditionTrue, Reason: ReasonQuotaExceeded,
		Message: "revision shop-00001 cannot create pods — rejected: x.",
	}}
	ksvc := &servingv1.Service{}
	ksvc.Status.LatestCreatedRevisionName = "shop-00001"
	detect := func(rev *servingv1.Revision, ksvc *servingv1.Service, extra ...client.Object) podCreationState {
		c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(rev).WithObjects(extra...).Build()
		r := &NextAppReconciler{Client: c, APIReader: c}
		return r.detectPodCreationBlocked(context.Background(), app, ksvc)
	}
	deadline := func() *servingv1.Revision {
		return blockedRevision("ProgressDeadlineExceeded", "Initial scale was never achieved", corev1.ConditionFalse)
	}

	// Deadline flip while the Deployment STILL reports an admission rejection -> sticky.
	st := detect(deadline(), ksvc, rejectingDeployment(corev1.ConditionTrue, "FailedCreate", quotaMsg))
	if !st.sticky || st.blocked {
		t.Fatalf("still rejecting must be sticky, got %+v", st)
	}
	// Quota fixed, pods now crash-loop: ReplicaFailure gone -> clear.
	st = detect(deadline(), ksvc, rejectingDeployment(corev1.ConditionFalse, "", ""))
	if st.sticky || st.blocked || st.unknown {
		t.Fatalf("admission no longer rejecting must clear, got %+v", st)
	}
	// ReplicaFailure for a NON-admission cause (webhook) -> clear.
	st = detect(deadline(), ksvc, rejectingDeployment(corev1.ConditionTrue, "FailedCreate", `admission webhook "x" denied the request`))
	if st.sticky || st.blocked {
		t.Fatalf("non-quota rejection must clear, got %+v", st)
	}
	// Deployment gone -> clear.
	st = detect(deadline(), ksvc)
	if st.sticky || st.blocked || st.unknown {
		t.Fatalf("missing deployment must clear, got %+v", st)
	}
	// Quota fixed, pods fail for ANOTHER reason: must not keep blaming quota.
	for _, reason := range []string{"ImagePullBackOff", "ContainerMissing", "Deploying"} {
		st = detect(blockedRevision(reason, "boom", corev1.ConditionFalse), ksvc,
			rejectingDeployment(corev1.ConditionTrue, "FailedCreate", quotaMsg))
		if st.sticky || st.blocked {
			t.Fatalf("reason %q must clear the quota verdict, got %+v", reason, st)
		}
	}
	// Recovered (True) -> cleared.
	st = detect(blockedRevision("", "", corev1.ConditionTrue), ksvc,
		rejectingDeployment(corev1.ConditionTrue, "FailedCreate", quotaMsg))
	if st.sticky || st.blocked || st.unknown {
		t.Fatalf("recovery must clear, got %+v", st)
	}
	// A NEW latest revision -> not carried.
	newRev := deadline()
	newRev.Name = "shop-00002"
	ksvc2 := &servingv1.Service{}
	ksvc2.Status.LatestCreatedRevisionName = "shop-00002"
	st = detect(newRev, ksvc2, rejectingDeployment(corev1.ConditionTrue, "FailedCreate", quotaMsg))
	if st.sticky || st.blocked {
		t.Fatalf("new revision must not inherit the prior block, got %+v", st)
	}
}

func TestDetectPodCreationBlocked_DeploymentReadErrorKeepsPriorVerdict(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := servingv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionPodCreationBlocked, Status: metav1.ConditionTrue, Reason: ReasonQuotaExceeded,
		Message: "revision shop-00001 cannot create pods — rejected: x.",
	}}
	ksvc := &servingv1.Service{}
	ksvc.Status.LatestCreatedRevisionName = "shop-00001"
	rev := blockedRevision("ProgressDeadlineExceeded", "Initial scale was never achieved", corev1.ConditionFalse)
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(rev).Build()
	failing := interceptor.NewClient(c, interceptor.Funcs{
		Get: func(ctx context.Context, cl client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*appsv1.Deployment); ok {
				return errors.New("apiserver hiccup")
			}
			return cl.Get(ctx, key, obj, opts...)
		},
	})
	r := &NextAppReconciler{Client: c, APIReader: failing}
	if st := r.detectPodCreationBlocked(context.Background(), app, ksvc); !st.unknown {
		t.Fatalf("a failed Deployment read must keep the prior verdict (unknown), got %+v", st)
	}
}

func TestDetectPodCreationBlocked_LongRevisionNameUsesKnativeChildName(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := servingv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	// A 58-char revision name: "<name>-deployment" exceeds 63, so Knative hashes it.
	revName := strings.Repeat("a", 53) + "-00001"
	rev := blockedRevision("ProgressDeadlineExceeded", "Initial scale was never achieved", corev1.ConditionFalse)
	rev.Name = revName
	depName := knnames.Deployment(rev)
	if depName == revName+"-deployment" {
		t.Fatalf("test precondition: name must be hashed, got %q", depName)
	}
	dep := rejectingDeployment(corev1.ConditionTrue, "FailedCreate", quotaMsg)
	dep.Name = depName
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionPodCreationBlocked, Status: metav1.ConditionTrue, Reason: ReasonQuotaExceeded,
		Message: "revision " + revName + " cannot create pods — rejected: x.",
	}}
	ksvc := &servingv1.Service{}
	ksvc.Status.LatestCreatedRevisionName = revName
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(rev, dep).Build()
	r := &NextAppReconciler{Client: c, APIReader: c}
	if st := r.detectPodCreationBlocked(context.Background(), app, ksvc); !st.sticky {
		t.Fatalf("long revision name: the hashed Deployment must be found, got %+v", st)
	}
}
