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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/defaults"
)

// The platform merge (ADR-0064 D2). For every field a platform may default:
//
//	effective(field) = app.spec.field      if the app set it
//	                 = platform.spec.field if the platform set it
//	                 = built-in            otherwise
//
// "Set" is the wire's "set": every NextApp field here is a non-pointer
// omitempty one, so zero/empty IS unset — which matches how the operator has
// always treated them (containerConcurrency: 0 already meant "use the default").
// The pointer-typed knobs (targetBurstCapacity, panic*) are set when non-nil, so
// an app's explicit 0 beats a platform value.
//
// The merge happens at RENDER time and never writes NextApp.spec: GitOps diffs
// stay clean and a platform edit reaches every app without touching one.

// valueSource says which layer an effective value came from.
type valueSource int

const (
	sourceBuiltin valueSource = iota
	sourcePlatform
	sourceApp
)

// effectiveString is a resolved string field with its provenance. The source is
// kept (rather than just the winning string) because the renderer must parse an
// app-supplied quantity with the app's field name in the error, and because the
// effective-spec validation only blames the platform for values it supplied.
type effectiveString struct {
	value string
	src   valueSource
}

// effectiveValues is the merged result for one NextApp.
type effectiveValues struct {
	containerConcurrency int64

	cpuRequest    effectiveString
	memoryRequest effectiveString
	cpuLimit      effectiveString
	memoryLimit   effectiveString

	timeoutSeconds int64

	// The four annotation knobs stay unset unless the app or the platform sets
	// them: unset means no annotation is stamped and the Knative cluster default
	// applies unmanaged, exactly as before the platform layer existed.
	scaleDownDelay           string
	targetBurstCapacity      *int32
	panicWindowPercentage    *int32
	panicThresholdPercentage *int32

	// connectionBudget is the cap maxScale x poolMax is checked against.
	connectionBudget int

	// inherited lists, sorted, the NextApp spec fields whose effective value was
	// supplied by the platform. Fields that fell back to the built-in are not
	// listed — "inherited from the platform" must mean exactly that.
	inherited []string
}

// resolveEffective merges the app over the platform over the built-ins.
// plat == nil means "no platform in force" (absent, CRD missing, or not
// accepted) and yields the built-in table unchanged.
func resolveEffective(app *appsv1alpha1.NextApp, plat *platformv1alpha1.KnextPlatformSpec) effectiveValues {
	var (
		scalingDefaults  platformv1alpha1.PlatformScalingDefaults
		resourceDefaults platformv1alpha1.PlatformResourceDefaults
		timeout          int32
		budget           int32
	)
	if plat != nil {
		if plat.Scaling != nil && plat.Scaling.Defaults != nil {
			scalingDefaults = *plat.Scaling.Defaults
		}
		if plat.Resources != nil && plat.Resources.Defaults != nil {
			resourceDefaults = *plat.Resources.Defaults
		}
		if plat.Limits != nil {
			timeout = plat.Limits.TimeoutSeconds
		}
		if plat.Database != nil {
			budget = plat.Database.ConnectionBudget
		}
	}

	spec := &app.Spec
	var inherited []string
	inherit := func(path string) { inherited = append(inherited, path) }

	eff := effectiveValues{connectionBudget: defaults.ConnectionBudget}
	if budget > 0 {
		eff.connectionBudget = int(budget)
	}

	// containerConcurrency
	eff.containerConcurrency = defaults.ContainerConcurrency
	switch {
	case spec.Scaling != nil && spec.Scaling.ContainerConcurrency > 0:
		eff.containerConcurrency = int64(spec.Scaling.ContainerConcurrency)
	case scalingDefaults.ContainerConcurrency > 0:
		eff.containerConcurrency = int64(scalingDefaults.ContainerConcurrency)
		inherit("spec.scaling.containerConcurrency")
	}

	// resources, per field
	var appRes appsv1alpha1.ResourcesSpec
	if spec.Resources != nil {
		appRes = *spec.Resources
	}
	pick := func(path, appVal, platVal, builtin string) effectiveString {
		switch {
		case appVal != "":
			return effectiveString{value: appVal, src: sourceApp}
		case platVal != "":
			inherit(path)
			return effectiveString{value: platVal, src: sourcePlatform}
		default:
			return effectiveString{value: builtin, src: sourceBuiltin}
		}
	}
	eff.cpuRequest = pick("spec.resources.cpuRequest", appRes.CPURequest, resourceDefaults.CPURequest, defaults.CPURequest)
	eff.memoryRequest = pick("spec.resources.memoryRequest", appRes.MemoryRequest, resourceDefaults.MemoryRequest, defaults.MemoryRequest)
	eff.cpuLimit = pick("spec.resources.cpuLimit", appRes.CPULimit, resourceDefaults.CPULimit, defaults.CPULimit)
	eff.memoryLimit = pick("spec.resources.memoryLimit", appRes.MemoryLimit, resourceDefaults.MemoryLimit, defaults.MemoryLimit)

	// timeoutSeconds
	eff.timeoutSeconds = defaults.TimeoutSeconds
	switch {
	case spec.TimeoutSeconds > 0:
		eff.timeoutSeconds = int64(spec.TimeoutSeconds)
	case timeout > 0:
		eff.timeoutSeconds = int64(timeout)
		inherit("spec.timeoutSeconds")
	}

	// annotation knobs
	scaling := spec.Scaling
	switch {
	case scaling != nil && scaling.ScaleDownDelay != "":
		eff.scaleDownDelay = scaling.ScaleDownDelay
	case scalingDefaults.ScaleDownDelay != "":
		eff.scaleDownDelay = scalingDefaults.ScaleDownDelay
		inherit("spec.scaling.scaleDownDelay")
	}
	pickPtr := func(path string, appVal, platVal *int32) *int32 {
		switch {
		case appVal != nil:
			return appVal
		case platVal != nil:
			inherit(path)
			v := *platVal
			return &v
		default:
			return nil
		}
	}
	var appTBC, appPW, appPT *int32
	if scaling != nil {
		appTBC, appPW, appPT = scaling.TargetBurstCapacity, scaling.PanicWindowPercentage, scaling.PanicThresholdPercentage
	}
	eff.targetBurstCapacity = pickPtr("spec.scaling.targetBurstCapacity", appTBC, scalingDefaults.TargetBurstCapacity)
	eff.panicWindowPercentage = pickPtr("spec.scaling.panicWindowPercentage", appPW, scalingDefaults.PanicWindowPercentage)
	eff.panicThresholdPercentage = pickPtr("spec.scaling.panicThresholdPercentage", appPT, scalingDefaults.PanicThresholdPercentage)

	sort.Strings(inherited)
	eff.inherited = inherited
	return eff
}

// platformSpecHash identifies a platform configuration by content. It is the
// stamp the per-app "has this app been rendered against the current platform?"
// test compares. Content rather than generation, so deleting and recreating an
// unchanged KnextPlatform is not mistaken for a change (generation restarts at
// 1), and every PRESENT platform — even an empty one — has a non-empty hash, so
// "an empty platform exists" is distinguishable from "none exists" ("").
func platformSpecHash(spec *platformv1alpha1.KnextPlatformSpec) string {
	// encoding/json emits struct fields in declaration order and sorts map keys,
	// so the bytes are deterministic for a given value.
	raw, err := json.Marshal(spec)
	if err != nil {
		// A KnextPlatformSpec is plain scalars and pointers, so Marshal cannot
		// fail; the fallback exists only so the shared reconcile loop never
		// panics (#435) and still gives distinct specs distinct stamps.
		raw = []byte(fmt.Sprintf("%+v", *spec))
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}
