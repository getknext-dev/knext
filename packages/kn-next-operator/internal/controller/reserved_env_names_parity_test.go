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
	"sort"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// #1391 round 2 (defect 1): validation.ReservedOperatorEnvNames and
// buildKsvcEnv's own pre-envMap env set are two INDEPENDENT, hand-maintained
// copies of "which env names does the operator manage" in different
// packages — nothing in the compiler ties them together. A reviewer deleted
// a name from ReservedOperatorEnvNames and, separately, added a new
// operator-managed var only inside buildKsvcEnv; the full suite stayed
// green both times, because nothing compared the two sides. This file is
// that comparison.
//
// For every spec permutation below (each conditional independently on/off,
// plus the fully-off "minimal" and fully-on "maximal" shapes), it asserts
// validation.ReservedOperatorEnvNames(spec) is EXACTLY the set of env var
// NAMES buildKsvcEnv renders for that spec when spec.Secrets and spec.Env
// are both empty — i.e. no name is admission-reserved but NOT actually
// injected (a false rejection), and no name is actually injected but NOT
// admission-reserved (a silent-collision hole, the #1288 bug reopened).
func reservedEnvNamesParityApp(spec appsv1alpha1.NextAppSpec) *appsv1alpha1.NextApp {
	spec.Image = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	return &appsv1alpha1.NextApp{Spec: spec}
}

func renderedEnvNames(t *testing.T, app *appsv1alpha1.NextApp) map[string]struct{} {
	t.Helper()
	r := &NextAppReconciler{}
	env, _, report := r.buildKsvcEnv(app)
	if !report.empty() {
		t.Fatalf("fixture must not itself trigger a collision (spec.Secrets is nil): got %+v", report)
	}
	names := make(map[string]struct{}, len(env))
	for _, ev := range env {
		names[ev.Name] = struct{}{}
	}
	return names
}

func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func assertReservedNamesParity(t *testing.T, name string, spec appsv1alpha1.NextAppSpec) {
	t.Helper()
	app := reservedEnvNamesParityApp(spec)
	admissionSide := validation.ReservedOperatorEnvNames(&app.Spec)
	reconcileSide := renderedEnvNames(t, app)

	var admissionOnly, reconcileOnly []string
	for n := range admissionSide {
		if _, ok := reconcileSide[n]; !ok {
			admissionOnly = append(admissionOnly, n)
		}
	}
	for n := range reconcileSide {
		if _, ok := admissionSide[n]; !ok {
			reconcileOnly = append(reconcileOnly, n)
		}
	}
	sort.Strings(admissionOnly)
	sort.Strings(reconcileOnly)

	if len(admissionOnly) > 0 || len(reconcileOnly) > 0 {
		t.Fatalf(
			"%s: ReservedOperatorEnvNames and buildKsvcEnv's rendered env DRIFTED — "+
				"admission-only (would falsely reject an envMap entry that never actually "+
				"collides): %v; reconcile-only (would silently allow a NEW collision past "+
				"admission — the #1288 bug reopened): %v\nadmission side: %v\nreconcile side: %v",
			name, admissionOnly, reconcileOnly, sortedKeys(admissionSide), sortedKeys(reconcileSide),
		)
	}
}

func TestReservedEnvNamesParity(t *testing.T) {
	cases := []struct {
		name string
		spec appsv1alpha1.NextAppSpec
	}{
		{"minimal (every conditional off)", appsv1alpha1.NextAppSpec{}},
		{"poolMax set", appsv1alpha1.NextAppSpec{
			Scaling: &appsv1alpha1.ScalingSpec{PoolMax: 10},
		}},
		{"storage: provider+bucket only", appsv1alpha1.NextAppSpec{
			Storage: &appsv1alpha1.StorageSpec{Provider: "s3", Bucket: "b"},
		}},
		{"storage: + region", appsv1alpha1.NextAppSpec{
			Storage: &appsv1alpha1.StorageSpec{Provider: "s3", Bucket: "b", Region: "us-east-1"},
		}},
		{"storage: + endpoint", appsv1alpha1.NextAppSpec{
			Storage: &appsv1alpha1.StorageSpec{Provider: "minio", Bucket: "b", Endpoint: "http://minio:9000"},
		}},
		{"storage: + region + endpoint", appsv1alpha1.NextAppSpec{
			Storage: &appsv1alpha1.StorageSpec{Provider: "minio", Bucket: "b", Region: "us-east-1", Endpoint: "http://minio:9000"},
		}},
		{"cache: provider only", appsv1alpha1.NextAppSpec{
			Cache: &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://x"},
		}},
		{"cache: + keyPrefix", appsv1alpha1.NextAppSpec{
			Cache: &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://x", KeyPrefix: "app1"},
		}},
		{"revalidation: kafka queue", appsv1alpha1.NextAppSpec{
			Revalidation: &appsv1alpha1.RevalidationSpec{Queue: "kafka", KafkaBrokerUrl: "kafka:9092"},
		}},
		{"observability: enabled, nothing else", appsv1alpha1.NextAppSpec{
			Observability: &appsv1alpha1.ObservabilitySpec{Enabled: true},
		}},
		{"observability: rum enabled, no sampleRate", appsv1alpha1.NextAppSpec{
			Observability: &appsv1alpha1.ObservabilitySpec{
				Enabled: true,
				Rum:     &appsv1alpha1.RumSpec{Enabled: true},
			},
		}},
		{"observability: rum enabled + sampleRate", appsv1alpha1.NextAppSpec{
			Observability: &appsv1alpha1.ObservabilitySpec{
				Enabled: true,
				Rum:     &appsv1alpha1.RumSpec{Enabled: true, SampleRate: "0.5"},
			},
		}},
		{"observability: tracing enabled, no endpoint/sampleRate", appsv1alpha1.NextAppSpec{
			Observability: &appsv1alpha1.ObservabilitySpec{
				Enabled: true,
				Tracing: &appsv1alpha1.TracingSpec{Enabled: true},
			},
		}},
		{"observability: tracing enabled + endpoint", appsv1alpha1.NextAppSpec{
			Observability: &appsv1alpha1.ObservabilitySpec{
				Enabled: true,
				Tracing: &appsv1alpha1.TracingSpec{Enabled: true, Endpoint: "http://otel:4318"},
			},
		}},
		{"observability: tracing enabled + sampleRate", appsv1alpha1.NextAppSpec{
			Observability: &appsv1alpha1.ObservabilitySpec{
				Enabled: true,
				Tracing: &appsv1alpha1.TracingSpec{Enabled: true, SampleRate: "0.1"},
			},
		}},
		{"maximal (every conditional on)", appsv1alpha1.NextAppSpec{
			Scaling:      &appsv1alpha1.ScalingSpec{PoolMax: 10},
			Storage:      &appsv1alpha1.StorageSpec{Provider: "minio", Bucket: "b", Region: "us-east-1", Endpoint: "http://minio:9000"},
			Cache:        &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://x", KeyPrefix: "app1"},
			Revalidation: &appsv1alpha1.RevalidationSpec{Queue: "kafka", KafkaBrokerUrl: "kafka:9092"},
			Observability: &appsv1alpha1.ObservabilitySpec{
				Enabled: true,
				Rum:     &appsv1alpha1.RumSpec{Enabled: true, SampleRate: "0.5"},
				Tracing: &appsv1alpha1.TracingSpec{Enabled: true, Endpoint: "http://otel:4318", SampleRate: "0.1"},
			},
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assertReservedNamesParity(t, tc.name, tc.spec)
		})
	}
}
