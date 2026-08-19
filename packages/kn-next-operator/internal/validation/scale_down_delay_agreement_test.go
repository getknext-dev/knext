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
	"context"
	"testing"

	"knative.dev/serving/pkg/apis/autoscaling"
	"knative.dev/serving/pkg/autoscaler/config/autoscalerconfig"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// TestScaleDownDelayAgreesWithKnative is the test whose ABSENCE let a real
// defect through (#762 review round 1): the first implementation checked
// "parses" and "0 <= d <= 1h" but missed Knative's THIRD clause — at most
// SECOND precision (annotation_validation.go validateScaleDownDelay). So
// "42.5s" passed knext admission, the reconciler stamped it, and Knative's own
// ksvc webhook then rejected the Service, leaving the NextApp in a permanent
// reconcile-error loop pointing at an annotation the user never wrote. Envtest
// cannot see that class of defect: no Knative webhook is installed there.
//
// The assertion is AGREEMENT, not a restated rule: for every value, knext's
// accept/reject verdict must equal the verdict of the vendored
// knative.dev/serving validator on the same annotation. It runs with no
// cluster. Any future divergence — a hand-rolled shortcut, a stale copied
// bound, a new upstream clause — reds here.
func TestScaleDownDelayAgreesWithKnative(t *testing.T) {
	const digestImage = "registry.example.com/app:v1@sha256:abc123def456"

	values := []string{
		// Accepted by Knative.
		"0s", "30s", "5m", "1h", "1h0m0s", "3600s", "0", "120s", "2m30s",
		// Second-precision violations — the clause the first implementation
		// missed. Every one of these parses fine and is inside 0s–1h.
		"42.5s", "1500ms", "0.5s", "90s500ms", "1ns", "1µs",
		// Parseable shapes the CLI's syntax mirror once rejected (#773): an
		// explicit sign, leading/trailing-dot fractions, U+03BC micro. The
		// CLI's accepted-corpus scan inherits these, so they pin its regex as
		// a superset of Go's grammar for exactly the shapes it got wrong.
		"+5m", ".5s", "1.s", "1μs",
		// Out of range.
		"2h", "-1s", "61m",
		// Not durations at all.
		"5 minutes", "300", "", "abc", "5 m", "1h30",
	}

	for _, v := range values {
		t.Run(v, func(t *testing.T) {
			spec := &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{ScaleDownDelay: v},
			}
			knextRejects := ValidateNextAppSpec(spec) != nil

			// The reference verdict, straight from the library. An empty
			// value is knext's "unset" (no annotation stamped), which Knative
			// never sees — model that by asking about an EMPTY annotation map.
			anns := map[string]string{}
			if v != "" {
				anns[autoscaling.ScaleDownDelayAnnotationKey] = v
			}
			knativeRejects := autoscaling.ValidateAnnotations(
				context.Background(), &autoscalerconfig.Config{}, anns) != nil

			if knextRejects != knativeRejects {
				t.Fatalf("verdict disagreement on %q: knext rejects=%v, knative.dev/serving rejects=%v — "+
					"a value knext accepts and Knative rejects is stamped onto the ksvc and then refused by "+
					"Knative's webhook, stranding the NextApp in a reconcile-error loop",
					v, knextRejects, knativeRejects)
			}
		})
	}
}

// TestScaleDownDelayBoundIsNotHandCopied pins the delegation itself: the
// operator's accepted upper bound must BE autoscaling.WindowMax, so bumping
// the vendored knative.dev/serving moves knext's bound with it. A hand-copied
// `time.Hour` would keep this green today and silently wrong after an upstream
// change, so the assertion is stated against the library constant on both
// sides — one value just inside it, one just outside.
func TestScaleDownDelayBoundIsNotHandCopied(t *testing.T) {
	const digestImage = "registry.example.com/app:v1@sha256:abc123def456"

	atMax := autoscaling.WindowMax.String()
	overMax := (autoscaling.WindowMax + 1000000000).String() // +1s, still second-precision

	if err := ValidateNextAppSpec(&appsv1alpha1.NextAppSpec{
		Image:   digestImage,
		Scaling: &appsv1alpha1.ScalingSpec{ScaleDownDelay: atMax},
	}); err != nil {
		t.Fatalf("scaleDownDelay at autoscaling.WindowMax (%s) was rejected: %v", atMax, err)
	}
	if err := ValidateNextAppSpec(&appsv1alpha1.NextAppSpec{
		Image:   digestImage,
		Scaling: &appsv1alpha1.ScalingSpec{ScaleDownDelay: overMax},
	}); err == nil {
		t.Fatalf("scaleDownDelay one second past autoscaling.WindowMax (%s) was accepted", overMax)
	}
}
