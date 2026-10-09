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

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
)

// ValidatePlatformSpec is the Go-side acceptance check for a KnextPlatform: the
// CRD's OpenAPI schema is the first line, but a platform applied with
// validation off (or a pattern the apiserver accepts and the bounded parser
// does not) must never reach the shared reconcile loop as a MustParse panic
// (#435) or as a quantity that hangs the parser (#635).

func resourcesOf(r platformv1alpha1.PlatformResourceDefaults) *platformv1alpha1.KnextPlatformSpec {
	return &platformv1alpha1.KnextPlatformSpec{
		Resources: &platformv1alpha1.PlatformResources{Defaults: &r},
	}
}

func TestValidatePlatformSpec_Accepts(t *testing.T) {
	for name, spec := range map[string]*platformv1alpha1.KnextPlatformSpec{
		"empty":               {},
		"default profile":     {Profile: platformv1alpha1.ProfileDefault},
		"fastColdStart":       {Profile: platformv1alpha1.ProfileFastColdStart},
		"resources":           resourcesOf(platformv1alpha1.PlatformResourceDefaults{CPURequest: "500m", CPULimit: "2", MemoryRequest: "1Gi", MemoryLimit: "2Gi"}),
		"equal request/limit": resourcesOf(platformv1alpha1.PlatformResourceDefaults{CPURequest: "1", CPULimit: "1000m"}),
		"scale-down-delay":    {Scaling: &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{ScaleDownDelay: "15m"}}},
		"burst -1 and 0":      {Scaling: &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{TargetBurstCapacity: ptr.To[int32](-1)}}},
		"timeout and budget":  {Limits: &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}, Database: &platformv1alpha1.PlatformDatabase{ConnectionBudget: 160}},
		"rollout cap":         {Rollout: &platformv1alpha1.PlatformRollout{MaxAppsPerMinute: 3}},
		"nil nested defaults": {Scaling: &platformv1alpha1.PlatformScaling{}, Resources: &platformv1alpha1.PlatformResources{}},
	} {
		if err := ValidatePlatformSpec(spec); err != nil {
			t.Errorf("%s: want accepted, got %v", name, err)
		}
	}
	if err := ValidatePlatformSpec(nil); err != nil {
		t.Errorf("a nil spec is the empty platform, got %v", err)
	}
}

func TestValidatePlatformSpec_RejectsAndNamesTheField(t *testing.T) {
	for _, c := range []struct {
		name string
		spec *platformv1alpha1.KnextPlatformSpec
		want string
	}{
		{"unknown profile", &platformv1alpha1.KnextPlatformSpec{Profile: "turbo"}, "spec.profile"},
		{"garbage quantity", resourcesOf(platformv1alpha1.PlatformResourceDefaults{CPULimit: "banana"}), "spec.resources.defaults.cpuLimit"},
		{"memory GB suffix", resourcesOf(platformv1alpha1.PlatformResourceDefaults{MemoryLimit: "1GB"}), "spec.resources.defaults.memoryLimit"},
		{"zero request", resourcesOf(platformv1alpha1.PlatformResourceDefaults{CPURequest: "0"}), "spec.resources.defaults.cpuRequest"},
		{"negative", resourcesOf(platformv1alpha1.PlatformResourceDefaults{MemoryRequest: "-1Gi"}), "spec.resources.defaults.memoryRequest"},
		// #635: a value the stock parser does not return from.
		{"unbounded exponent", resourcesOf(platformv1alpha1.PlatformResourceDefaults{CPURequest: "1e2147483648"}), "spec.resources.defaults.cpuRequest"},
		{"request above limit", resourcesOf(platformv1alpha1.PlatformResourceDefaults{CPURequest: "2", CPULimit: "1"}), "cpuRequest"},
		{"memory request above limit", resourcesOf(platformv1alpha1.PlatformResourceDefaults{MemoryRequest: "2Gi", MemoryLimit: "1Gi"}), "memoryRequest"},
		{"sub-second delay", &platformv1alpha1.KnextPlatformSpec{Scaling: &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{ScaleDownDelay: "42.5s"}}}, "spec.scaling.defaults.scaleDownDelay"},
		{"delay over an hour", &platformv1alpha1.KnextPlatformSpec{Scaling: &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{ScaleDownDelay: "2h"}}}, "spec.scaling.defaults.scaleDownDelay"},
		{"burst below -1", &platformv1alpha1.KnextPlatformSpec{Scaling: &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{TargetBurstCapacity: ptr.To[int32](-2)}}}, "targetBurstCapacity"},
		{"panic window 0", &platformv1alpha1.KnextPlatformSpec{Scaling: &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{PanicWindowPercentage: ptr.To[int32](0)}}}, "panicWindowPercentage"},
		{"panic threshold 100", &platformv1alpha1.KnextPlatformSpec{Scaling: &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{PanicThresholdPercentage: ptr.To[int32](100)}}}, "panicThresholdPercentage"},
		{"negative concurrency", &platformv1alpha1.KnextPlatformSpec{Scaling: &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{ContainerConcurrency: -1}}}, "containerConcurrency"},
		{"negative timeout", &platformv1alpha1.KnextPlatformSpec{Limits: &platformv1alpha1.PlatformLimits{TimeoutSeconds: -5}}, "timeoutSeconds"},
		{"negative budget", &platformv1alpha1.KnextPlatformSpec{Database: &platformv1alpha1.PlatformDatabase{ConnectionBudget: -1}}, "connectionBudget"},
		{"negative rollout", &platformv1alpha1.KnextPlatformSpec{Rollout: &platformv1alpha1.PlatformRollout{MaxAppsPerMinute: -1}}, "maxAppsPerMinute"},
	} {
		err := ValidatePlatformSpec(c.spec)
		if err == nil {
			t.Errorf("%s: want rejected, got nil", c.name)
			continue
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error %q should name %q", c.name, err, c.want)
		}
	}
}
