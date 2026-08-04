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
	"strings"
	"testing"

	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

const kafkaTestImage = "registry.example.com/app:v1@sha256:abc123def456"

// #475: spec.revalidation.provisionKafkaSource=true is accepted-config-for-an-
// unbuilt-feature — the sink the KafkaSource would target (the
// `{app}-revalidator` Knative Service) is not built (ADR-0016 action item still
// open). Setting it can only ever produce a dangling source, so it is rejected
// at admission with an explicit "not implemented" message until the consumer
// ships. The FIELD stays in the API so building the consumer later is
// non-breaking.
func TestProvisionKafkaSourceRejectedAsNotImplemented(t *testing.T) {
	tests := []struct {
		name         string
		revalidation *appsv1alpha1.RevalidationSpec
		wantErr      bool
	}{
		{
			name: "provisionKafkaSource=true with queue=kafka is rejected",
			revalidation: &appsv1alpha1.RevalidationSpec{
				Queue:                "kafka",
				ProvisionKafkaSource: ptr.To(true),
				KafkaBrokerUrl:       "kafka.default.svc:9092",
			},
			wantErr: true,
		},
		{
			name: "provisionKafkaSource=true without a queue is rejected too",
			revalidation: &appsv1alpha1.RevalidationSpec{
				ProvisionKafkaSource: ptr.To(true),
			},
			wantErr: true,
		},
		{
			name: "provisionKafkaSource=false is accepted",
			revalidation: &appsv1alpha1.RevalidationSpec{
				Queue:                "kafka",
				ProvisionKafkaSource: ptr.To(false),
			},
			wantErr: false,
		},
		{
			name: "provisionKafkaSource unset with queue=kafka is accepted (the honest-deferred path)",
			revalidation: &appsv1alpha1.RevalidationSpec{
				Queue: "kafka",
			},
			wantErr: false,
		},
		{
			name:         "no revalidation block at all is accepted",
			revalidation: nil,
			wantErr:      false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			spec := &appsv1alpha1.NextAppSpec{
				Image:        kafkaTestImage,
				Revalidation: tc.revalidation,
			}
			err := ValidateNextAppSpec(spec)
			if tc.wantErr != (err != nil) {
				t.Fatalf("ValidateNextAppSpec() err=%v, wantErr=%v", err, tc.wantErr)
			}
			if !tc.wantErr {
				return
			}
			msg := err.Error()
			if !strings.Contains(msg, "provisionKafkaSource") {
				t.Errorf("error must name the offending field, got %q", msg)
			}
			if !strings.Contains(msg, "not implemented") {
				t.Errorf("error must say the feature is not implemented, got %q", msg)
			}
			if !strings.Contains(msg, "revalidator") {
				t.Errorf("error must name the unbuilt {app}-revalidator consumer, got %q", msg)
			}
		})
	}
}

// The gate must be UNRATCHETED on update as well: an UPDATE that carries a
// pre-existing provisionKafkaSource=true forward is still rejected, because the
// point of the gate is that the operator must never act on it. Both admission
// entry points therefore reject it (they both delegate to ValidateNextAppSpec).
func TestProvisionKafkaSourceRejectedOnBothAdmissionEntryPoints(t *testing.T) {
	bad := &appsv1alpha1.NextAppSpec{
		Image: kafkaTestImage,
		Revalidation: &appsv1alpha1.RevalidationSpec{
			Queue:                "kafka",
			ProvisionKafkaSource: ptr.To(true),
		},
	}
	if err := ValidateNextAppSpecCreate(bad); err == nil {
		t.Errorf("ValidateNextAppSpecCreate() = nil; want a not-implemented rejection")
	}
	if err := ValidateNextAppSpecUpdate(bad, bad); err == nil {
		t.Errorf("ValidateNextAppSpecUpdate() carrying the flag forward = nil; want a not-implemented rejection")
	}
}
