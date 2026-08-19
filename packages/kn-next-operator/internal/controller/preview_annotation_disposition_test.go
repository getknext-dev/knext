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
	"sort"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// Scanning guard for the preview-mode disposition of every
// `autoscaling.knative.dev/*` annotation buildDesiredKsvc can stamp (#775).
//
// WHY THIS EXISTS. The preview override in nextapp_controller.go carries a
// prose disposition list — FORCED max-scale/min-scale/pod-retention, DROPPED
// scale-down-delay, PASSED target-burst-capacity + the panic pair. That list is
// a documented expectation, and scale-down-delay was the SECOND scaling knob to
// leak silently through it (#770). This file converts the expectation into a
// gate, per the repo rule "prefer scanning to enumerating": an unhandled knob
// FAILS rather than passes.
//
// HOW IT SCANS, in two layers — both are load-bearing:
//
//  1. the ScalingSpec fixture is checked by REFLECTION: every field of
//     appsv1alpha1.ScalingSpec must be set to a non-zero value. Adding a field
//     to ScalingSpec without extending the fixture reds this test, so a new knob
//     cannot reach the builder unexercised.
//  2. the annotation keys are COLLECTED FROM THE BUILDER's output, never from a
//     hand-written list: buildDesiredKsvc is run twice over that maximal spec
//     (production and preview) and every emitted `autoscaling.knative.dev/*` key
//     from either run must have an explicit entry in previewDispositions below.
//
// A key with no entry is a FAILURE, and the message asks the author to DECIDE
// the disposition (force / drop / pass) rather than to append the key.
//
// Every dispositioned key is then asserted OBSERVABLY: a FORCED key must differ
// from what the user's spec produced in production (otherwise "forcing" proves
// nothing), a DROPPED key must be present in production and absent in preview,
// and a PASSED key must be present and identical in both.

// dispositionKind is the fate a preview revision imposes on one stamped
// autoscaling annotation.
type dispositionKind int

const (
	// dispForced: the preview override overwrites the value the user's spec
	// produced.
	dispForced dispositionKind = iota
	// dispDropped: the preview override deletes the key, so the Knative
	// cluster default applies unmanaged.
	dispDropped
	// dispPassed: the preview revision deliberately keeps the user's value.
	dispPassed
)

type previewFate struct {
	kind dispositionKind
	// forced is the value preview must stamp; only read for dispForced.
	forced string
	// why records the reasoning, so the table stays a decision record and not
	// a second enumeration to drift from the first.
	why string
}

// previewDispositions is the disposition TABLE the guard asserts against — the
// test-side mirror of the prose list in nextapp_controller.go's preview block.
// Every `autoscaling.knative.dev/*` key the builder can emit MUST appear here.
var previewDispositions = map[string]previewFate{
	"autoscaling.knative.dev/max-scale": {
		kind: dispForced, forced: "1",
		why: "one pod per preview (ADR-0013): a preview is ephemeral, so it never fans out",
	},
	"autoscaling.knative.dev/min-scale": {
		kind: dispForced, forced: "0",
		why: "never keep a preview warm — this also overrides an active warmSchedule floor",
	},
	"autoscaling.knative.dev/scale-to-zero-pod-retention-period": {
		kind: dispForced, forced: "30s",
		why: "short idle window bounds preview cost; production leaves it unmanaged",
	},
	"autoscaling.knative.dev/scale-down-delay": {
		kind: dispDropped,
		why: "#770/ADR-0045: dropped, not clamped — previews predate the field, so dropping " +
			"restores their exact prior behaviour (Knative cluster default, unmanaged)",
	},
	"autoscaling.knative.dev/target-burst-capacity": {
		kind: dispPassed,
		why: "#411/ADR-0032: a reaction-shape knob that costs nothing idle, so a preview keeps " +
			"the user's value",
	},
	"autoscaling.knative.dev/panic-window-percentage": {
		kind: dispPassed,
		why:  "#413/ADR-0033: reaction-shape knob, costs nothing idle — preview keeps it",
	},
	"autoscaling.knative.dev/panic-threshold-percentage": {
		kind: dispPassed,
		why:  "#413/ADR-0033: reaction-shape knob, costs nothing idle — preview keeps it",
	},
}

// maximalScalingSpec sets EVERY ScalingSpec field to a non-zero value, so the
// builder takes every "only stamped when explicitly set" branch. Values are
// chosen to differ from the preview-forced ones — see assertObservable.
func maximalScalingSpec() *appsv1alpha1.ScalingSpec {
	tbc := int32(150)
	panicWindow := int32(20)
	panicThreshold := int32(300)
	return &appsv1alpha1.ScalingSpec{
		MinScale:             3,
		MaxScale:             7,
		ContainerConcurrency: 42,
		PoolMax:              9,
		ImagePrewarm:         true,
		WarmSchedule: []appsv1alpha1.WarmWindow{
			// Active at the pinned clock below, with a replica floor ABOVE
			// MinScale — so production min-scale is 5, and preview forcing it
			// to 0 is observable against the warm floor too.
			{Start: "0 8 * * *", End: "0 18 * * *", Replicas: 5, Timezone: "UTC"},
		},
		TargetBurstCapacity:      &tbc,
		PanicWindowPercentage:    &panicWindow,
		PanicThresholdPercentage: &panicThreshold,
		ScaleDownDelay:           "5m",
	}
}

// assertFixtureCoversEveryScalingField is layer (1) of the scan: a ScalingSpec
// field the fixture leaves at its zero value would never reach the builder, so
// its annotation would never be collected and its missing disposition would
// never be noticed.
func assertFixtureCoversEveryScalingField(t *testing.T) {
	t.Helper()
	v := reflect.ValueOf(*maximalScalingSpec())
	typ := v.Type()
	for i := 0; i < typ.NumField(); i++ {
		if v.Field(i).IsZero() {
			t.Errorf(
				"ScalingSpec field %q is ZERO in maximalScalingSpec(): the field was added "+
					"(or renamed) without extending the fixture, so the builder never takes its "+
					"branch and any annotation it stamps escapes the preview disposition guard. "+
					"Set it to a non-zero value in maximalScalingSpec() (%s).",
				typ.Field(i).Name, "preview_annotation_disposition_test.go",
			)
		}
	}
}

// stampedAutoscalingAnnotations runs buildDesiredKsvc over the maximal spec and
// returns only the `autoscaling.knative.dev/*` annotations it emitted.
func stampedAutoscalingAnnotations(t *testing.T, preview bool) map[string]string {
	t.Helper()

	sch := runtime.NewScheme()
	if err := appsv1alpha1.AddToScheme(sch); err != nil {
		t.Fatalf("AddToScheme(apps): %v", err)
	}
	if err := servingv1.AddToScheme(sch); err != nil {
		t.Fatalf("AddToScheme(serving): %v", err)
	}

	// Pinned inside the warm window above, so the floor evaluation is
	// deterministic rather than dependent on wall-clock time (ADR-0030).
	r := &NextAppReconciler{
		Scheme: sch,
		Clock:  func() time.Time { return time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC) },
	}

	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec: appsv1alpha1.NextAppSpec{
			Image:   "registry.example.com/app:v1@sha256:abc123",
			Scaling: maximalScalingSpec(),
		},
	}
	if preview {
		app.Spec.Preview = &appsv1alpha1.PreviewSpec{Enabled: true, PRID: "42"}
	}

	ksvc := &servingv1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: app.Name, Namespace: app.Namespace},
	}
	if err := r.buildDesiredKsvc(app, ksvc); err != nil {
		t.Fatalf("buildDesiredKsvc(preview=%v) returned an unexpected error: %v", preview, err)
	}

	out := map[string]string{}
	for k, v := range ksvc.Spec.Template.ObjectMeta.Annotations {
		if strings.HasPrefix(k, "autoscaling.knative.dev/") {
			out[k] = v
		}
	}
	return out
}

func TestPreviewDispositionCoversEveryStampedAutoscalingAnnotation(t *testing.T) {
	assertFixtureCoversEveryScalingField(t)

	prod := stampedAutoscalingAnnotations(t, false)
	preview := stampedAutoscalingAnnotations(t, true)

	if len(prod) == 0 {
		t.Fatal("the builder stamped NO autoscaling.knative.dev/* annotations over a maximal " +
			"ScalingSpec — the collection step is broken, so this guard would pass vacuously")
	}

	// Union of both runs: preview stamps at least one key production never does
	// (scale-to-zero-pod-retention-period).
	keys := map[string]struct{}{}
	for k := range prod {
		keys[k] = struct{}{}
	}
	for k := range preview {
		keys[k] = struct{}{}
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)

	for _, key := range sorted {
		fate, ok := previewDispositions[key]
		if !ok {
			t.Errorf(
				"buildDesiredKsvc stamps %q but it has NO preview disposition. DECIDE what a "+
					"preview revision should do with it — FORCE it to a preview-safe value, DROP "+
					"it so the Knative cluster default applies, or deliberately PASS the user's "+
					"value through — then record that decision BOTH in previewDispositions "+
					"(preview_annotation_disposition_test.go) and in the disposition list in "+
					"nextapp_controller.go's preview block. Do not just add the key here.",
				key,
			)
			continue
		}
		assertObservable(t, key, fate, prod, preview)
	}

	// Keep the table honest in the other direction: an entry for a key the
	// builder no longer emits is a stale decision that reads as coverage.
	for key := range previewDispositions {
		if _, ok := keys[key]; !ok {
			t.Errorf(
				"previewDispositions has an entry for %q but buildDesiredKsvc never stamps it "+
					"over a maximal ScalingSpec — remove the stale entry (or fix the fixture if "+
					"the key should still be emitted)", key,
			)
		}
	}
}

// assertObservable checks the declared fate against the two builder runs, in a
// way that fails if the fate is asserted but not actually exercised.
func assertObservable(t *testing.T, key string, fate previewFate, prod, preview map[string]string) {
	t.Helper()

	prodVal, inProd := prod[key]
	prevVal, inPreview := preview[key]

	switch fate.kind {
	case dispForced:
		if !inPreview {
			t.Errorf("%s: declared FORCED to %q (%s) but preview does not stamp it at all",
				key, fate.forced, fate.why)
			return
		}
		if prevVal != fate.forced {
			t.Errorf("%s: declared FORCED to %q (%s) but preview stamped %q",
				key, fate.forced, fate.why, prevVal)
		}
		if inProd && prodVal == fate.forced {
			t.Errorf("%s: declared FORCED to %q, but production stamps the same value from the "+
				"fixture, so the forcing is unobservable — change the fixture value in "+
				"maximalScalingSpec() so the override is actually visible", key, fate.forced)
		}
	case dispDropped:
		if !inProd {
			t.Errorf("%s: declared DROPPED (%s) but production does not stamp it either, so the "+
				"drop is unobservable — fix maximalScalingSpec() so the key is emitted outside "+
				"preview", key, fate.why)
		}
		if inPreview {
			t.Errorf("%s: declared DROPPED (%s) but preview stamped it as %q",
				key, fate.why, prevVal)
		}
	case dispPassed:
		if !inProd || !inPreview {
			t.Errorf("%s: declared PASSED THROUGH (%s) but it is missing (prod=%v, preview=%v) — "+
				"a pass-through is only meaningful when both runs stamp it",
				key, fate.why, inProd, inPreview)
			return
		}
		if prodVal != prevVal {
			t.Errorf("%s: declared PASSED THROUGH (%s) but preview changed it: prod=%q preview=%q",
				key, fate.why, prodVal, prevVal)
		}
	}
}
