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

	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

const kafkaTestImage = "registry.example.com/app:v1@sha256:abc123def456"

// #475 — spec.revalidation.provisionKafkaSource must NEVER be a validation error,
// on ANY value. The capability it enabled is withdrawn (the `{app}-revalidator`
// sink contract was never specified or tested), but the instrument for that is
// INERTNESS + an honest status condition, not rejection. Two independent reasons,
// and this test is the regression guard for both:
//
//  1. ADR-0017 §2.1: within `v1alpha1`, NextApp schema changes are additive-only.
//     Rejecting a value that previously validated narrows the schema IN PLACE —
//     observably identical to adding a CEL `self != true` rule — and would require
//     a new API version. ADR-0017 separately PERMITS a semantic change (a field for
//     an unshipped capability becoming inert), announced in release notes and
//     surfaced as a status condition. That is the route taken.
//
//  2. This function is shared with the FAIL-CLOSED reconciler, so a rejection here
//     is not merely an admission gate: a stored CR carrying the flag stops being
//     reconciled ENTIRELY — no database binding, no ksvc, no NetworkPolicy, no
//     warm-floor — and errors forever. That wedge fires on operator upgrade with NO
//     user action at all, which is strictly worse than the case
//     ValidateNextAppSpecUpdate's own doc comment already refuses ("otherwise
//     upgrading the operator would brick running apps on their next unrelated
//     update").
//
// The inert behaviour itself lives in the verdict, not here:
// controller.revalidationDeferred + computeStatusVerdict.
func TestProvisionKafkaSourceIsNeverAValidationError(t *testing.T) {
	tests := []struct {
		name         string
		revalidation *appsv1alpha1.RevalidationSpec
	}{
		{
			name: "true with queue=kafka (the withdrawn opt-in) still validates",
			revalidation: &appsv1alpha1.RevalidationSpec{
				Queue:                "kafka",
				ProvisionKafkaSource: ptr.To(true),
				KafkaBrokerUrl:       "kafka.default.svc:9092",
			},
		},
		{
			name: "true without a queue still validates",
			revalidation: &appsv1alpha1.RevalidationSpec{
				ProvisionKafkaSource: ptr.To(true),
			},
		},
		{
			name: "false validates",
			revalidation: &appsv1alpha1.RevalidationSpec{
				Queue:                "kafka",
				ProvisionKafkaSource: ptr.To(false),
			},
		},
		{
			name:         "unset validates",
			revalidation: &appsv1alpha1.RevalidationSpec{Queue: "kafka"},
		},
		{
			name:         "absent revalidation block validates",
			revalidation: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			spec := &appsv1alpha1.NextAppSpec{
				Image:        kafkaTestImage,
				Revalidation: tc.revalidation,
			}
			if err := ValidateNextAppSpec(spec); err != nil {
				t.Fatalf("ValidateNextAppSpec() = %v; want nil — rejecting narrows v1alpha1 "+
					"in place (ADR-0017 §2.1) and wedges stored CRs on the fail-closed reconciler", err)
			}
		})
	}
}

// Both admission entry points must accept it too, on CREATE and on UPDATE —
// including the case that matters most: an UPDATE carrying the flag forward on a
// CR stored before the capability was withdrawn.
func TestProvisionKafkaSourceAcceptedOnBothAdmissionEntryPoints(t *testing.T) {
	stored := &appsv1alpha1.NextAppSpec{
		Image: kafkaTestImage,
		Revalidation: &appsv1alpha1.RevalidationSpec{
			Queue:                "kafka",
			ProvisionKafkaSource: ptr.To(true),
		},
	}
	if err := ValidateNextAppSpecCreate(stored); err != nil {
		t.Errorf("ValidateNextAppSpecCreate() = %v; want nil", err)
	}

	// An unrelated image bump on a stored CR that carries the flag must succeed:
	// this is the exact "brick on the next unrelated update" case.
	bumped := stored.DeepCopy()
	bumped.Image = "registry.example.com/app:v2@sha256:def456abc123"
	if err := ValidateNextAppSpecUpdate(stored, bumped); err != nil {
		t.Errorf("ValidateNextAppSpecUpdate() image bump = %v; want nil", err)
	}
}
