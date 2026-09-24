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

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Issue #1288: a spec.secrets.envMap entry whose name collides with an
// operator-injected system env var (HOSTNAME, NODE_ENV, STORAGE_PROVIDER,
// ...) used to be APPENDED as a SECOND env entry with the same name — never
// dropped, never warned. Kubernetes/kubelet's duplicate-env semantics are
// last-wins, so which value actually reached the container depended on
// append order, an implementation detail the reconciler never surfaced.
//
// buildKsvcEnv now drops the colliding envMap entry (the operator's own
// value always wins) and reports the dropped name so computeStatusVerdict
// can surface it as a real, honest status condition + event — never a new
// branch in Reconcile (architecture.md).

func envMapCollisionApp(envMap map[string]appsv1alpha1.EnvMapEntry) *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "ns"},
		Spec: appsv1alpha1.NextAppSpec{
			Image:   "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
			Secrets: &appsv1alpha1.SecretsSpec{EnvMap: envMap},
		},
	}
}

func countNamed(vs []corev1.EnvVar, name string) int {
	n := 0
	for _, v := range vs {
		if v.Name == name {
			n++
		}
	}
	return n
}

func TestBuildKsvcEnv_EnvMapCollisionWithAlwaysInjectedSystemEnv_IsDropped(t *testing.T) {
	app := envMapCollisionApp(map[string]appsv1alpha1.EnvMapEntry{
		// HOSTNAME and NODE_ENV are injected UNCONDITIONALLY by buildKsvcEnv.
		"NODE_ENV":  {SecretName: "s", SecretKey: "k"},
		"UNRELATED": {SecretName: "s", SecretKey: "k2"},
	})
	r := &NextAppReconciler{}
	env, _, dropped := r.buildKsvcEnv(app)

	if got := countNamed(env, "NODE_ENV"); got != 1 {
		t.Fatalf("NODE_ENV appears %d times in the rendered env, want exactly 1 (the operator's own) — "+
			"a second entry means the envMap value was silently appended alongside it, the #1288 bug", got)
	}
	// The surviving NODE_ENV entry must be the operator's plain Value, NOT
	// a SecretKeyRef from the dropped envMap entry — the operator's own
	// value must win, not merely be present alongside it.
	for _, e := range env {
		if e.Name == "NODE_ENV" {
			if e.ValueFrom != nil {
				t.Fatalf("NODE_ENV is a SecretKeyRef (the dropped envMap entry survived instead of the operator's own plain value): %+v", e)
			}
			if e.Value != "production" {
				t.Fatalf("NODE_ENV = %q, want the operator's own %q", e.Value, "production")
			}
		}
	}
	if len(dropped) != 1 || dropped[0] != "NODE_ENV" {
		t.Fatalf("dropped envMap names: got %v, want [NODE_ENV]", dropped)
	}
	if got := countNamed(env, "UNRELATED"); got != 1 {
		t.Fatalf("UNRELATED (no collision) appears %d times, want exactly 1 — it must still be wired", got)
	}
}

func TestBuildKsvcEnv_EnvMapCollisionWithConditionalSystemEnv_IsDropped(t *testing.T) {
	app := envMapCollisionApp(map[string]appsv1alpha1.EnvMapEntry{
		// STORAGE_PROVIDER is injected only when spec.storage is configured —
		// proves the collision guard checks the ACTUAL rendered env, not a
		// static list, so a conditional operator var is caught too.
		"STORAGE_PROVIDER": {SecretName: "s", SecretKey: "k"},
	})
	app.Spec.Storage = &appsv1alpha1.StorageSpec{Provider: "s3", Bucket: "b"}
	r := &NextAppReconciler{}
	env, _, dropped := r.buildKsvcEnv(app)

	if got := countNamed(env, "STORAGE_PROVIDER"); got != 1 {
		t.Fatalf("STORAGE_PROVIDER appears %d times, want exactly 1", got)
	}
	for _, e := range env {
		if e.Name == "STORAGE_PROVIDER" && e.Value != "s3" {
			t.Fatalf("STORAGE_PROVIDER = %q, want the operator's own %q", e.Value, "s3")
		}
	}
	if len(dropped) != 1 || dropped[0] != "STORAGE_PROVIDER" {
		t.Fatalf("dropped envMap names: got %v, want [STORAGE_PROVIDER]", dropped)
	}
}

func TestBuildKsvcEnv_NoCollision_NothingDropped(t *testing.T) {
	app := envMapCollisionApp(map[string]appsv1alpha1.EnvMapEntry{
		"API_TOKEN": {SecretName: "s", SecretKey: "k"},
	})
	r := &NextAppReconciler{}
	_, _, dropped := r.buildKsvcEnv(app)
	if len(dropped) != 0 {
		t.Fatalf("dropped envMap names: got %v, want none", dropped)
	}
}

func TestComputeStatusVerdict_EnvMapCollision_ConditionAndEvent(t *testing.T) {
	now := time.Now()
	app := verdictApp()

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{}, []string{"NODE_ENV"}, now)

	c := findVerdictCondition(t, v, ConditionEnvMapCollision)
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonEnvVarIgnored {
		t.Fatalf("EnvMapCollision: got %+v, want True/%s", c, ReasonEnvVarIgnored)
	}
	if !strings.Contains(c.Message, "NODE_ENV") {
		t.Fatalf("EnvMapCollision message %q does not name the dropped var", c.Message)
	}
	found := false
	for _, e := range v.events {
		if e.reason == ReasonEnvVarIgnored && e.eventType == corev1.EventTypeWarning {
			found = true
		}
	}
	if !found {
		t.Fatalf("no Warning/%s event emitted: got %+v", ReasonEnvVarIgnored, v.events)
	}
}

func TestComputeStatusVerdict_NoEnvMapCollision_ConditionFalse(t *testing.T) {
	now := time.Now()
	app := verdictApp()

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{}, nil, now)

	c := findVerdictCondition(t, v, ConditionEnvMapCollision)
	if c.Status != metav1.ConditionFalse {
		t.Fatalf("EnvMapCollision: got %+v, want False", c)
	}
	if len(v.events) != 0 {
		t.Fatalf("events: got %+v, want none on a healthy pass with no collision", v.events)
	}
}

// TestComputeStatusVerdict_EnvMapCollision_TransitionGated proves the event
// fires only when the dropped set CHANGES (the #98 no-op contract) — not on
// every converged reconcile of an unchanged collision.
func TestComputeStatusVerdict_EnvMapCollision_TransitionGated(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{{
		Type:   ConditionEnvMapCollision,
		Status: metav1.ConditionTrue,
		Reason: ReasonEnvVarIgnored,
		Message: "spec.secrets.envMap defines the following name(s), already managed by " +
			"operator-injected system env (which always wins): NODE_ENV. Ignored — no action " +
			"needed unless the operator's own value is not what you intended.",
	}}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{}, []string{"NODE_ENV"}, now)

	if len(v.events) != 0 {
		t.Fatalf("events: got %+v, want none — the collision set is UNCHANGED from the prior reconcile", v.events)
	}
}
