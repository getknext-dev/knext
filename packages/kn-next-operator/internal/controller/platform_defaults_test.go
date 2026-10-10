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
	"reflect"
	"testing"

	"k8s.io/utils/ptr"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/defaults"
)

// ADR-0064 D2: effective(field) = app > platform > built-in, merged per field.
// resolveEffective is the pure seam; these tests pin the precedence for every
// platform-defaultable field, which is the contract the envtests then prove
// end to end.

func bareApp() *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{Spec: appsv1alpha1.NextAppSpec{Image: "r/a:v1@sha256:abc"}}
}

func platformSpec(mut func(*platformv1alpha1.KnextPlatformSpec)) *platformv1alpha1.KnextPlatformSpec {
	s := &platformv1alpha1.KnextPlatformSpec{}
	mut(s)
	return s
}

func TestResolveEffective_NoPlatformIsTheBuiltinTable(t *testing.T) {
	eff := resolveEffective(bareApp(), nil)

	if eff.containerConcurrency != defaults.ContainerConcurrency {
		t.Errorf("containerConcurrency = %d, want built-in %d", eff.containerConcurrency, defaults.ContainerConcurrency)
	}
	for _, c := range []struct {
		name string
		got  effectiveString
		want string
	}{
		{"cpuRequest", eff.cpuRequest, defaults.CPURequest},
		{"cpuLimit", eff.cpuLimit, defaults.CPULimit},
		{"memoryRequest", eff.memoryRequest, defaults.MemoryRequest},
		{"memoryLimit", eff.memoryLimit, defaults.MemoryLimit},
	} {
		if c.got.value != c.want || c.got.src != sourceBuiltin {
			t.Errorf("%s = %+v, want built-in %q", c.name, c.got, c.want)
		}
	}
	if eff.timeoutSeconds != defaults.TimeoutSeconds {
		t.Errorf("timeoutSeconds = %d, want %d", eff.timeoutSeconds, defaults.TimeoutSeconds)
	}
	if eff.connectionBudget != defaults.ConnectionBudget {
		t.Errorf("connectionBudget = %d, want %d", eff.connectionBudget, defaults.ConnectionBudget)
	}
	if eff.scaleDownDelay != "" || eff.targetBurstCapacity != nil ||
		eff.panicWindowPercentage != nil || eff.panicThresholdPercentage != nil {
		t.Errorf("annotation knobs must stay unset with no platform: %+v", eff)
	}
	if len(eff.inherited) != 0 {
		t.Errorf("nothing can be inherited with no platform, got %v", eff.inherited)
	}
}

// An empty platform and the 'default' profile must resolve exactly like no
// platform at all (ADR-0064 D3). fastColdStart sets no value in this release.
func TestResolveEffective_EmptyDefaultAndFastColdStartProfilesChangeNothing(t *testing.T) {
	want := resolveEffective(bareApp(), nil)
	for name, spec := range map[string]*platformv1alpha1.KnextPlatformSpec{
		"spec: {}":                 {},
		"profile: default":         {Profile: platformv1alpha1.ProfileDefault},
		"profile: fastColdStart":   {Profile: platformv1alpha1.ProfileFastColdStart},
		"empty nested blocks only": {Scaling: &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{}}, Resources: &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{}}},
	} {
		if got := resolveEffective(bareApp(), spec); !reflect.DeepEqual(got, want) {
			t.Errorf("%s resolved differently from no platform:\n got %+v\nwant %+v", name, got, want)
		}
	}
}

func TestResolveEffective_PlatformFillsWhatTheAppLeavesUnset(t *testing.T) {
	spec := platformSpec(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Scaling = &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{
			ContainerConcurrency:     40,
			ScaleDownDelay:           "5m",
			TargetBurstCapacity:      ptr.To[int32](-1),
			PanicWindowPercentage:    ptr.To[int32](20),
			PanicThresholdPercentage: ptr.To[int32](300),
		}}
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{
			CPURequest: "500m", CPULimit: "2", MemoryRequest: "1Gi", MemoryLimit: "2Gi",
		}}
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}
		s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 160}
	})
	eff := resolveEffective(bareApp(), spec)

	if eff.containerConcurrency != 40 {
		t.Errorf("containerConcurrency = %d, want platform 40", eff.containerConcurrency)
	}
	for name, got := range map[string]effectiveString{
		"cpuRequest": eff.cpuRequest, "cpuLimit": eff.cpuLimit,
		"memoryRequest": eff.memoryRequest, "memoryLimit": eff.memoryLimit,
	} {
		if got.src != sourcePlatform {
			t.Errorf("%s source = %v, want platform", name, got.src)
		}
	}
	if eff.cpuLimit.value != "2" || eff.memoryRequest.value != "1Gi" {
		t.Errorf("platform quantities not carried: %+v %+v", eff.cpuLimit, eff.memoryRequest)
	}
	if eff.timeoutSeconds != 600 || eff.connectionBudget != 160 {
		t.Errorf("timeout/budget = %d/%d, want 600/160", eff.timeoutSeconds, eff.connectionBudget)
	}
	if eff.scaleDownDelay != "5m" || *eff.targetBurstCapacity != -1 ||
		*eff.panicWindowPercentage != 20 || *eff.panicThresholdPercentage != 300 {
		t.Errorf("annotation knobs not carried: %+v", eff)
	}

	wantInherited := []string{
		"spec.resources.cpuLimit", "spec.resources.cpuRequest",
		"spec.resources.memoryLimit", "spec.resources.memoryRequest",
		"spec.scaling.containerConcurrency", "spec.scaling.panicThresholdPercentage",
		"spec.scaling.panicWindowPercentage", "spec.scaling.scaleDownDelay",
		"spec.scaling.targetBurstCapacity", "spec.timeoutSeconds",
	}
	if !reflect.DeepEqual(eff.inherited, wantInherited) {
		t.Errorf("inherited = %v\nwant       %v", eff.inherited, wantInherited)
	}
}

// App-set always wins, field by field. The app that sets cpuLimit still
// inherits the platform's memoryLimit — resources are NOT an all-or-nothing block.
func TestResolveEffective_AppWinsPerFieldAndMixesWithPlatform(t *testing.T) {
	app := bareApp()
	app.Spec.Resources = &appsv1alpha1.ResourcesSpec{CPULimit: "4"}
	app.Spec.Scaling = &appsv1alpha1.ScalingSpec{
		ContainerConcurrency: 100,
		TargetBurstCapacity:  ptr.To[int32](0), // explicit zero is a value, not "unset"
	}
	app.Spec.TimeoutSeconds = 90

	spec := platformSpec(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Scaling = &platformv1alpha1.PlatformScaling{Defaults: &platformv1alpha1.PlatformScalingDefaults{
			ContainerConcurrency: 40, TargetBurstCapacity: ptr.To[int32](500), ScaleDownDelay: "5m",
		}}
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{
			CPULimit: "2", MemoryLimit: "2Gi",
		}}
		s.Limits = &platformv1alpha1.PlatformLimits{TimeoutSeconds: 600}
	})
	eff := resolveEffective(app, spec)

	if eff.containerConcurrency != 100 {
		t.Errorf("containerConcurrency = %d, want the app's 100", eff.containerConcurrency)
	}
	if eff.cpuLimit.value != "4" || eff.cpuLimit.src != sourceApp {
		t.Errorf("cpuLimit = %+v, want the app's 4", eff.cpuLimit)
	}
	if eff.memoryLimit.value != "2Gi" || eff.memoryLimit.src != sourcePlatform {
		t.Errorf("memoryLimit = %+v, want the platform's 2Gi", eff.memoryLimit)
	}
	if eff.cpuRequest.src != sourceBuiltin || eff.memoryRequest.src != sourceBuiltin {
		t.Errorf("requests nobody set must stay built-in: %+v %+v", eff.cpuRequest, eff.memoryRequest)
	}
	if eff.timeoutSeconds != 90 {
		t.Errorf("timeoutSeconds = %d, want the app's 90", eff.timeoutSeconds)
	}
	if eff.targetBurstCapacity == nil || *eff.targetBurstCapacity != 0 {
		t.Errorf("targetBurstCapacity = %v, want the app's explicit 0 (it must beat the platform's 500)", eff.targetBurstCapacity)
	}
	if eff.scaleDownDelay != "5m" {
		t.Errorf("scaleDownDelay = %q, want the platform's 5m (the app left it unset)", eff.scaleDownDelay)
	}

	wantInherited := []string{"spec.resources.memoryLimit", "spec.scaling.scaleDownDelay"}
	if !reflect.DeepEqual(eff.inherited, wantInherited) {
		t.Errorf("inherited = %v, want %v (only what the platform actually supplied)", eff.inherited, wantInherited)
	}
}

// The platform's connectionBudget governs the app's wall; an app never sets it.
func TestResolveEffective_ConnectionBudgetComesFromPlatformOrBuiltin(t *testing.T) {
	if got := resolveEffective(bareApp(), platformSpec(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 40}
	})).connectionBudget; got != 40 {
		t.Errorf("connectionBudget = %d, want 40", got)
	}
	if got := resolveEffective(bareApp(), platformSpec(func(*platformv1alpha1.KnextPlatformSpec) {})).connectionBudget; got != defaults.ConnectionBudget {
		t.Errorf("connectionBudget = %d, want built-in %d", got, defaults.ConnectionBudget)
	}
}

func TestPlatformSpecHash_StableAndSensitive(t *testing.T) {
	a := platformSpec(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "2"}}
	})
	b := a.DeepCopy()
	if platformSpecHash(a) != platformSpecHash(b) {
		t.Error("equal specs must hash equally")
	}
	b.Resources.Defaults.CPULimit = "3"
	if platformSpecHash(a) == platformSpecHash(b) {
		t.Error("a changed value must change the hash")
	}
	if platformSpecHash(&platformv1alpha1.KnextPlatformSpec{}) == "" {
		t.Error("an EMPTY present platform must still have a hash, or it is indistinguishable from no platform")
	}
}
