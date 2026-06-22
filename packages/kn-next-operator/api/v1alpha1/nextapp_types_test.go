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

package v1alpha1

import (
	"encoding/json"
	"testing"
)

// TestNextAppSpec_FieldMap verifies that every field the CLI previously templated
// has a corresponding field in NextAppSpec so the operator can be the single
// source of truth for cluster state (ADR-0001).
//
// Field-map (CLI config → NextAppSpec):
//   - KnativeNextConfig.scaling.minScale         → Spec.Scaling.MinScale
//   - KnativeNextConfig.scaling.maxScale         → Spec.Scaling.MaxScale
//   - KnativeNextConfig.scaling.cpuRequest       → Spec.Resources.CPURequest
//   - KnativeNextConfig.scaling.memoryRequest    → Spec.Resources.MemoryRequest
//   - KnativeNextConfig.scaling.cpuLimit         → Spec.Resources.CPULimit
//   - KnativeNextConfig.scaling.memoryLimit      → Spec.Resources.MemoryLimit
//   - KnativeNextConfig.storage.provider         → Spec.Storage.Provider
//   - KnativeNextConfig.storage.bucket           → Spec.Storage.Bucket
//   - KnativeNextConfig.storage.region           → Spec.Storage.Region (NEW)
//   - KnativeNextConfig.storage.endpoint         → Spec.Storage.Endpoint (NEW)
//   - KnativeNextConfig.cache.provider           → Spec.Cache.Provider
//   - KnativeNextConfig.cache.url                → Spec.Cache.URL
//   - KnativeNextConfig.cache.keyPrefix          → Spec.Cache.KeyPrefix (NEW)
//   - KnativeNextConfig.healthCheckPath          → Spec.HealthCheckPath
//   - KnativeNextConfig.secrets.envFrom          → Spec.Secrets.EnvFrom
//   - KnativeNextConfig.secrets.envMap           → Spec.Secrets.EnvMap
//   - KnativeNextConfig.observability.enabled    → Spec.Observability.Enabled
//   - KnativeNextConfig.runtime                  → Spec.Runtime (NEW)
//   - knative-manifest containerConcurrency=100  → Spec.Scaling.ContainerConcurrency (already in ScalingSpec)
//   - knative-manifest timeoutSeconds=300        → Spec.TimeoutSeconds (NEW)
func TestNextAppSpec_FieldMap(t *testing.T) {
	// Round-trip test: marshal and unmarshal a NextApp with all fields set
	// to verify JSON tags are correct and all fields are accessible.
	app := NextApp{
		Spec: NextAppSpec{
			Image: "registry.example.com/app@sha256:abc123",
			Scaling: &ScalingSpec{
				MinScale:             0,
				MaxScale:             10,
				ContainerConcurrency: 100,
			},
			Resources: &ResourcesSpec{
				CPURequest:    "250m",
				MemoryRequest: "512Mi",
				CPULimit:      "1000m",
				MemoryLimit:   "1Gi",
			},
			Storage: &StorageSpec{
				Provider: "s3",
				Bucket:   "my-bucket",
				Region:   "us-east-1",
				Endpoint: "https://s3.example.com",
			},
			Cache: &CacheSpec{
				Provider:            "redis",
				URL:                 "redis://redis:6379",
				KeyPrefix:           "myapp",
				EnableBytecodeCache: true,
				BytecodeCacheSize:   "512Mi",
			},
			HealthCheckPath: "/api/health",
			Secrets: &SecretsSpec{
				EnvFrom: []string{"my-secret"},
				EnvMap: map[string]EnvMapEntry{
					"DB_URL": {SecretName: "db-secret", SecretKey: "url"},
				},
			},
			Observability:  &ObservabilitySpec{Enabled: true},
			Runtime:        "bun",
			TimeoutSeconds: 300,
		},
	}

	data, err := json.Marshal(app)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var back NextApp
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	// Verify new fields round-trip correctly
	tests := []struct {
		name string
		got  any
		want any
	}{
		{"Storage.Region", back.Spec.Storage.Region, "us-east-1"},
		{"Storage.Endpoint", back.Spec.Storage.Endpoint, "https://s3.example.com"},
		{"Cache.KeyPrefix", back.Spec.Cache.KeyPrefix, "myapp"},
		{"Runtime", back.Spec.Runtime, "bun"},
		{"TimeoutSeconds", back.Spec.TimeoutSeconds, int32(300)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Errorf("field %s: got %v, want %v", tc.name, tc.got, tc.want)
			}
		})
	}
}

// TestObservabilitySpec_Rum verifies the RUM (#94) sub-spec round-trips so the
// operator can propagate NEXT_PUBLIC_RUM_ENABLED / NEXT_PUBLIC_RUM_SAMPLE_RATE.
func TestObservabilitySpec_Rum(t *testing.T) {
	app := NextApp{
		Spec: NextAppSpec{
			Image: "registry.example.com/app@sha256:abc123",
			Observability: &ObservabilitySpec{
				Enabled: true,
				Rum:     &RumSpec{Enabled: true, SampleRate: "0.5"},
			},
		},
	}

	data, err := json.Marshal(app)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var back NextApp
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if back.Spec.Observability.Rum == nil {
		t.Fatal("Observability.Rum round-tripped to nil")
	}
	if !back.Spec.Observability.Rum.Enabled {
		t.Error("Rum.Enabled: got false, want true")
	}
	if got := back.Spec.Observability.Rum.SampleRate; got != "0.5" {
		t.Errorf("Rum.SampleRate: got %q, want %q", got, "0.5")
	}

	// Default-off: a NextApp with no Rum block must not synthesize one.
	off := NextApp{Spec: NextAppSpec{Observability: &ObservabilitySpec{Enabled: true}}}
	d2, _ := json.Marshal(off)
	var back2 NextApp
	if err := json.Unmarshal(d2, &back2); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if back2.Spec.Observability.Rum != nil {
		t.Error("Rum should be nil when not configured (default off)")
	}
}
