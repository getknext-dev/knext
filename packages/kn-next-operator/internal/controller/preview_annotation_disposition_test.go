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
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// Scanning guard for the preview-mode disposition of every scaling knob
// buildDesiredKsvc can stamp (#775).
//
// WHY THIS EXISTS. The preview override in nextapp_controller.go carries a
// prose disposition list — FORCED max-scale/min-scale/pod-retention, DROPPED
// scale-down-delay, PASSED target-burst-capacity + the panic pair + the ksvc
// template fields. That list is a documented expectation, and scale-down-delay
// was the SECOND scaling knob to leak silently through it (#770). This file
// converts the expectation into a gate, per the repo rule "prefer scanning to
// enumerating": an unhandled knob FAILS rather than passes.
//
// HOW IT SCANS. Nothing here is a hand-maintained list of knobs; every list is
// derived from a type or from the builder's own output.
//
//  1. FIXTURES (guardFixtures) — several admission-valid NextApp shapes, not
//     one. A single "set everything" spec cannot work: the API has mutually
//     exclusive fields (warmSchedule vs pinned traffic, #393/ADR-0030), so a
//     maximal spec is a shape admission REJECTS, and a stamp gated on a
//     sub-spec being ABSENT is unreachable from it. Each fixture is asserted to
//     pass validation.ValidateNextAppSpec, so the fixtures cannot drift into
//     impossible shapes; a MINIMAL fixture keeps the absent-branch half
//     reachable; and the collected keys are UNIONED across all of them.
//  2. FIXTURE COMPLETENESS — every LEAF of NextAppSpec (walking structs,
//     pointers, slices and maps of structs) must be non-zero in at least ONE
//     fixture. A new field, however deeply nested, cannot ship without some
//     fixture exercising the branch it gates. The union is what makes this
//     compatible with mutually exclusive fields.
//  3. ANNOTATION KEYS — collected from the builder's output, never enumerated:
//     every `autoscaling.knative.dev/*` key any fixture emits, production or
//     preview, must have an entry in previewDispositions.
//  4. TEMPLATE FIELDS — the knobs stamped as ksvc RevisionSpec FIELDS rather
//     than annotations (containerConcurrency, timeoutSeconds,
//     responseStartTimeoutSeconds, idleTimeoutSeconds) have no prefix to filter
//     on, so they are collected by REFLECTING over RevisionSpec's own fields
//     (skipping the inline PodSpec) and must have an entry in
//     previewTemplateFieldDispositions. Enumerating two of the four is how the
//     third gets missed — which is the #770 mechanism this file exists to stop.
//
// A knob with no entry is a FAILURE, and the message asks the author to DECIDE
// the disposition (force / drop / pass) rather than to append the key.
//
// Every dispositioned knob is asserted OBSERVABLY, aggregated across fixtures:
// a FORCED key must be forced in EVERY fixture and must differ from production
// in at least one (otherwise "forcing" proves nothing); a DROPPED key must be
// absent from every preview run and present in at least one production run; a
// PASSED key must match production in every fixture that stamps it AND equal
// the value some fixture's spec asked for (otherwise both runs can agree on a
// value no user asked for).

// dispositionKind is the fate a preview revision imposes on one scaling knob.
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
	// fromSpec is a value some FIXTURE's spec asks for; only read for
	// dispPassed, where it ties the rendered value back to the user's input.
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

// previewTemplateFieldDispositions covers the knobs stamped as ksvc RevisionSpec
// FIELDS rather than annotations. Which fields exist is NOT enumerated here —
// renderedTemplateFields reflects over RevisionSpec — so a field the builder
// starts rendering with no entry in this table reds the guard.
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
			"a preview keeps whatever production would use",
	},
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// guardFixtureImage is digest-pinned: the operator rejects :latest (security.md).
const guardFixtureImage = "registry.example.com/app:v1@sha256:abc123"

// guardPreviewSpec is the preview block the harness grafts onto every fixture
// for its preview run.
func guardPreviewSpec() *appsv1alpha1.PreviewSpec {
	return &appsv1alpha1.PreviewSpec{Enabled: true, Branch: "feat/x", PRID: "42"}
}

type guardFixture struct {
	name string
	// spec is the PRODUCTION shape; the preview run is this plus
	// guardPreviewSpec().
	spec appsv1alpha1.NextAppSpec
}

// guardFixtures returns the shapes the scan runs over. Together they must cover
// every NextAppSpec leaf (assertFixturesCoverEveryNextAppSpecLeaf); individually
// each must be admission-valid (assertFixturesAreAdmissible).
func guardFixtures() []guardFixture {
	// ROUND-2 SHAPE, deliberately: one all-fields-set fixture. The assertions
	// below report what is wrong with it.
	return []guardFixture{
		{name: "maximal", spec: maximalWarmScheduleSpec()},
	}
}

// maximalScalingSpec sets EVERY ScalingSpec leaf to a non-zero value, so the
// builder takes every "only stamped when explicitly set" branch. Values are
// chosen to differ from the preview-forced ones — see assertDispositions.
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

// maximalWarmScheduleSpec populates every NextAppSpec field EXCEPT Traffic:
// spec.traffic.revisionName (a pinned revision) is mutually exclusive with
// warmSchedule (#393, ADR-0030), so the pinned shape gets its own fixture.
func maximalWarmScheduleSpec() appsv1alpha1.NextAppSpec {
	provisionKafka := true
	networkPolicy := true
	return appsv1alpha1.NextAppSpec{
		Image:   guardFixtureImage,
		Scaling: maximalScalingSpec(),
		Resources: &appsv1alpha1.ResourcesSpec{
			CPURequest: "100m", MemoryRequest: "256Mi", CPULimit: "1", MemoryLimit: "1Gi",
		},
		Storage: &appsv1alpha1.StorageSpec{
			Provider: "gcs", Bucket: "assets", Region: "us-central1",
			Endpoint: "https://storage.googleapis.com",
		},
		Cache: &appsv1alpha1.CacheSpec{
			Provider: "redis", URL: "redis://cache:6379", KeyPrefix: "app",
		},
		Revalidation: &appsv1alpha1.RevalidationSpec{
			Queue: "kafka", KafkaBrokerUrl: "kafka:9092", ProvisionKafkaSource: &provisionKafka,
		},
		Secrets: &appsv1alpha1.SecretsSpec{
			EnvFrom: []string{"app-secrets"},
			EnvMap: map[string]appsv1alpha1.EnvMapEntry{
				"API_TOKEN": {SecretName: "app-secrets", SecretKey: "api-token"},
			},
		},
		Database: &appsv1alpha1.DatabaseSpec{
			SecretRef:   &appsv1alpha1.DatabaseSecretRef{Name: "db-app", Key: "uri"},
			ROSecretRef: &appsv1alpha1.DatabaseSecretRef{Name: "db-app-ro", Key: "uri"},
		},
		Env:             map[string]string{"APP_GREETING": "hello"},
		Observability:   &appsv1alpha1.ObservabilitySpec{Enabled: true},
		HealthCheckPath: "/api/health",
		Runtime:         "node",
		TimeoutSeconds:  111,
		Security:        &appsv1alpha1.SecuritySpec{NetworkPolicy: &networkPolicy},
		BuildID:         "build-1",
		Traffic:         &appsv1alpha1.TrafficSpec{RevisionName: "app-00001", CanaryPercent: 10},
	}
}

// pinnedTrafficSpec is the OTHER side of the #393 exclusivity: a pinned
// revision, hence no warmSchedule. It is what covers the Traffic leaves.
func pinnedTrafficSpec() appsv1alpha1.NextAppSpec {
	return appsv1alpha1.NextAppSpec{
		Image: guardFixtureImage,
		Scaling: &appsv1alpha1.ScalingSpec{
			MinScale: 2, MaxScale: 6, ContainerConcurrency: 42,
		},
		Traffic: &appsv1alpha1.TrafficSpec{RevisionName: "app-00001", CanaryPercent: 10},
	}
}

// minimalSpec is the ONLY-required-fields shape. It is not decoration: a stamp
// gated on a sub-spec being ABSENT (a default-when-unset annotation) is
// unreachable from any populated fixture, and this is the shape that reaches it.
func minimalSpec() appsv1alpha1.NextAppSpec {
	return appsv1alpha1.NextAppSpec{Image: guardFixtureImage}
}

// ---------------------------------------------------------------------------
// Layer 1/2 — the fixtures themselves
// ---------------------------------------------------------------------------

// assertFixturesAreAdmissible keeps the fixtures HONEST: a guard whose baseline
// is a CR the webhook would reject proves things about a shape that can never
// exist on a cluster. Structural, so the constraint cannot be forgotten the next
// time a mutually exclusive pair is added to the API.
func assertFixturesAreAdmissible(t *testing.T) {
	t.Helper()
	for _, f := range guardFixtures() {
		for _, preview := range []bool{false, true} {
			spec := f.spec
			if preview {
				spec.Preview = guardPreviewSpec()
			}
			if err := validation.ValidateNextAppSpec(&spec); err != nil {
				t.Errorf(
					"fixture %q (preview=%v) is ADMISSION-REJECTED: %v — the guard would be "+
						"scanning a shape that can never exist on a cluster. Split the fixture "+
						"(mutually exclusive fields get their own entry in guardFixtures) rather "+
						"than relaxing this check.",
					f.name, preview, err,
				)
			}
		}
	}
}

// assertFixturesCoverEveryNextAppSpecLeaf is the completeness scan: every leaf
// of the NextAppSpec TYPE must be non-zero in at least one fixture. Union, not
// per-fixture, because mutually exclusive fields cannot both be set at once.
func assertFixturesCoverEveryNextAppSpecLeaf(t *testing.T) {
	t.Helper()

	var want []string
	typeLeafPaths("NextAppSpec", reflect.TypeOf(appsv1alpha1.NextAppSpec{}), nil, &want)

	covered := map[string]bool{}
	for _, f := range guardFixtures() {
		spec := f.spec
		spec.Preview = guardPreviewSpec()
		valueLeafPaths("NextAppSpec", reflect.ValueOf(spec), covered)
	}

	for _, path := range want {
		if !covered[path] {
			t.Errorf(
				"%s is zero in EVERY fixture: the builder never takes the branch it gates, so "+
					"any annotation stamped from it escapes the preview disposition guard. Give "+
					"it a non-zero value in one of guardFixtures() "+
					"(preview_annotation_disposition_test.go) — a new fixture if it is mutually "+
					"exclusive with an existing one.",
				path,
			)
		}
	}
}

// typeLeafPaths enumerates every scalar leaf reachable from t. Slice/map element
// types collapse to a single "[]" path, since one populated element is what
// proves the branch runs. seen breaks type cycles.
func typeLeafPaths(path string, t reflect.Type, seen []reflect.Type, out *[]string) {
	for _, s := range seen {
		if s == t {
			return
		}
	}
	seen = append(seen, t)

	switch t.Kind() {
	case reflect.Pointer:
		typeLeafPaths(path, t.Elem(), seen, out)
	case reflect.Struct:
		for i := 0; i < t.NumField(); i++ {
			if !t.Field(i).IsExported() {
				continue
			}
			typeLeafPaths(path+"."+t.Field(i).Name, t.Field(i).Type, seen, out)
		}
	case reflect.Slice, reflect.Array, reflect.Map:
		typeLeafPaths(path+"[]", t.Elem(), seen, out)
	default:
		*out = append(*out, path)
	}
}

// valueLeafPaths records the leaf paths that are NON-ZERO in v, using the same
// path vocabulary as typeLeafPaths.
func valueLeafPaths(path string, v reflect.Value, out map[string]bool) {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if v.IsNil() {
			return
		}
		valueLeafPaths(path, v.Elem(), out)
	case reflect.Struct:
		typ := v.Type()
		for i := 0; i < typ.NumField(); i++ {
			if !typ.Field(i).IsExported() {
				continue
			}
			valueLeafPaths(path+"."+typ.Field(i).Name, v.Field(i), out)
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			valueLeafPaths(path+"[]", v.Index(i), out)
		}
	case reflect.Map:
		for _, k := range v.MapKeys() {
			valueLeafPaths(path+"[]", v.MapIndex(k), out)
		}
	default:
		if !v.IsZero() {
			out[path] = true
		}
	}
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

// buildFixtureKsvc runs buildDesiredKsvc over one fixture, in preview mode or
// not, and returns the rendered ksvc.
func buildFixtureKsvc(t *testing.T, f guardFixture, preview bool) *servingv1.Service {
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

	spec := f.spec
	if preview {
		spec.Preview = guardPreviewSpec()
	}
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec:       spec,
	}
	ksvc := &servingv1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: app.Name, Namespace: app.Namespace},
	}
	if err := r.buildDesiredKsvc(app, ksvc); err != nil {
		t.Fatalf("buildDesiredKsvc(fixture=%s, preview=%v) returned an unexpected error: %v",
			f.name, preview, err)
	}
	return ksvc
}

// fixtureRuns is one fixture's production-vs-preview pair of rendered knobs.
type fixtureRuns struct {
	fixture string
	prod    map[string]string
	preview map[string]string
}

// stampedAutoscalingAnnotations returns only the `autoscaling.knative.dev/*`
// annotations the builder emitted.
func stampedAutoscalingAnnotations(ksvc *servingv1.Service) map[string]string {
	out := map[string]string{}
	for k, v := range ksvc.Spec.Template.ObjectMeta.Annotations {
		if strings.HasPrefix(k, "autoscaling.knative.dev/") {
			out[k] = v
		}
	}
	return out
}

// renderedTemplateFields REFLECTS over servingv1.RevisionSpec's own fields —
// skipping the inline PodSpec, which is container shape rather than a scaling
// knob — and returns every one the builder actually rendered. This is the scan
// that makes a newly-rendered template field (responseStartTimeoutSeconds,
// idleTimeoutSeconds, or whatever Knative adds next) impossible to ship without
// a disposition.
func renderedTemplateFields(ksvc *servingv1.Service) map[string]string {
	rs := ksvc.Spec.Template.Spec
	v := reflect.ValueOf(rs)
	typ := v.Type()

	out := map[string]string{}
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if f.Anonymous || !f.IsExported() {
			continue // the inline corev1.PodSpec
		}
		fv := v.Field(i)
		if fv.Kind() == reflect.Pointer {
			if fv.IsNil() {
				continue // not rendered: Knative's own default applies
			}
			fv = fv.Elem()
		}
		name := strings.Split(f.Tag.Get("json"), ",")[0]
		if name == "" {
			name = f.Name
		}
		out["spec.template.spec."+name] = fmt.Sprint(fv.Interface())
	}
	return out
}

func collectRuns(t *testing.T, collect func(*servingv1.Service) map[string]string) []fixtureRuns {
	t.Helper()
	var runs []fixtureRuns
	for _, f := range guardFixtures() {
		runs = append(runs, fixtureRuns{
			fixture: f.name,
			prod:    collect(buildFixtureKsvc(t, f, false)),
			preview: collect(buildFixtureKsvc(t, f, true)),
		})
	}
	return runs
}

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

func TestPreviewDispositionCoversEveryStampedAutoscalingAnnotation(t *testing.T) {
	assertFixturesAreAdmissible(t)
	assertFixturesCoverEveryNextAppSpecLeaf(t)

	runs := collectRuns(t, stampedAutoscalingAnnotations)
	if len(runs) == 0 || len(runs[0].prod) == 0 {
		t.Fatal("the builder stamped NO autoscaling.knative.dev/* annotations — the collection " +
			"step is broken, so this guard would pass vacuously")
	}

	assertDispositions(t, previewDispositions, runs,
		"buildDesiredKsvc stamps %q but it has NO preview disposition. DECIDE what a preview "+
			"revision should do with it — FORCE it to a preview-safe value, DROP it so the "+
			"Knative cluster default applies, or deliberately PASS the user's value through — "+
			"then record that decision BOTH in previewDispositions "+
			"(preview_annotation_disposition_test.go) and in the disposition list in "+
			"nextapp_controller.go's preview block. Do not just add the key here.")
}

// TestPreviewDispositionCoversScalingTemplateFields is the field-shaped half of
// the same question: containerConcurrency and its siblings are rendered as ksvc
// RevisionSpec fields, so the annotation-prefix scan is structurally blind to
// them.
func TestPreviewDispositionCoversScalingTemplateFields(t *testing.T) {
	runs := collectRuns(t, renderedTemplateFields)

	assertDispositions(t, previewTemplateFieldDispositions, runs,
		"%q is a rendered ksvc template field with NO preview disposition. DECIDE its fate — "+
			"FORCED to a preview-safe value, DROPPED (left nil so Knative's default applies), or "+
			"deliberately PASSED through — then record it in "+
			"previewTemplateFieldDispositions (preview_annotation_disposition_test.go) and in "+
			"nextapp_controller.go's preview disposition list.")
}

// assertDispositions checks a table against the per-fixture runs. Aggregated
// deliberately: a fate must hold in EVERY fixture, and must be OBSERVABLE in at
// least one — so neither a fixture that cannot see the difference nor a fate
// nobody exercises reads as coverage.
func assertDispositions(t *testing.T, table map[string]previewFate, runs []fixtureRuns, undeclared string) {
	t.Helper()

	seen := map[string]struct{}{}
	for _, r := range runs {
		for k := range r.prod {
			seen[k] = struct{}{}
		}
		for k := range r.preview {
			seen[k] = struct{}{}
		}
	}
	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		fate, ok := table[key]
		if !ok {
			t.Errorf(undeclared, key)
			continue
		}

		switch fate.kind {
		case dispForced:
			observable := false
			for _, r := range runs {
				prevVal, inPreview := r.preview[key]
				if !inPreview {
					t.Errorf("[%s] %s: declared FORCED to %q (%s) but preview does not render it",
						r.fixture, key, fate.forced, fate.why)
					continue
				}
				if prevVal != fate.forced {
					t.Errorf("[%s] %s: declared FORCED to %q (%s) but preview rendered %q",
						r.fixture, key, fate.forced, fate.why, prevVal)
				}
				if prodVal, inProd := r.prod[key]; !inProd || prodVal != fate.forced {
					observable = true
				}
			}
			if !observable {
				t.Errorf("%s: declared FORCED to %q, but NO fixture renders a different value in "+
					"production, so the forcing is unobservable — give one fixture a conflicting "+
					"value", key, fate.forced)
			}
		case dispDropped:
			droppedFrom := false
			for _, r := range runs {
				if prevVal, inPreview := r.preview[key]; inPreview {
					t.Errorf("[%s] %s: declared DROPPED (%s) but preview rendered it as %q",
						r.fixture, key, fate.why, prevVal)
				}
				if _, inProd := r.prod[key]; inProd {
					droppedFrom = true
				}
			}
			if !droppedFrom {
				t.Errorf("%s: declared DROPPED but NO fixture renders it in production, so the "+
					"drop is unobservable — give one fixture a value for it", key)
			}
		case dispPassed:
			tied := false
			for _, r := range runs {
				prodVal, inProd := r.prod[key]
				prevVal, inPreview := r.preview[key]
				if inProd != inPreview {
					t.Errorf("[%s] %s: declared PASSED THROUGH (%s) but it is rendered in only "+
						"one run (prod=%v, preview=%v)", r.fixture, key, fate.why, inProd, inPreview)
					continue
				}
				if !inProd {
					continue
				}
				if prodVal != prevVal {
					t.Errorf("[%s] %s: declared PASSED THROUGH (%s) but preview changed it: "+
						"prod=%q preview=%q", r.fixture, key, fate.why, prodVal, prevVal)
				}
				// Both halves: prod==preview alone is satisfied by two runs
				// agreeing on a value NEITHER derived from the user's spec, so
				// some fixture must render the value its spec asked for.
				if prodVal == fate.fromSpec {
					tied = true
				}
			}
			if !tied {
				t.Errorf("%s: declared PASSED THROUGH from the user's spec value %q, but NO "+
					"fixture renders that value in production — the rendered value is not coming "+
					"from the spec at all", key, fate.fromSpec)
			}
		}
	}

	// Keep the table honest in the other direction: an entry for a knob the
	// builder no longer renders is a stale decision that reads as coverage.
	for key := range table {
		if _, ok := seen[key]; !ok {
			t.Errorf("the disposition table has an entry for %q but no fixture renders it — "+
				"remove the stale entry (or fix the fixtures if it should still be rendered)", key)
		}
	}
}
