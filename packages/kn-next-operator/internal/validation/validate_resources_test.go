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

	"k8s.io/apimachinery/pkg/api/resource"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #435 — spec.resources.{cpuRequest,memoryRequest,cpuLimit,memoryLimit} are
// user-supplied free text the reconciler turns into Kubernetes quantities for
// the Knative container's resource requests/limits. Before this check the
// reconcile site called resource.MustParse on all four, so a malformed value
// ("500", "1GB", "0.5 CPU") PANICKED the SHARED reconcile loop — a cluster-wide
// outage, since every NextApp then stops reconciling until the bad CR is
// removed. These specs pin the durable contract: a bad quantity is a VALIDATION
// ERROR (status condition / admission rejection), never a panic.
func resourcesSpec(r *appsv1alpha1.ResourcesSpec) *appsv1alpha1.NextAppSpec {
	return &appsv1alpha1.NextAppSpec{
		Image:     digestImage,
		Resources: r,
	}
}

func TestValidateNextAppSpecResourceQuantities(t *testing.T) {
	tests := []struct {
		name    string
		res     *appsv1alpha1.ResourcesSpec
		wantErr bool
		field   string // substring that must appear in the error
	}{
		// All unset → operator defaults, no error.
		{"nil resources", nil, false, ""},
		{"empty resources", &appsv1alpha1.ResourcesSpec{}, false, ""},
		// Valid quantities.
		{"valid cpu millis", &appsv1alpha1.ResourcesSpec{CPURequest: "250m", CPULimit: "1000m"}, false, ""},
		{"valid cpu cores", &appsv1alpha1.ResourcesSpec{CPURequest: "1", CPULimit: "2"}, false, ""},
		{"valid memory binary", &appsv1alpha1.ResourcesSpec{MemoryRequest: "512Mi", MemoryLimit: "1Gi"}, false, ""},
		{"valid memory decimal", &appsv1alpha1.ResourcesSpec{MemoryRequest: "500M", MemoryLimit: "1G"}, false, ""},
		// The natural-looking panic cases.
		{"cpu 0.5 CPU rejected", &appsv1alpha1.ResourcesSpec{CPURequest: "0.5 CPU"}, true, "spec.resources.cpuRequest"},
		{"memory 1GB rejected", &appsv1alpha1.ResourcesSpec{MemoryRequest: "1GB"}, true, "spec.resources.memoryRequest"},
		{"cpu limit garbage", &appsv1alpha1.ResourcesSpec{CPULimit: "abc"}, true, "spec.resources.cpuLimit"},
		{"memory limit MB not a suffix", &appsv1alpha1.ResourcesSpec{MemoryLimit: "12MB"}, true, "spec.resources.memoryLimit"},
		{"embedded space", &appsv1alpha1.ResourcesSpec{CPURequest: "512 m"}, true, "spec.resources.cpuRequest"},
		// Zero / negative are rejected per field.
		{"cpu request zero", &appsv1alpha1.ResourcesSpec{CPURequest: "0"}, true, "spec.resources.cpuRequest"},
		{"memory request negative", &appsv1alpha1.ResourcesSpec{MemoryRequest: "-1Gi"}, true, "spec.resources.memoryRequest"},
		{"cpu limit zero", &appsv1alpha1.ResourcesSpec{CPULimit: "0"}, true, "spec.resources.cpuLimit"},
		{"memory limit negative", &appsv1alpha1.ResourcesSpec{MemoryLimit: "-5Mi"}, true, "spec.resources.memoryLimit"},
		// Semantic: request > limit (only enforced when BOTH are explicitly set).
		{"cpu request over limit", &appsv1alpha1.ResourcesSpec{CPURequest: "2", CPULimit: "1"}, true, "spec.resources.cpuRequest"},
		{"memory request over limit", &appsv1alpha1.ResourcesSpec{MemoryRequest: "2Gi", MemoryLimit: "1Gi"}, true, "spec.resources.memoryRequest"},
		{"cpu request equals limit ok", &appsv1alpha1.ResourcesSpec{CPURequest: "1", CPULimit: "1"}, false, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateNextAppSpec(resourcesSpec(tc.res))
			if tc.wantErr != (err != nil) {
				t.Fatalf("ValidateNextAppSpec(resources=%+v) err=%v, wantErr=%v", tc.res, err, tc.wantErr)
			}
			if tc.wantErr && !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("error %q does not name the offending field %q", err, tc.field)
			}
		})
	}
}

// Guards the reconcile-site contract directly: whatever ValidateNextAppSpec
// accepts must be parseable without panicking, so the container-sizing path can
// never blow up the shared controller on admitted input.
func TestAcceptedResourceQuantitiesNeverPanicOnParse(t *testing.T) {
	accepted := []*appsv1alpha1.ResourcesSpec{
		{CPURequest: "250m", MemoryRequest: "512Mi", CPULimit: "1000m", MemoryLimit: "1Gi"},
		{CPURequest: "1", CPULimit: "2"},
		{MemoryRequest: "500M", MemoryLimit: "1G"},
	}
	for _, r := range accepted {
		if err := ValidateNextAppSpec(resourcesSpec(r)); err != nil {
			t.Fatalf("resources %+v should be accepted, got %v", r, err)
		}
		for _, v := range []string{r.CPURequest, r.MemoryRequest, r.CPULimit, r.MemoryLimit} {
			if v == "" {
				continue
			}
			func(val string) {
				defer func() {
					if rec := recover(); rec != nil {
						t.Fatalf("parsing accepted quantity %q panicked: %v", val, rec)
					}
				}()
				_ = resource.MustParse(val)
			}(v)
		}
	}
}
