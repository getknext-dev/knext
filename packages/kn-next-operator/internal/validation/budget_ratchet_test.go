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

package validation

import (
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

func wallSpec(image string, maxScale, poolMax int32) *appsv1alpha1.NextAppSpec {
	return &appsv1alpha1.NextAppSpec{
		Image:   image,
		Scaling: &appsv1alpha1.ScalingSpec{MaxScale: maxScale, PoolMax: poolMax},
	}
}

// The connection-budget rule is RATCHETED on UPDATE, like the collision rules
// (ADR-0019): an update is rejected only when it RAISES maxScale × poolMax above
// the budget. A platform that lowers its budget must not brick the apps that were
// valid when they were admitted.
func TestUpdateBudgetRatchet(t *testing.T) {
	const newImage = "registry.example.com/app:v2@sha256:def456abc123"
	const budget = 40

	tests := []struct {
		name    string
		old     *appsv1alpha1.NextAppSpec
		new     *appsv1alpha1.NextAppSpec
		wantErr bool
	}{
		{"image-only update on an over-budget app is admitted", wallSpec(digestImage, 10, 10), wallSpec(newImage, 10, 10), false},
		{"lowering an over-budget wall (still over) is admitted", wallSpec(digestImage, 10, 10), wallSpec(digestImage, 8, 10), false},
		{"raising an over-budget wall is rejected", wallSpec(digestImage, 10, 10), wallSpec(digestImage, 11, 10), true},
		{"raising poolMax on an over-budget app is rejected", wallSpec(digestImage, 10, 10), wallSpec(digestImage, 10, 11), true},
		{"raising a within-budget wall past the budget is rejected", wallSpec(digestImage, 4, 10), wallSpec(digestImage, 5, 10), true},
		{"raising a within-budget wall up to the budget is admitted", wallSpec(digestImage, 2, 10), wallSpec(digestImage, 4, 10), false},
		{"a nil old spec gets no grace", nil, wallSpec(digestImage, 10, 10), true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateNextAppSpecUpdateWithBudget(tc.old, tc.new, budget)
			if (err != nil) != tc.wantErr {
				t.Fatalf("wantErr=%v, got %v", tc.wantErr, err)
			}
		})
	}
}

// The ratchet is ONLY for the budget rule: every other rule still applies to an
// update of an over-budget app.
func TestUpdateBudgetRatchetDoesNotExcuseOtherRules(t *testing.T) {
	old := wallSpec(digestImage, 10, 10)
	bad := wallSpec("registry.example.com/app:latest", 10, 10)
	if err := ValidateNextAppSpecUpdateWithBudget(old, bad, 40); err == nil {
		t.Fatal("a :latest image must still be rejected on an over-budget app")
	}
}
