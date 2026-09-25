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

// Issue #1288/#1391: a spec.secrets.envMap entry whose name collides with an
// operator-injected system env var (HOSTNAME, NODE_ENV, STORAGE_PROVIDER,
// ...) used to be APPENDED as a SECOND env entry with the same name — never
// resolved deterministically, never warned. Kubernetes/kubelet's
// duplicate-env semantics are last-wins, so which value actually reached the
// container depended on APPEND ORDER: the operator built its own entries
// FIRST, so the later-appended envMap entry actually WON under kubelet's real
// semantics.
//
// #1288 first shipped this as "the operator always wins", which review (#1391)
// found to be a silent BREAKING change for any CR already relying on the old
// (envMap-wins) behavior — e.g. a bound REDIS_URL Secret silently replaced by
// an empty operator default. The fix:
//   - Admission (validation.EnvMapReservedCollisions, wired into
//     ValidateNextAppSpecCreate/Update) now REJECTS any NEW such collision —
//     unratcheted on create, ratcheted (added-only) on update — so no new CR
//     can ever reach the reconciler with one.
//   - A CR that predates that rule (grandfathered) is resolved LOUDLY by the
//     reconciler: for validation.OperatorAlwaysWinsEnvNames (HOSTNAME only —
//     correctness, not just precedence, depends on it: #178/#184) the
//     operator's value wins and the envMap entry is dropped; for every OTHER
//     reserved name the envMap value WINS instead, preserving the value the
//     app was actually getting pre-#1288.

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

// TestBuildKsvcEnv_HostnameCollision_OperatorAlwaysWins proves the ONE
// exception: HOSTNAME is dropped from envMap and the operator's own
// HOSTNAME=0.0.0.0 always survives, even for a grandfathered CR — correctness
// (queue-proxy routing, #178/#184), not just precedence, depends on it.
func TestBuildKsvcEnv_HostnameCollision_OperatorAlwaysWins(t *testing.T) {
	app := envMapCollisionApp(map[string]appsv1alpha1.EnvMapEntry{
		"HOSTNAME":  {SecretName: "s", SecretKey: "k"},
		"UNRELATED": {SecretName: "s", SecretKey: "k2"},
	})
	r := &NextAppReconciler{}
	env, _, report := r.buildKsvcEnv(app)

	if got := countNamed(env, "HOSTNAME"); got != 1 {
		t.Fatalf("HOSTNAME appears %d times in the rendered env, want exactly 1 (the operator's own)", got)
	}
	for _, e := range env {
		if e.Name == "HOSTNAME" {
			if e.ValueFrom != nil {
				t.Fatalf("HOSTNAME is a SecretKeyRef (the dropped envMap entry survived instead of the operator's own plain value): %+v", e)
			}
			if e.Value != "0.0.0.0" {
				t.Fatalf("HOSTNAME = %q, want the operator's own %q", e.Value, "0.0.0.0")
			}
		}
	}
	if len(report.operatorWins) != 1 || report.operatorWins[0] != "HOSTNAME" {
		t.Fatalf("report.operatorWins: got %v, want [HOSTNAME]", report.operatorWins)
	}
	if len(report.userWins) != 0 {
		t.Fatalf("report.userWins: got %v, want none", report.userWins)
	}
	if got := countNamed(env, "UNRELATED"); got != 1 {
		t.Fatalf("UNRELATED (no collision) appears %d times, want exactly 1 — it must still be wired", got)
	}
}

// TestBuildKsvcEnv_UnconditionalReservedNameCollision_UserWins proves NODE_ENV
// — reserved but NOT in OperatorAlwaysWinsEnvNames — resolves with the
// envMap's Secret-backed value REPLACING the operator's plain entry, matching
// the pre-#1288 kubelet last-wins outcome for a grandfathered CR.
func TestBuildKsvcEnv_UnconditionalReservedNameCollision_UserWins(t *testing.T) {
	app := envMapCollisionApp(map[string]appsv1alpha1.EnvMapEntry{
		"NODE_ENV":  {SecretName: "s", SecretKey: "k"},
		"UNRELATED": {SecretName: "s", SecretKey: "k2"},
	})
	r := &NextAppReconciler{}
	env, _, report := r.buildKsvcEnv(app)

	if got := countNamed(env, "NODE_ENV"); got != 1 {
		t.Fatalf("NODE_ENV appears %d times in the rendered env, want exactly 1 — a second entry means "+
			"the collision resolution left a duplicate instead of replacing in place", got)
	}
	for _, e := range env {
		if e.Name == "NODE_ENV" {
			if e.ValueFrom == nil {
				t.Fatalf("NODE_ENV has no ValueFrom (the operator's own plain value survived instead of the envMap Secret ref): %+v", e)
			}
			if e.ValueFrom.SecretKeyRef.Name != "s" || e.ValueFrom.SecretKeyRef.Key != "k" {
				t.Fatalf("NODE_ENV ValueFrom = %+v, want SecretKeyRef{s, k}", e.ValueFrom)
			}
		}
	}
	if len(report.userWins) != 1 || report.userWins[0] != "NODE_ENV" {
		t.Fatalf("report.userWins: got %v, want [NODE_ENV]", report.userWins)
	}
	if len(report.operatorWins) != 0 {
		t.Fatalf("report.operatorWins: got %v, want none", report.operatorWins)
	}
	if got := countNamed(env, "UNRELATED"); got != 1 {
		t.Fatalf("UNRELATED (no collision) appears %d times, want exactly 1 — it must still be wired", got)
	}
}

// TestBuildKsvcEnv_ConditionalReservedNameCollision_UserWins proves the
// collision guard checks the ACTUAL rendered env (conditional on spec.storage
// being set), not a static list, AND that a conditional reserved name also
// resolves user-wins (it is not HOSTNAME).
func TestBuildKsvcEnv_ConditionalReservedNameCollision_UserWins(t *testing.T) {
	app := envMapCollisionApp(map[string]appsv1alpha1.EnvMapEntry{
		"STORAGE_PROVIDER": {SecretName: "s", SecretKey: "k"},
	})
	app.Spec.Storage = &appsv1alpha1.StorageSpec{Provider: "s3", Bucket: "b"}
	r := &NextAppReconciler{}
	env, _, report := r.buildKsvcEnv(app)

	if got := countNamed(env, "STORAGE_PROVIDER"); got != 1 {
		t.Fatalf("STORAGE_PROVIDER appears %d times, want exactly 1", got)
	}
	for _, e := range env {
		if e.Name == "STORAGE_PROVIDER" && e.ValueFrom == nil {
			t.Fatalf("STORAGE_PROVIDER = %+v, want the envMap Secret ref (user-wins), not the operator's plain value", e)
		}
	}
	if len(report.userWins) != 1 || report.userWins[0] != "STORAGE_PROVIDER" {
		t.Fatalf("report.userWins: got %v, want [STORAGE_PROVIDER]", report.userWins)
	}
}

func TestBuildKsvcEnv_NoCollision_ReportEmpty(t *testing.T) {
	app := envMapCollisionApp(map[string]appsv1alpha1.EnvMapEntry{
		"API_TOKEN": {SecretName: "s", SecretKey: "k"},
	})
	r := &NextAppReconciler{}
	_, _, report := r.buildKsvcEnv(app)
	if !report.empty() {
		t.Fatalf("report: got %+v, want empty", report)
	}
}

func TestComputeStatusVerdict_EnvMapCollision_OperatorWins_ConditionAndEvent(t *testing.T) {
	now := time.Now()
	app := verdictApp()

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{},
		envMapCollisionReport{operatorWins: []string{"HOSTNAME"}}, now)

	c := findVerdictCondition(t, v, ConditionEnvMapCollision)
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonEnvVarIgnored {
		t.Fatalf("EnvMapCollision: got %+v, want True/%s", c, ReasonEnvVarIgnored)
	}
	if !strings.Contains(c.Message, "HOSTNAME") {
		t.Fatalf("EnvMapCollision message %q does not name the collision", c.Message)
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

func TestComputeStatusVerdict_EnvMapCollision_UserWins_ConditionAndEvent(t *testing.T) {
	now := time.Now()
	app := verdictApp()

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{},
		envMapCollisionReport{userWins: []string{"NODE_ENV"}}, now)

	c := findVerdictCondition(t, v, ConditionEnvMapCollision)
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonEnvMapUserOverride {
		t.Fatalf("EnvMapCollision: got %+v, want True/%s", c, ReasonEnvMapUserOverride)
	}
	if !strings.Contains(c.Message, "NODE_ENV") {
		t.Fatalf("EnvMapCollision message %q does not name the collision", c.Message)
	}
	if !strings.Contains(c.Message, "overrides the operator's own default value") {
		t.Fatalf("EnvMapCollision message %q does not explain the override", c.Message)
	}
	found := false
	for _, e := range v.events {
		if e.reason == ReasonEnvMapUserOverride && e.eventType == corev1.EventTypeWarning {
			found = true
		}
	}
	if !found {
		t.Fatalf("no Warning/%s event emitted: got %+v", ReasonEnvMapUserOverride, v.events)
	}
}

func TestComputeStatusVerdict_NoEnvMapCollision_ConditionFalse(t *testing.T) {
	now := time.Now()
	app := verdictApp()

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{}, now)

	c := findVerdictCondition(t, v, ConditionEnvMapCollision)
	if c.Status != metav1.ConditionFalse {
		t.Fatalf("EnvMapCollision: got %+v, want False", c)
	}
	if len(v.events) != 0 {
		t.Fatalf("events: got %+v, want none on a healthy pass with no collision", v.events)
	}
}

// TestComputeStatusVerdict_EnvMapCollision_TransitionGated proves the event
// fires only when the collision set CHANGES (the #98 no-op contract) — not on
// every converged reconcile of an unchanged collision.
func TestComputeStatusVerdict_EnvMapCollision_TransitionGated(t *testing.T) {
	now := time.Now()
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{{
		Type:   ConditionEnvMapCollision,
		Status: metav1.ConditionTrue,
		Reason: ReasonEnvMapUserOverride,
		Message: "spec.secrets.envMap collides with operator-managed system env — NODE_ENV: " +
			"spec.secrets.envMap overrides the operator's own default value for these name(s) — " +
			"either because they are connection-string names (REDIS_URL, KAFKA_BROKER_URL, " +
			"OTEL_EXPORTER_OTLP_ENDPOINT) that are always allowed to be user-supplied, or because " +
			"this NextApp reconciled with the collision already present; remove the envMap entry " +
			"to fall back to the operator's default.",
	}}

	v := computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{},
		envMapCollisionReport{userWins: []string{"NODE_ENV"}}, now)

	if len(v.events) != 0 {
		t.Fatalf("events: got %+v, want none — the collision set is UNCHANGED from the prior reconcile", v.events)
	}
}
