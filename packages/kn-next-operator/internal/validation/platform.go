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
	"fmt"

	"k8s.io/apimachinery/pkg/api/resource"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
)

// ValidatePlatformSpec is the Go-side acceptance check for a KnextPlatform
// (ADR-0064 "Accepted"). The CRD's OpenAPI schema is the first line of defence;
// this is the second, for a platform applied with validation off or a value the
// schema's pattern admits but the bounded quantity parser does not. A platform
// that fails here is IGNORED by the operator (built-in defaults apply) and
// reported, never merged — so a bad admin value cannot reach the shared
// reconcile loop.
//
// The scale-down-delay rule is delegated to Knative's own validator through the
// SAME helper the NextApp field uses, so the platform default and the app field
// cannot disagree about what Knative accepts. A nil spec is the empty platform.
func ValidatePlatformSpec(spec *platformv1alpha1.KnextPlatformSpec) error {
	if spec == nil {
		return nil
	}

	switch spec.Profile {
	case "", platformv1alpha1.ProfileDefault, platformv1alpha1.ProfileFastColdStart:
	default:
		return fmt.Errorf("spec.profile %q is not one of %q, %q",
			spec.Profile, platformv1alpha1.ProfileDefault, platformv1alpha1.ProfileFastColdStart)
	}

	if sc := spec.Scaling; sc != nil && sc.Defaults != nil {
		d := sc.Defaults
		if d.ContainerConcurrency < 0 {
			return fmt.Errorf("spec.scaling.defaults.containerConcurrency must be >= 0, got %d", d.ContainerConcurrency)
		}
		if err := validateScaleDownDelay("spec.scaling.defaults.scaleDownDelay", d.ScaleDownDelay); err != nil {
			return err
		}
		if d.TargetBurstCapacity != nil && *d.TargetBurstCapacity < -1 {
			return fmt.Errorf("spec.scaling.defaults.targetBurstCapacity must be -1 or >= 0, got %d", *d.TargetBurstCapacity)
		}
		if d.PanicWindowPercentage != nil && (*d.PanicWindowPercentage < 1 || *d.PanicWindowPercentage > 100) {
			return fmt.Errorf("spec.scaling.defaults.panicWindowPercentage must be between 1 and 100, got %d", *d.PanicWindowPercentage)
		}
		if d.PanicThresholdPercentage != nil && *d.PanicThresholdPercentage < 110 {
			return fmt.Errorf("spec.scaling.defaults.panicThresholdPercentage must be >= 110, got %d", *d.PanicThresholdPercentage)
		}
	}

	if rs := spec.Resources; rs != nil && rs.Defaults != nil {
		r := rs.Defaults
		cpuReq, err := parsePositiveQuantity("spec.resources.defaults.cpuRequest", r.CPURequest)
		if err != nil {
			return err
		}
		memReq, err := parsePositiveQuantity("spec.resources.defaults.memoryRequest", r.MemoryRequest)
		if err != nil {
			return err
		}
		cpuLim, err := parsePositiveQuantity("spec.resources.defaults.cpuLimit", r.CPULimit)
		if err != nil {
			return err
		}
		memLim, err := parsePositiveQuantity("spec.resources.defaults.memoryLimit", r.MemoryLimit)
		if err != nil {
			return err
		}
		// A request larger than its limit is a pod the API server refuses. Checked
		// here only when the platform sets BOTH sides; a platform value that meets
		// an app's or the built-in's other side is checked after the merge.
		if err := requestWithinLimit("cpu", r.CPURequest, cpuReq, r.CPULimit, cpuLim); err != nil {
			return err
		}
		if err := requestWithinLimit("memory", r.MemoryRequest, memReq, r.MemoryLimit, memLim); err != nil {
			return err
		}
	}

	if l := spec.Limits; l != nil && l.TimeoutSeconds < 0 {
		return fmt.Errorf("spec.limits.timeoutSeconds must be >= 0, got %d", l.TimeoutSeconds)
	}
	if d := spec.Database; d != nil && d.ConnectionBudget < 0 {
		return fmt.Errorf("spec.database.connectionBudget must be >= 0, got %d", d.ConnectionBudget)
	}
	if r := spec.Rollout; r != nil && r.MaxAppsPerMinute < 0 {
		return fmt.Errorf("spec.rollout.maxAppsPerMinute must be >= 0, got %d", r.MaxAppsPerMinute)
	}
	return nil
}

func requestWithinLimit(kind, reqText string, req *resource.Quantity, limText string, lim *resource.Quantity) error {
	if req != nil && lim != nil && req.Cmp(*lim) > 0 {
		return fmt.Errorf(
			"spec.resources.defaults.%sRequest (%q) exceeds spec.resources.defaults.%sLimit (%q): "+
				"a request cannot be larger than its limit",
			kind, reqText, kind, limText)
	}
	return nil
}

// ValidateEffectiveResources checks the request <= limit pair of the MERGED
// resources, for the case the per-layer checks cannot see: a platform value
// meeting an app-set or built-in value on the other side (platform cpuRequest 2
// against the built-in cpuLimit 1000m is a pod the API server refuses).
//
// Callers pass the four effective strings. The returned field names the side
// that, if changed, would fix it — the platform-supplied one when exactly one
// side is — so the status can point at the right object.
func ValidateEffectiveResources(cpuReq, cpuLim, memReq, memLim string) (field string, err error) {
	for _, p := range []struct{ kind, req, lim string }{
		{"cpu", cpuReq, cpuLim},
		{"memory", memReq, memLim},
	} {
		rq, e1 := ParseQuantityBounded(p.req)
		lq, e2 := ParseQuantityBounded(p.lim)
		if e1 != nil || e2 != nil {
			// Unparseable values are the per-layer validators' concern; the merge
			// only reasons about values they already accepted.
			continue
		}
		if rq.Cmp(lq) > 0 {
			return p.kind + "Request", fmt.Errorf(
				"effective %s request (%q) exceeds the effective %s limit (%q): a request cannot be larger than its limit",
				p.kind, p.req, p.kind, p.lim)
		}
	}
	return "", nil
}
