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

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The KnextPlatform's own status (ADR-0064): Accepted, DefaultsPropagated and
// Ready, plus rollout counts. The operator writes ONLY this subresource.

func cond(conds []metav1.Condition, t string) *metav1.Condition {
	return apimeta.FindStatusCondition(conds, t)
}

func appWithPlatform(name, hash string, cond *metav1.Condition) appsv1alpha1.NextApp {
	a := appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"}}
	if hash != "" {
		a.Status.Platform = &appsv1alpha1.NextAppPlatformStatus{SpecHash: hash}
	}
	if cond != nil {
		a.Status.Conditions = []metav1.Condition{*cond}
	}
	return a
}

func TestComputePlatformStatus_AcceptedAndReady(t *testing.T) {
	p := platformObj(5, nil)
	st := computePlatformStatus(p, nil)

	if st.ObservedGeneration != 5 {
		t.Errorf("observedGeneration = %d, want 5", st.ObservedGeneration)
	}
	if c := cond(st.Conditions, "Accepted"); c == nil || c.Status != metav1.ConditionTrue {
		t.Errorf("Accepted = %+v, want True", c)
	}
	if c := cond(st.Conditions, "Ready"); c == nil || c.Status != metav1.ConditionTrue {
		t.Errorf("Ready = %+v, want True", c)
	}
	if c := cond(st.Conditions, "DefaultsPropagated"); c == nil || c.Status != metav1.ConditionTrue {
		t.Errorf("DefaultsPropagated = %+v, want True with no apps to propagate to", c)
	}
	if st.Rollout == nil || st.Rollout.Pending != 0 || st.Rollout.Applied != 0 || st.Rollout.Held != 0 {
		t.Errorf("rollout = %+v, want all zero", st.Rollout)
	}
}

func TestComputePlatformStatus_FastColdStartIsAcceptedButSaysItDoesNothingYet(t *testing.T) {
	p := platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) { s.Profile = platformv1alpha1.ProfileFastColdStart })
	c := cond(computePlatformStatus(p, nil).Conditions, "Accepted")
	if c == nil || c.Status != metav1.ConditionTrue {
		t.Fatalf("Accepted = %+v, want True", c)
	}
	if c.Message == "" || !strings.Contains(c.Message, "fastColdStart") || !strings.Contains(c.Message, "no value") {
		t.Errorf("the Accepted message must be honest that the profile sets no value in this release: %q", c.Message)
	}
}

func TestComputePlatformStatus_RejectsWhatItWillNotHonour(t *testing.T) {
	notDefault := platformObj(1, nil)
	notDefault.Name = "staging"
	invalid := platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "banana"}}
	})

	for name, p := range map[string]*platformv1alpha1.KnextPlatform{"wrong name": notDefault, "invalid spec": invalid} {
		st := computePlatformStatus(p, []appsv1alpha1.NextApp{appWithPlatform("a", "", nil)})
		if c := cond(st.Conditions, "Accepted"); c == nil || c.Status != metav1.ConditionFalse {
			t.Errorf("%s: Accepted = %+v, want False", name, c)
		}
		if c := cond(st.Conditions, "Ready"); c == nil || c.Status != metav1.ConditionFalse {
			t.Errorf("%s: Ready = %+v, want False", name, c)
		}
		if st.Rollout != nil {
			t.Errorf("%s: a platform that is not honoured has no rollout to count, got %+v", name, st.Rollout)
		}
	}
}

func TestComputePlatformStatus_RolloutCounts(t *testing.T) {
	p := platformObj(3, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}
	})
	hash := platformSpecHash(&p.Spec)
	held := &metav1.Condition{Type: ConditionPlatformDefaultsApplied, Status: metav1.ConditionFalse, Reason: ReasonEffectiveSpecInvalid}
	apps := []appsv1alpha1.NextApp{
		appWithPlatform("applied-1", hash, nil),
		appWithPlatform("applied-2", hash, nil),
		appWithPlatform("stale", "old-hash", nil),
		appWithPlatform("never-rendered", "", nil),
		appWithPlatform("held", "old-hash", held),
	}
	st := computePlatformStatus(p, apps)

	if st.Rollout == nil || st.Rollout.Applied != 2 || st.Rollout.Pending != 2 || st.Rollout.Held != 1 {
		t.Fatalf("rollout = %+v, want applied 2 pending 2 held 1", st.Rollout)
	}
	prop := cond(st.Conditions, "DefaultsPropagated")
	if prop == nil || prop.Status != metav1.ConditionFalse || prop.Reason != "Progressing" {
		t.Errorf("DefaultsPropagated = %+v, want False/Progressing", prop)
	}
	if !strings.Contains(prop.Message, "2 pending") || !strings.Contains(prop.Message, "1 held") {
		t.Errorf("the message should carry the counts: %q", prop.Message)
	}
	if c := cond(st.Conditions, "Ready"); c.Status != metav1.ConditionTrue {
		t.Errorf("Ready = %+v: an accepted platform is Ready even while it propagates", c)
	}
}

// An app that never reaches the platform stage cannot be "pending" forever: one
// invalid app would otherwise hold DefaultsPropagated at Progressing for the
// whole cluster, and a deleting app is on its way out.
func TestComputePlatformStatus_AppsThatCannotReceiveTheConfigAreNotCounted(t *testing.T) {
	p := platformObj(1, nil)
	hash := platformSpecHash(&p.Spec)

	invalid := appWithPlatform("invalid", "", &metav1.Condition{Type: ConditionReady, Status: metav1.ConditionFalse, Reason: "InvalidSpec"})
	deleting := appWithPlatform("deleting", "old-hash", nil)
	now := metav1.Now()
	deleting.DeletionTimestamp = &now

	st := computePlatformStatus(p, []appsv1alpha1.NextApp{appWithPlatform("ok", hash, nil), invalid, deleting})

	if st.Rollout == nil || st.Rollout.Applied != 1 || st.Rollout.Pending != 0 || st.Rollout.Held != 0 {
		t.Fatalf("rollout = %+v, want only the one reachable app counted (applied 1)", st.Rollout)
	}
	if c := cond(st.Conditions, "DefaultsPropagated"); c == nil || c.Status != metav1.ConditionTrue {
		t.Errorf("DefaultsPropagated = %+v, want True: nothing reachable is waiting", c)
	}
}

func TestComputePlatformStatus_PropagatedWhenEveryAppIsAtTheCurrentConfig(t *testing.T) {
	p := platformObj(1, nil)
	hash := platformSpecHash(&p.Spec)
	st := computePlatformStatus(p, []appsv1alpha1.NextApp{appWithPlatform("a", hash, nil), appWithPlatform("b", hash, nil)})
	if c := cond(st.Conditions, "DefaultsPropagated"); c == nil || c.Status != metav1.ConditionTrue {
		t.Errorf("DefaultsPropagated = %+v, want True when every app is at the current config", c)
	}
}

// Through the reconciler, against a fake client: status is written to the
// subresource, a converged pass writes nothing, and a missing object is quiet.
func TestPlatformReconciler_WritesStatusAndGoesQuietWhenConverged(t *testing.T) {
	h := newPlatformHarness(t, appNamed("web", nil), platformObj(1, func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}
	}))
	pr := &KnextPlatformReconciler{Client: h.c, Scheme: h.scheme}
	req := reconcile.Request{NamespacedName: types.NamespacedName{Name: platformv1alpha1.SingletonName}}

	// The app has not been rendered against it yet: pending.
	if _, err := pr.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	got := &platformv1alpha1.KnextPlatform{}
	if err := h.c.Get(context.Background(), req.NamespacedName, got); err != nil {
		t.Fatal(err)
	}
	if got.Status.Rollout == nil || got.Status.Rollout.Pending != 1 {
		t.Fatalf("rollout = %+v, want 1 pending", got.Status.Rollout)
	}

	// After the app reconciles, the platform reports it applied.
	h.reconcile("web")
	if _, err := pr.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if err := h.c.Get(context.Background(), req.NamespacedName, got); err != nil {
		t.Fatal(err)
	}
	if got.Status.Rollout.Applied != 1 || got.Status.Rollout.Pending != 0 {
		t.Fatalf("rollout = %+v, want 1 applied", got.Status.Rollout)
	}
	if c := cond(got.Status.Conditions, "DefaultsPropagated"); c == nil || c.Status != metav1.ConditionTrue {
		t.Errorf("DefaultsPropagated = %+v, want True", c)
	}

	// A converged pass writes nothing (the same idle-hot-loop guard as the NextApp).
	rv := got.ResourceVersion
	if _, err := pr.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if err := h.c.Get(context.Background(), req.NamespacedName, got); err != nil {
		t.Fatal(err)
	}
	if got.ResourceVersion != rv {
		t.Errorf("a converged pass rewrote the status (rv %s -> %s)", rv, got.ResourceVersion)
	}

	// An object that is gone is not an error.
	if err := h.c.Delete(context.Background(), got); err != nil {
		t.Fatal(err)
	}
	if _, err := pr.Reconcile(context.Background(), req); err != nil {
		t.Errorf("reconciling a deleted platform must be a no-op, got %v", err)
	}
}
