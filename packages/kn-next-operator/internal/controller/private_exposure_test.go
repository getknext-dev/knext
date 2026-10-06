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

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	duckv1 "knative.dev/pkg/apis/duck/v1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	servingv1beta1 "knative.dev/serving/pkg/apis/serving/v1beta1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// A Knative DomainMapping for a cluster-local NextApp's ksvc renders its
// KIngress with visibility ExternalIP EVEN WHEN labelled cluster-local, so the
// private app becomes publicly reachable. The operator must say so honestly via
// a Warning condition + Event (Ready unchanged), and must never delete or
// mutate the user's DomainMapping.

func privateApp() *appsv1alpha1.NextApp {
	app := verdictApp()
	app.Spec.Networking = &appsv1alpha1.NetworkingSpec{Visibility: appsv1alpha1.VisibilityClusterLocal}
	return app
}

func verdictWithExposure(app *appsv1alpha1.NextApp, pe privateExposureState, now time.Time) statusVerdict {
	return computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{}, pe, now)
}

func TestPrivateExposure_ConditionSetWarningEventReadyUnchanged(t *testing.T) {
	now := time.Now()
	v := verdictWithExposure(privateApp(), privateExposureState{private: true, domainMappings: []string{"app.example.com", "b.example.com"}}, now)

	c := findVerdictCondition(t, v, ConditionPrivateExposure)
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonDomainMappingPublishesPrivateApp {
		t.Fatalf("PrivateExposure: got %+v", c)
	}
	if !strings.Contains(c.Message, "app.example.com") || !strings.Contains(c.Message, "b.example.com") {
		t.Fatalf("message must name the offending DomainMappings: %q", c.Message)
	}
	// Ready is NOT flipped: the workload is healthy; this is an exposure warning.
	if r := findVerdictCondition(t, v, ConditionReady); r.Status != metav1.ConditionTrue {
		t.Fatalf("Ready must be unchanged by a PrivateExposure warning, got %+v", r)
	}
	var warned bool
	for _, e := range v.events {
		if e.reason == ReasonDomainMappingPublishesPrivateApp && e.eventType == corev1.EventTypeWarning {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("expected a Warning event on entry, got %+v", v.events)
	}
}

func TestPrivateExposure_EventIsTransitionGated(t *testing.T) {
	now := time.Now()
	app := privateApp()
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionPrivateExposure, Status: metav1.ConditionTrue, Reason: ReasonDomainMappingPublishesPrivateApp,
	}}
	v := verdictWithExposure(app, privateExposureState{private: true, domainMappings: []string{"a.example.com"}}, now)
	for _, e := range v.events {
		if e.reason == ReasonDomainMappingPublishesPrivateApp {
			t.Fatalf("event must not re-fire while the condition already stands: %+v", e)
		}
	}
}

func TestPrivateExposure_NoMappingsNoConditionAndClearsStale(t *testing.T) {
	now := time.Now()
	v := verdictWithExposure(privateApp(), privateExposureState{private: true}, now)
	for _, c := range v.conditions {
		if c.Type == ConditionPrivateExposure {
			t.Fatalf("no DomainMapping => no condition, got %+v", c)
		}
	}
	// Previously set, DM now gone => condition removed.
	app := privateApp()
	app.Status.Conditions = []metav1.Condition{{Type: ConditionPrivateExposure, Status: metav1.ConditionTrue, Reason: ReasonDomainMappingPublishesPrivateApp}}
	v = verdictWithExposure(app, privateExposureState{private: true}, now)
	if !containsStr(v.removeConditions, ConditionPrivateExposure) {
		t.Fatalf("stale condition must be removed, removeConditions=%v", v.removeConditions)
	}
}

func TestPrivateExposure_PublicAppNeverFlagged(t *testing.T) {
	now := time.Now()
	// private=false even if the detector were handed mappings.
	v := verdictWithExposure(verdictApp(), privateExposureState{private: false, domainMappings: []string{"x"}}, now)
	for _, c := range v.conditions {
		if c.Type == ConditionPrivateExposure {
			t.Fatalf("public app must never carry PrivateExposure, got %+v", c)
		}
	}
	if containsStr(v.removeConditions, ConditionPrivateExposure) {
		t.Fatalf("no prior condition => nothing to remove (conditions order stays byte-identical)")
	}
}

func TestPrivateExposure_UnknownKeepsPriorVerdict(t *testing.T) {
	now := time.Now()
	app := privateApp()
	app.Status.Conditions = []metav1.Condition{{Type: ConditionPrivateExposure, Status: metav1.ConditionTrue, Reason: ReasonDomainMappingPublishesPrivateApp, Message: "prior"}}
	v := verdictWithExposure(app, privateExposureState{private: true, unknown: true}, now)
	if containsStr(v.removeConditions, ConditionPrivateExposure) {
		t.Fatalf("a transient list error is not evidence the DomainMapping is gone; must not clear")
	}
	c := findVerdictCondition(t, v, ConditionPrivateExposure)
	if c.Message != "prior" {
		t.Fatalf("prior condition must be carried through unchanged, got %+v", c)
	}
}

func containsStr(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func dm(ns, name, refName string) *servingv1beta1.DomainMapping {
	return &servingv1beta1.DomainMapping{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: servingv1beta1.DomainMappingSpec{Ref: duckv1.KReference{
			APIVersion: "serving.knative.dev/v1", Kind: "Service", Name: refName, Namespace: ns,
		}},
	}
}

func fakeScheme() *runtime.Scheme {
	s := runtime.NewScheme()
	_ = servingv1beta1.AddToScheme(s)
	return s
}

func TestDetectPrivateExposure_MatchesOnlyThisAppsKsvc(t *testing.T) {
	app := privateApp()
	app.Namespace = "team-a"
	other := dm("team-a", "other.example.com", "someone-else")
	otherNS := dm("team-b", "app.example.com", app.Name)
	hit := dm("team-a", "app.example.com", app.Name)
	k8sSvcRef := dm("team-a", "svc.example.com", app.Name)
	k8sSvcRef.Spec.Ref.APIVersion = "v1"
	notSvc := dm("team-a", "route.example.com", app.Name)
	notSvc.Spec.Ref.Kind = "Route"

	c := fake.NewClientBuilder().WithScheme(fakeScheme()).WithObjects(other, otherNS, hit, k8sSvcRef, notSvc).Build()
	r := &NextAppReconciler{Client: c}
	got := r.detectPrivateExposure(context.Background(), app)

	if !got.private || got.unknown {
		t.Fatalf("state: %+v", got)
	}
	want := []string{"app.example.com", "svc.example.com"}
	if strings.Join(got.domainMappings, ",") != strings.Join(want, ",") {
		t.Fatalf("domainMappings: got %v, want %v (same-ns, ref -> this ksvc only, sorted)", got.domainMappings, want)
	}
}

func TestDetectPrivateExposure_PublicAppSkipsTheList(t *testing.T) {
	app := verdictApp()
	c := fake.NewClientBuilder().WithScheme(fakeScheme()).WithInterceptorFuncs(interceptor.Funcs{
		List: func(context.Context, client.WithWatch, client.ObjectList, ...client.ListOption) error {
			t.Fatal("a public app must not trigger a DomainMapping list")
			return nil
		},
	}).Build()
	r := &NextAppReconciler{Client: c}
	if got := r.detectPrivateExposure(context.Background(), app); got.private {
		t.Fatalf("public app: %+v", got)
	}
}

func TestDetectPrivateExposure_CRDAbsentIsNotAnError(t *testing.T) {
	app := privateApp()
	noMatch := &apimeta.NoKindMatchError{GroupKind: schema.GroupKind{Group: "serving.knative.dev", Kind: "DomainMapping"}}
	c := fake.NewClientBuilder().WithScheme(fakeScheme()).WithInterceptorFuncs(interceptor.Funcs{
		List: func(context.Context, client.WithWatch, client.ObjectList, ...client.ListOption) error { return noMatch },
	}).Build()
	r := &NextAppReconciler{Client: c}
	got := r.detectPrivateExposure(context.Background(), app)
	if got.unknown || len(got.domainMappings) != 0 {
		t.Fatalf("absent CRD must read as 'no mappings', not unknown: %+v", got)
	}
}

func TestDetectPrivateExposure_TransientErrorIsUnknown(t *testing.T) {
	app := privateApp()
	c := fake.NewClientBuilder().WithScheme(fakeScheme()).WithInterceptorFuncs(interceptor.Funcs{
		List: func(context.Context, client.WithWatch, client.ObjectList, ...client.ListOption) error {
			return errors.New("apiserver timeout")
		},
	}).Build()
	r := &NextAppReconciler{Client: c}
	if got := r.detectPrivateExposure(context.Background(), app); !got.unknown {
		t.Fatalf("transient error must be unknown: %+v", got)
	}
}

func TestDomainMappingToNextAppRequests(t *testing.T) {
	r := &NextAppReconciler{}
	got := r.domainMappingToNextAppRequests(context.Background(), dm("team-a", "app.example.com", "my-app"))
	want := reconcile.Request{NamespacedName: types.NamespacedName{Name: "my-app", Namespace: "team-a"}}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("got %+v want %+v", got, want)
	}
	if got := r.domainMappingToNextAppRequests(context.Background(), &servingv1.Service{}); got != nil {
		t.Fatalf("non-DomainMapping must enqueue nothing")
	}
	empty := dm("team-a", "x", "")
	if got := r.domainMappingToNextAppRequests(context.Background(), empty); got != nil {
		t.Fatalf("empty ref must enqueue nothing")
	}
}
