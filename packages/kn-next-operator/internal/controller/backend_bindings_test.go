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
	"encoding/json"
	"math/rand"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// The zone binding env (ADR-0004 Amendment 2 Decision 3): rendered by the
// NextApp reconciler into the zone's Knative Service template, never written to
// NextApp.spec. These are the PURE halves; backend_bindings_envtest_test.go
// drives the same rules through a real Reconcile.

type bindingFixture struct {
	Namespace string `json:"namespace"`
	Cases     []struct {
		Name     string `json:"name"`
		Bindings []struct {
			Name               string `json:"name"`
			Service            string `json:"service"`
			State              string `json:"state"`
			ServedProtoVersion string `json:"servedProtoVersion"`
			WakeAhead          bool   `json:"wakeAhead"`
		} `json:"bindings"`
		Env map[string]string `json:"env"`
	} `json:"cases"`
}

func loadBindingFixture(t *testing.T) bindingFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/zone-binding-env.json")
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var f bindingFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode shared fixture: %v", err)
	}
	if len(f.Cases) < 4 {
		t.Fatalf("shared fixture has %d cases; it is only meaningful over several", len(f.Cases))
	}
	return f
}

// TestSharedBindingEnvFixture is the operator half of the shared contract: for
// every case, the operator renders EXACTLY the fixture's env, no more and no
// less. The TypeScript half reads the same file.
func TestSharedBindingEnvFixture(t *testing.T) {
	f := loadBindingFixture(t)
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var b zoneBindings
			for _, fb := range c.Bindings {
				b.entries = append(b.entries, zoneBinding{
					name: fb.Name, service: fb.Service, state: zoneBindingState(fb.State),
					servedProtoVersion: fb.ServedProtoVersion, wakeAhead: fb.WakeAhead,
				})
			}
			got := renderBindingEnv(f.Namespace, nil, b)
			if len(got.collisions) != 0 {
				t.Fatalf("unexpected collisions %v", got.collisions)
			}
			gotMap := map[string]string{}
			for _, e := range got.env {
				if _, dup := gotMap[e.Name]; dup {
					t.Fatalf("variable %s rendered twice", e.Name)
				}
				gotMap[e.Name] = e.Value
			}
			if c.Env == nil {
				c.Env = map[string]string{}
			}
			if !reflect.DeepEqual(gotMap, c.Env) {
				t.Fatalf("rendered env differs from the shared fixture\nwant %v\n got %v", c.Env, gotMap)
			}
		})
	}
}

func TestBindingEnvNames(t *testing.T) {
	for name, want := range map[string]string{
		"orders":       "ORDERS",
		"user-profile": "USER_PROFILE",
		"a2-b3-c4":     "A2_B3_C4",
	} {
		if got := BindingURLEnv(name); got != want+"_SERVICE_URL" {
			t.Errorf("BindingURLEnv(%q) = %q", name, got)
		}
		if got := BindingProtoVersionEnv(name); got != want+"_SERVICE_PROTO_VERSION" {
			t.Errorf("BindingProtoVersionEnv(%q) = %q", name, got)
		}
	}
	if WakeFunctionsEnv != "KNEXT_WAKE_FUNCTIONS" {
		t.Errorf("the wake-list variable name is a public contract: got %q", WakeFunctionsEnv)
	}
}

// The rendered env is sorted deterministically whatever order the bindings
// arrive in, so a reconcile with no change rolls no revision.
func TestBindingEnvIsDeterministic(t *testing.T) {
	entries := []zoneBinding{
		{name: "zeta", service: "z", state: bindingBound, servedProtoVersion: "1.0.0", wakeAhead: true},
		{name: "alpha", service: "a", state: bindingBound, servedProtoVersion: "1.0.0", wakeAhead: true},
		{name: "mid", service: "m", state: bindingBound, wakeAhead: true},
		{name: "beta", service: "b", state: bindingBound, servedProtoVersion: "2.0.0", wakeAhead: false},
	}
	first := renderBindingEnv("ns", nil, zoneBindings{entries: entries})
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	for i := 0; i < 50; i++ {
		shuffled := append([]zoneBinding(nil), entries...)
		rng.Shuffle(len(shuffled), func(a, b int) { shuffled[a], shuffled[b] = shuffled[b], shuffled[a] })
		got := renderBindingEnv("ns", nil, zoneBindings{entries: shuffled})
		if !reflect.DeepEqual(got.env, first.env) {
			t.Fatalf("binding env order depends on input order:\n%v\n%v", first.env, got.env)
		}
	}
	for i := 1; i < len(first.env); i++ {
		if first.env[i-1].Name >= first.env[i].Name {
			t.Fatalf("binding env not sorted by name: %v", first.env)
		}
	}
	if v := envValue(first.env, WakeFunctionsEnv); v != "alpha,mid,zeta" {
		t.Fatalf("wake list = %q, want the sorted names minus the opted-out one", v)
	}
}

// A same-named entry the zone already has (spec.env, spec.secrets.envMap,
// operator system env) is NOT overwritten: the binding variable is skipped and
// reported by name.
func TestBindingEnvCollisionKeepsExistingValueAndReportsName(t *testing.T) {
	existing := []corev1.EnvVar{
		{Name: "ORDERS_SERVICE_URL", Value: "http://my-dev-orders"},
		{Name: WakeFunctionsEnv, Value: "something-else"},
	}
	b := zoneBindings{entries: []zoneBinding{
		{name: "orders", service: "orders-fn", state: bindingBound, servedProtoVersion: "1.0.0", wakeAhead: true},
	}}
	got := renderBindingEnv("shop", existing, b)
	if envValue(got.env, "ORDERS_SERVICE_URL") != "" || envValue(got.env, WakeFunctionsEnv) != "" {
		t.Fatalf("a colliding variable was rendered over the zone's own entry: %v", got.env)
	}
	if envValue(got.env, "ORDERS_SERVICE_PROTO_VERSION") != "1.0.0" {
		t.Fatalf("a non-colliding binding variable must still render: %v", got.env)
	}
	want := []string{"KNEXT_WAKE_FUNCTIONS", "ORDERS_SERVICE_URL"}
	if !reflect.DeepEqual(got.collisions, want) {
		t.Fatalf("collisions = %v, want %v", got.collisions, want)
	}
}

func TestNoBindingsRenderNothing(t *testing.T) {
	got := renderBindingEnv("shop", []corev1.EnvVar{{Name: "A", Value: "1"}}, zoneBindings{})
	if got.env != nil || got.collisions != nil {
		t.Fatalf("no bindings must render nothing at all (nil, not empty): %+v", got)
	}
}

// applyBindingEnv appends to the zone container and touches nothing else, and
// with no binding leaves the container byte-for-byte as built.
func TestApplyBindingEnvAppendsOnlyToTheZoneContainer(t *testing.T) {
	ksvc := &servingv1.Service{}
	ksvc.Spec.Template.Spec.Containers = []corev1.Container{{
		Image: "img", Env: []corev1.EnvVar{{Name: "HOSTNAME", Value: "0.0.0.0"}},
	}}
	before := ksvc.DeepCopy()
	if c := applyBindingEnv(ksvc, "shop", zoneBindings{}); c != nil {
		t.Fatalf("collisions with no bindings: %v", c)
	}
	if !reflect.DeepEqual(before, ksvc) {
		t.Fatalf("no binding changed the Knative Service")
	}
	applyBindingEnv(ksvc, "shop", zoneBindings{entries: []zoneBinding{
		{name: "orders", service: "orders-fn", state: bindingBound, wakeAhead: true},
	}})
	env := ksvc.Spec.Template.Spec.Containers[0].Env
	if len(env) != 3 || env[0].Name != "HOSTNAME" || envValue(env, "ORDERS_SERVICE_URL") == "" {
		t.Fatalf("binding env not appended after the existing env: %v", env)
	}
}

// --- the BackendBindings condition is computed in computeStatusVerdict --------

func bindingVerdict(app *appsv1alpha1.NextApp, b zoneBindings, collisions []string) statusVerdict {
	return computeStatusVerdict(app, &servingv1.Service{}, databaseCheckState{}, revisionCheck{},
		imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{}, privateExposureState{},
		podCreationState{}, time.Now(), withBackendBindings(b, collisions))
}

func verdictConditionOrNil(v statusVerdict, condType string) *metav1.Condition {
	return apimeta.FindStatusCondition(v.conditions, condType)
}

func zoneWithBackends(entries ...appsv1alpha1.BackendBinding) *appsv1alpha1.NextApp {
	app := &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: "shop", Generation: 3}}
	app.Spec.Backends = entries
	return app
}

func TestBackendBindingsConditionAllBound(t *testing.T) {
	app := zoneWithBackends(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
	v := bindingVerdict(app, zoneBindings{entries: []zoneBinding{{name: "pricing", service: "pricing", state: bindingBound}}}, nil)
	c := verdictConditionOrNil(v, ConditionBackendBindings)
	if c == nil || c.Status != metav1.ConditionTrue || c.Reason != ReasonBackendsBound {
		t.Fatalf("want BackendBindings True/%s, got %+v", ReasonBackendsBound, c)
	}
	// Informational: Ready is NOT gated on bindings.
	if r := verdictConditionOrNil(v, ConditionReady); r != nil && r.Reason == ReasonBackendsBound {
		t.Fatalf("binding state leaked into Ready: %+v", r)
	}
}

func TestBackendBindingsConditionReportsEveryFailure(t *testing.T) {
	app := zoneWithBackends(
		appsv1alpha1.BackendBinding{Name: "ghost", Service: "ghost"},
		appsv1alpha1.BackendBinding{Name: "stolen", Service: "billing-fn"},
		appsv1alpha1.BackendBinding{Name: "orders", Service: "orders-fn"},
	)
	b := zoneBindings{entries: []zoneBinding{
		{name: "ghost", service: "ghost", state: bindingFunctionNotFound},
		{name: "orders", service: "orders-fn", state: bindingBound},
		{name: "stolen", service: "billing-fn", state: bindingCrossZone, functionZone: "billing"},
	}}
	v := bindingVerdict(app, b, []string{"ORDERS_SERVICE_URL"})
	c := verdictConditionOrNil(v, ConditionBackendBindings)
	if c == nil || c.Status != metav1.ConditionFalse {
		t.Fatalf("want BackendBindings False, got %+v", c)
	}
	// Cross-zone is the most serious and names the reason.
	if c.Reason != ReasonCrossZoneBinding {
		t.Errorf("reason = %s, want %s", c.Reason, ReasonCrossZoneBinding)
	}
	for _, want := range []string{`"stolen"`, `zone "billing"`, `"ghost"`, "ORDERS_SERVICE_URL"} {
		if !strings.Contains(c.Message, want) {
			t.Errorf("message %q does not name %s", c.Message, want)
		}
	}
	if len(v.events) == 0 || v.events[len(v.events)-1].reason != ReasonCrossZoneBinding {
		t.Errorf("a Warning event must fire on the transition into a failed binding: %+v", v.events)
	}
}

func TestBackendBindingsConditionCollisionAlone(t *testing.T) {
	app := zoneWithBackends(appsv1alpha1.BackendBinding{Name: "orders", Service: "orders-fn"})
	v := bindingVerdict(app, zoneBindings{entries: []zoneBinding{{name: "orders", service: "orders-fn", state: bindingBound}}},
		[]string{"ORDERS_SERVICE_URL"})
	c := verdictConditionOrNil(v, ConditionBackendBindings)
	if c == nil || c.Status != metav1.ConditionFalse || c.Reason != ReasonBindingEnvCollision ||
		!strings.Contains(c.Message, "ORDERS_SERVICE_URL") {
		t.Fatalf("a collision must fail the binding and name the variable, got %+v", c)
	}
}

func TestBackendBindingsConditionCRDMissing(t *testing.T) {
	app := zoneWithBackends(appsv1alpha1.BackendBinding{Name: "orders", Service: "orders-fn"})
	v := bindingVerdict(app, zoneBindings{crdMissing: true}, nil)
	c := verdictConditionOrNil(v, ConditionBackendBindings)
	if c == nil || c.Status != metav1.ConditionFalse || c.Reason != ReasonBackendServiceCRDMissing {
		t.Fatalf("want BackendBindings False/%s, got %+v", ReasonBackendServiceCRDMissing, c)
	}
}

// A zone with no spec.backends gets no condition at all (status byte-identical
// to before the field existed), and a previously-reported one is removed.
func TestBackendBindingsConditionAbsentWithoutBackends(t *testing.T) {
	app := zoneWithBackends()
	v := bindingVerdict(app, zoneBindings{}, nil)
	if c := verdictConditionOrNil(v, ConditionBackendBindings); c != nil {
		t.Fatalf("no spec.backends must render no BackendBindings condition, got %+v", c)
	}
	for _, r := range v.removeConditions {
		if r == ConditionBackendBindings {
			t.Fatalf("nothing to remove when the condition was never set")
		}
	}
	app.Status.Conditions = []metav1.Condition{{Type: ConditionBackendBindings, Status: metav1.ConditionTrue, Reason: ReasonBackendsBound}}
	v = bindingVerdict(app, zoneBindings{}, nil)
	removed := false
	for _, r := range v.removeConditions {
		removed = removed || r == ConditionBackendBindings
	}
	if !removed {
		t.Fatalf("a stale BackendBindings condition must be removed once spec.backends is empty")
	}
}
