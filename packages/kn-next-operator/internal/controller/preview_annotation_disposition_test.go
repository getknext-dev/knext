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
	"fmt"
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

// Scanning guard for the preview-mode disposition of every scaling knob
// buildDesiredKsvc can stamp (#775).
//
// WHY THIS EXISTS. The preview override in nextapp_controller.go carries a
// prose disposition list — FORCED max-scale/min-scale/pod-retention, DROPPED
// scale-down-delay, PASSED target-burst-capacity + the panic pair + the two
// template fields. That list is a documented expectation, and scale-down-delay
// was the SECOND scaling knob to leak silently through it (#770). This file
// converts the expectation into a gate, per the repo rule "prefer scanning to
// enumerating": an unhandled knob FAILS rather than passes.
//
// HOW IT SCANS, in three layers — all load-bearing:
//
//  1. the ScalingSpec fixture is checked by DEEP reflection: every LEAF of
//     appsv1alpha1.ScalingSpec — recursing through structs, pointers-to-struct,
//     slices/maps of structs — must be non-zero. A shallow check would miss a
//     knob nested one level down (a new WarmWindow sub-field: the slice is
//     non-zero as soon as ONE element field is set, so its siblings could stay
//     zero and never reach the builder).
//  2. the NextApp fixture is checked for TOP-LEVEL FULLNESS: every field of
//     NextAppSpec must be non-zero, so an autoscaling annotation stamped from a
//     NON-scaling branch (spec.observability, spec.traffic, …) still runs. A new
//     sub-spec cannot ship without this fixture noticing.
//  3. the knobs are COLLECTED FROM THE BUILDER's output, never from a
//     hand-written list: buildDesiredKsvc is run twice over that maximal spec
//     (production and preview) and every emitted `autoscaling.knative.dev/*` key
//     from either run must have an explicit entry in previewDispositions below.
//
// A key with no entry is a FAILURE, and the message asks the author to DECIDE
// the disposition (force / drop / pass) rather than to append the key.
//
// SCOPE, stated precisely so the next author does not over-read it. Layer 1 is
// leaf-deep, but ONLY under ScalingSpec — the other NextAppSpec sub-specs are
// checked to top-level fullness (layer 2), not to their leaves, because they do
// not host autoscaling knobs today. If one ever does, deepen layer 2 rather than
// assuming it is covered. And a knob expressed as a ksvc TEMPLATE FIELD rather
// than an annotation (containerConcurrency, timeoutSeconds) is invisible to the
// prefix filter by construction; those live in previewTemplateFieldDispositions
// and are asserted separately, by name.
//
// Every dispositioned knob is then asserted OBSERVABLY: a FORCED key must differ
// from what the user's spec produced in production (otherwise "forcing" proves
// nothing), a DROPPED key must be present in production and absent in preview,
// and a PASSED key must be present in both, equal to each other AND equal to the
// value the fixture's spec asked for (otherwise prod and preview can agree on a
// value neither user asked for).

// dispositionKind is the fate a preview revision imposes on one stamped scaling
// knob.
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
	// fromSpec is the value the FIXTURE's spec asks for; only read for
	// dispPassed, where it ties both runs back to the user's input.
	fromSpec string
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
		kind: dispPassed, fromSpec: "150",
		why: "#411/ADR-0032: a reaction-shape knob that costs nothing idle, so a preview keeps " +
			"the user's value",
	},
	"autoscaling.knative.dev/panic-window-percentage": {
		kind: dispPassed, fromSpec: "20",
		why: "#413/ADR-0033: reaction-shape knob, costs nothing idle — preview keeps it",
	},
	"autoscaling.knative.dev/panic-threshold-percentage": {
		kind: dispPassed, fromSpec: "300",
		why: "#413/ADR-0033: reaction-shape knob, costs nothing idle — preview keeps it",
	},
}

// previewTemplateFieldDispositions covers the scaling knobs stamped as ksvc
// RevisionSpec FIELDS rather than annotations. The annotation guard above can
// never see them (no `autoscaling.knative.dev/` prefix to filter on), so they get
// their own named table — the blind spot a future field-shaped knob would fall
// into otherwise. Keyed by the ksvc path, valued by the same fate vocabulary.
var previewTemplateFieldDispositions = map[string]previewFate{
	"spec.template.spec.containerConcurrency": {
		kind: dispPassed, fromSpec: "42",
		why: "#377/ADR-0028: the per-pod concurrency soft target shapes WHEN Knative adds a " +
			"pod, not how many idle pods cost — a preview keeps the user's value (or the " +
			"operator default), exactly as production does",
	},
	"spec.template.spec.timeoutSeconds": {
		kind: dispPassed, fromSpec: "111",
		why: "the per-request timeout is a request-duration cap, not an autoscaling knob; " +
			"included here because it is the OTHER template field a preview could plausibly " +
			"clamp and does not — recording the non-decision keeps the blind spot visible",
	},
}

// maximalScalingSpec sets EVERY ScalingSpec leaf to a non-zero value, so the
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

// maximalNextAppSpec populates EVERY NextAppSpec field, so every branch of
// buildDesiredKsvc runs and an autoscaling annotation stamped from a
// non-ScalingSpec branch is collected too. (The fixture is deliberately not
// minimal: minimality is what let the observability branch hide a stamp.)
func maximalNextAppSpec() appsv1alpha1.NextAppSpec {
	return appsv1alpha1.NextAppSpec{
		Image:   "registry.example.com/app:v1@sha256:abc123",
		Scaling: maximalScalingSpec(),
		Preview: &appsv1alpha1.PreviewSpec{Enabled: true, PRID: "42"},
	}
}

// assertFixtureCoversEveryScalingLeaf is layer (1) of the scan. A ScalingSpec
// leaf the fixture leaves at its zero value would never reach the builder, so an
// annotation stamped from it would never be collected and its missing
// disposition would never be noticed. It recurses, because the leak class this
// guards is "one knob among several in a nested struct" — the top-level slice or
// pointer is already non-zero once a SIBLING field is set.
func assertFixtureCoversEveryScalingLeaf(t *testing.T) {
	t.Helper()
	assertLeavesNonZero(t, "ScalingSpec", reflect.ValueOf(maximalScalingSpec()))
}

func assertLeavesNonZero(t *testing.T, path string, v reflect.Value) {
	t.Helper()

	complain := func(what string) {
		t.Errorf(
			"%s is %s in the fixture: a scaling knob was added (or renamed) without extending "+
				"maximalScalingSpec(), so the builder never takes its branch and any annotation "+
				"it stamps escapes the preview disposition guard. Give it a non-zero value in "+
				"preview_annotation_disposition_test.go.",
			path, what,
		)
	}

	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if v.IsNil() {
			complain("nil")
			return
		}
		assertLeavesNonZero(t, path, v.Elem())
	case reflect.Struct:
		typ := v.Type()
		for i := 0; i < typ.NumField(); i++ {
			if !typ.Field(i).IsExported() {
				continue
			}
			assertLeavesNonZero(t, path+"."+typ.Field(i).Name, v.Field(i))
		}
	case reflect.Slice, reflect.Array:
		if v.Len() == 0 {
			complain("empty")
			return
		}
		for i := 0; i < v.Len(); i++ {
			assertLeavesNonZero(t, fmt.Sprintf("%s[%d]", path, i), v.Index(i))
		}
	case reflect.Map:
		if v.Len() == 0 {
			complain("empty")
			return
		}
		keys := v.MapKeys()
		sort.Slice(keys, func(a, b int) bool {
			return fmt.Sprint(keys[a].Interface()) < fmt.Sprint(keys[b].Interface())
		})
		for _, k := range keys {
			assertLeavesNonZero(t, fmt.Sprintf("%s[%v]", path, k.Interface()), v.MapIndex(k))
		}
	default:
		if v.IsZero() {
			complain("zero")
		}
	}
}

// assertFixtureCoversEveryNextAppSubSpec is layer (2): every TOP-LEVEL
// NextAppSpec field must be populated, so a stamping branch gated on a
// non-scaling sub-spec still runs. Deliberately shallow — see the SCOPE note at
// the top of this file.
func assertFixtureCoversEveryNextAppSubSpec(t *testing.T) {
	t.Helper()
	spec := maximalNextAppSpec()
	v := reflect.ValueOf(spec)
	typ := v.Type()
	for i := 0; i < typ.NumField(); i++ {
		if !typ.Field(i).IsExported() {
			continue
		}
		f := v.Field(i)
		empty := f.IsZero()
		if !empty && (f.Kind() == reflect.Slice || f.Kind() == reflect.Map) {
			empty = f.Len() == 0
		}
		if empty {
			t.Errorf(
				"NextAppSpec field %q is unset in maximalNextAppSpec(): buildDesiredKsvc's "+
					"branch for it never runs, so any autoscaling annotation it stamps escapes "+
					"the preview disposition guard entirely (this is how the observability "+
					"branch hid a stamp). Populate it in preview_annotation_disposition_test.go.",
				typ.Field(i).Name,
			)
		}
	}
}

// buildFixtureKsvc runs buildDesiredKsvc over the maximal spec, in preview mode
// or not, and returns the rendered ksvc.
func buildFixtureKsvc(t *testing.T, preview bool) *servingv1.Service {
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

	spec := maximalNextAppSpec()
	if !preview {
		spec.Preview = nil
	}
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec:       spec,
	}

	ksvc := &servingv1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: app.Name, Namespace: app.Namespace},
	}
	if err := r.buildDesiredKsvc(app, ksvc); err != nil {
		t.Fatalf("buildDesiredKsvc(preview=%v) returned an unexpected error: %v", preview, err)
	}
	return ksvc
}

// stampedAutoscalingAnnotations returns only the `autoscaling.knative.dev/*`
// annotations the builder emitted.
func stampedAutoscalingAnnotations(t *testing.T, preview bool) map[string]string {
	t.Helper()
	out := map[string]string{}
	for k, v := range buildFixtureKsvc(t, preview).Spec.Template.ObjectMeta.Annotations {
		if strings.HasPrefix(k, "autoscaling.knative.dev/") {
			out[k] = v
		}
	}
	return out
}

func TestPreviewDispositionCoversEveryStampedAutoscalingAnnotation(t *testing.T) {
	assertFixtureCoversEveryScalingLeaf(t)
	assertFixtureCoversEveryNextAppSubSpec(t)

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

// TestPreviewDispositionCoversScalingTemplateFields is the field-shaped half of
// the same question: containerConcurrency is an autoscaling knob that never
// appears as an annotation, so the prefix scan above is structurally blind to it.
func TestPreviewDispositionCoversScalingTemplateFields(t *testing.T) {
	prodSpec := buildFixtureKsvc(t, false).Spec.Template.Spec
	previewSpec := buildFixtureKsvc(t, true).Spec.Template.Spec

	render := func(v *int64) (string, bool) {
		if v == nil {
			return "", false
		}
		return fmt.Sprintf("%d", *v), true
	}

	prod := map[string]string{}
	preview := map[string]string{}
	for path, pair := range map[string][2]*int64{
		"spec.template.spec.containerConcurrency": {prodSpec.ContainerConcurrency, previewSpec.ContainerConcurrency},
		"spec.template.spec.timeoutSeconds":       {prodSpec.TimeoutSeconds, previewSpec.TimeoutSeconds},
	} {
		if s, ok := render(pair[0]); ok {
			prod[path] = s
		}
		if s, ok := render(pair[1]); ok {
			preview[path] = s
		}
	}

	for path := range prod {
		fate, ok := previewTemplateFieldDispositions[path]
		if !ok {
			t.Errorf(
				"%s is a rendered scaling-relevant template field with NO preview disposition — "+
					"decide its fate (forced / dropped / passed) and record it in "+
					"previewTemplateFieldDispositions and in nextapp_controller.go's preview list",
				path,
			)
			continue
		}
		assertObservable(t, path, fate, prod, preview)
	}
	for path := range previewTemplateFieldDispositions {
		if _, ok := prod[path]; !ok {
			t.Errorf("previewTemplateFieldDispositions has a stale entry for %q — the builder no "+
				"longer renders it", path)
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
		// Both halves. prod==preview alone is satisfied by two runs agreeing on
		// a value NEITHER derived from the user's spec, so tie production back
		// to what the fixture actually asked for.
		if prodVal != fate.fromSpec {
			t.Errorf("%s: declared PASSED THROUGH from the user's spec value %q, but production "+
				"rendered %q — the value is not coming from the spec at all", key, fate.fromSpec, prodVal)
		}
		if prodVal != prevVal {
			t.Errorf("%s: declared PASSED THROUGH (%s) but preview changed it: prod=%q preview=%q",
				key, fate.why, prodVal, prevVal)
		}
	}
}
