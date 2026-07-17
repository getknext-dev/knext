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

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #338 — readiness + liveness probes must be SHALLOW: they must NOT hit a path
// whose handler deep-checks a scale-to-zero DB, or readiness flaps on cold-wake.
// The operator wires probes to the shallow readiness path (/api/health), while
// deep DB/Redis reachability lives at a separate monitoring path.

func TestReadinessProbePathIsShallowDefault(t *testing.T) {
	na := &appsv1alpha1.NextApp{}
	got := readinessProbePath(na)
	if got != "/api/health" {
		t.Fatalf("expected shallow readiness path /api/health, got %q", got)
	}
}

func TestReadinessProbePathHonoursSpecOverride(t *testing.T) {
	na := &appsv1alpha1.NextApp{}
	na.Spec.HealthCheckPath = "/custom/ready"
	got := readinessProbePath(na)
	if got != "/custom/ready" {
		t.Fatalf("expected spec override /custom/ready, got %q", got)
	}
}

// The shallow readiness path must NOT be the deep-monitoring path — a regression
// that points probes back at the deep handler would collapse them together.
func TestReadinessProbePathIsNotDeepMonitoringPath(t *testing.T) {
	na := &appsv1alpha1.NextApp{}
	if readinessProbePath(na) == deepHealthPath(na) {
		t.Fatalf("readiness probe path must differ from the deep monitoring path")
	}
}
