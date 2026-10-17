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
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The spec pin on a zone's backends[] entry (ADR-0004 Amendment 4): the zone
// pins a digest of everything in the BackendService that decides what code runs
// and what it can read, not only the image. The comparison is positive evidence
// read from the two specs (never from a Secret or an apiserver answer), so a
// mismatch refuses the function like any other refusal and a transient read
// error can never produce one.
// scripts/mutation-prove-2052-backendservice.mjs proves each rule below.

const specVectorsFile = "testdata/backend-spec-digest-vectors.json"

type specVector struct {
	Name      string          `json:"name"`
	Spec      json.RawMessage `json:"spec"`
	Canonical string          `json:"canonical"`
	Digest    string          `json:"digest"`
}

type specVectorFile struct {
	Domain  string       `json:"domain"`
	Vectors []specVector `json:"vectors"`
}

func readSpecVectors(t *testing.T) specVectorFile {
	t.Helper()
	raw, err := os.ReadFile(specVectorsFile)
	if err != nil {
		t.Fatalf("reading %s: %v", specVectorsFile, err)
	}
	var f specVectorFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parsing %s: %v", specVectorsFile, err)
	}
	if len(f.Vectors) == 0 {
		t.Fatalf("%s carries no vectors", specVectorsFile)
	}
	return f
}

// The same file is recomputed by the CLI (packages/grpc/src/__tests__/
// spec-digest.test.ts). Both sides must produce the canonical text and the
// digest the file records, or the zone's pin could never match.
func TestSpecDigestVectors(t *testing.T) {
	f := readSpecVectors(t)
	if f.Domain != specDigestDomain {
		t.Fatalf("the vectors' domain %q is not the operator's %q", f.Domain, specDigestDomain)
	}
	for _, v := range f.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var spec appsv1alpha1.BackendServiceSpec
			if err := json.Unmarshal(v.Spec, &spec); err != nil {
				t.Fatalf("decoding the vector's spec: %v", err)
			}
			canonical, err := canonicalBackendSpec(&spec)
			if err != nil {
				t.Fatalf("canonicalBackendSpec: %v", err)
			}
			if canonical != v.Canonical {
				t.Errorf("canonical form differs.\n got: %s\nwant: %s", canonical, v.Canonical)
			}
			digest, err := backendSpecDigest(&spec)
			if err != nil {
				t.Fatalf("backendSpecDigest: %v", err)
			}
			if digest != v.Digest {
				t.Errorf("digest = %s, want %s", digest, v.Digest)
			}
		})
	}
}

func baseSpec() appsv1alpha1.BackendServiceSpec {
	return appsv1alpha1.BackendServiceSpec{Zone: "orders", Image: imageA}
}

func digestOf(t *testing.T, spec appsv1alpha1.BackendServiceSpec) string {
	t.Helper()
	d, err := backendSpecDigest(&spec)
	if err != nil {
		t.Fatalf("backendSpecDigest: %v", err)
	}
	return d
}

func TestSpecDigestShape(t *testing.T) {
	d := digestOf(t, baseSpec())
	if !strings.HasPrefix(d, "sha256:") || len(d) != len("sha256:")+64 {
		t.Fatalf("digest %q is not sha256:<64 hex>", d)
	}
	if d != strings.ToLower(d) {
		t.Fatalf("digest %q must be lower case", d)
	}
}

func TestSpecPinMismatch(t *testing.T) {
	plain := baseSpec()
	pin := digestOf(t, plain)

	withEnv := plain
	withEnv.Env = []corev1.EnvVar{{Name: "NODE_OPTIONS", Value: "--import=data:text/javascript,1"}}
	withEnvFrom := plain
	withEnvFrom.EnvFrom = specEnvFromSecret("orders-db").EnvFrom
	withVolume := plain
	withVolume.Volumes = specSecretVolume("orders-db").Volumes
	otherImage := plain
	otherImage.Image = imageB

	cases := []struct {
		name         string
		pin          string
		spec         appsv1alpha1.BackendServiceSpec
		wantMismatch bool
	}{
		{"no pin keeps today's behaviour", "", withEnv, false},
		{"a matching spec", pin, plain, false},
		{"env added under a pinned spec", pin, withEnv, true},
		{"envFrom added under a pinned spec", pin, withEnvFrom, true},
		{"a volume added under a pinned spec", pin, withVolume, true},
		{"a different image", pin, otherImage, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := specPinMismatch(tc.pin, &tc.spec)
			if (got != "") != tc.wantMismatch {
				t.Fatalf("specPinMismatch = %q, want mismatch=%v", got, tc.wantMismatch)
			}
		})
	}
}

func TestSpecPinIgnoresWhatDoesNotDecideCodeOrReads(t *testing.T) {
	plain := baseSpec()
	pin := digestOf(t, plain)

	tuned := plain
	tuned.Language = "go"
	tuned.Port = 9090
	tuned.ProtoVersion = "2.0.0"
	tuned.WakeAhead = ptr.To(false)
	tuned.Scaling = &appsv1alpha1.FunctionScalingSpec{MinScale: 1, MaxScale: 4, ContainerConcurrency: 8}
	tuned.Resources = &appsv1alpha1.ResourcesSpec{CPURequest: "100m", MemoryLimit: "128Mi"}
	tuned.ImagePullSecrets = []corev1.LocalObjectReference{{Name: "regcred"}}
	if got := specPinMismatch(pin, &tuned); got != "" {
		t.Fatalf("tuning a function (port, scaling, resources, protoVersion, pull secrets) must not need a re-pin: %q", got)
	}
}

// Order is part of the digest: env order decides $(VAR) expansion and envFrom
// order decides which source wins a key collision, so a reorder is a change.
func TestSpecDigestIsOrderSensitiveForLists(t *testing.T) {
	a := baseSpec()
	a.Env = []corev1.EnvVar{{Name: "A", Value: "1"}, {Name: "B", Value: "$(A)"}}
	b := baseSpec()
	b.Env = []corev1.EnvVar{{Name: "B", Value: "$(A)"}, {Name: "A", Value: "1"}}
	if digestOf(t, a) == digestOf(t, b) {
		t.Fatal("reordering env must change the digest")
	}
	c := baseSpec()
	c.EnvFrom = append(specEnvFromSecret("one").EnvFrom, specEnvFromSecret("two").EnvFrom...)
	d := baseSpec()
	d.EnvFrom = append(specEnvFromSecret("two").EnvFrom, specEnvFromSecret("one").EnvFrom...)
	if digestOf(t, c) == digestOf(t, d) {
		t.Fatal("reordering envFrom must change the digest")
	}
}

func TestSpecDigestEveryHashedFieldMatters(t *testing.T) {
	base := baseSpec()
	base.Env = []corev1.EnvVar{{Name: "A", Value: "1"}}
	base.EnvFrom = specEnvFromSecret("orders-db").EnvFrom
	base.Volumes = specSecretVolume("orders-db").Volumes
	ref := digestOf(t, base)

	mutations := map[string]func(*appsv1alpha1.BackendServiceSpec){
		"env value":          func(s *appsv1alpha1.BackendServiceSpec) { s.Env[0].Value = "2" },
		"env name":           func(s *appsv1alpha1.BackendServiceSpec) { s.Env[0].Name = "Z" },
		"envFrom secret":     func(s *appsv1alpha1.BackendServiceSpec) { s.EnvFrom[0].SecretRef.Name = "stripe" },
		"envFrom prefix":     func(s *appsv1alpha1.BackendServiceSpec) { s.EnvFrom[0].Prefix = "X_" },
		"volume secret":      func(s *appsv1alpha1.BackendServiceSpec) { s.Volumes[0].Secret.SecretName = "stripe" },
		"volume mountPath":   func(s *appsv1alpha1.BackendServiceSpec) { s.Volumes[0].MountPath = "/elsewhere" },
		"volume defaultMode": func(s *appsv1alpha1.BackendServiceSpec) { s.Volumes[0].Secret.DefaultMode = ptr.To(int32(0)) },
		"image":              func(s *appsv1alpha1.BackendServiceSpec) { s.Image = imageB },
		"image tag":          func(s *appsv1alpha1.BackendServiceSpec) { s.Image = "registry.example.com/fn:v2@sha256:" + pinDigestA },
		"image registry":     func(s *appsv1alpha1.BackendServiceSpec) { s.Image = "mirror.example.org/fn:v1@sha256:" + pinDigestA },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			s := *base.DeepCopy()
			mutate(&s)
			if digestOf(t, s) == ref {
				t.Fatalf("changing %s must change the digest", name)
			}
		})
	}
}

func TestSpecPinMismatchNamesBothDigests(t *testing.T) {
	plain := baseSpec()
	pin := digestOf(t, plain)
	changed := plain
	changed.Env = []corev1.EnvVar{{Name: "X", Value: "1"}}
	msg := specPinMismatch(pin, &changed)
	for _, want := range []string{pin, digestOf(t, changed), "spec"} {
		if !strings.Contains(msg, want) {
			t.Errorf("the mismatch message must contain %q so the owner can act on it: %q", want, msg)
		}
	}
}

// A spec that cannot be canonicalised is not a pass. (The canonical form takes
// integers only; the typed spec cannot carry anything else, so this is the
// guard against the encoder being extended carelessly.)
func TestCanonicalEncoderRejectsWhatItCannotEncode(t *testing.T) {
	if _, err := canonicalValue(1.5); err == nil {
		t.Fatal("a fractional number has no canonical encoding and must be refused")
	}
	if _, err := canonicalValue(nil); err == nil {
		t.Fatal("a bare null has no canonical encoding and must be refused")
	}
}

func specMismatchObservation() functionObservation {
	o := acceptedObservation(zoneJWKSControlled, "")
	live := baseSpec()
	live.Env = []corev1.EnvVar{{Name: "NODE_OPTIONS", Value: "--import=x"}}
	o.specMismatch = specPinMismatch(mustDigest(baseSpec()), &live)
	return o
}

func mustDigest(s appsv1alpha1.BackendServiceSpec) string {
	d, err := backendSpecDigest(&s)
	if err != nil {
		panic(err)
	}
	return d
}

func TestASpecMismatchIsNotAccepted(t *testing.T) {
	if !acceptedObservation(zoneJWKSControlled, "").accepted() {
		t.Fatal("control: the matching observation must be accepted")
	}
	if specMismatchObservation().accepted() {
		t.Fatal("a function whose spec is not the zone's pin must not be accepted: nothing may render or mount")
	}
}

func TestASpecMismatchIsDecidedEvenWhenASecretReadFails(t *testing.T) {
	o := specMismatchObservation()
	o.unverified = []unverifiedSecret{{name: "stripe", err: "timeout"}}
	if o.undecided() {
		t.Fatal("a mismatched function must not be held as undecided: the mismatch is a definitive refusal")
	}
}

func TestVerdictForASpecMismatchIsBindingSpecMismatch(t *testing.T) {
	v := computeBackendServiceVerdict(jwksBS(), specMismatchObservation())

	bound := verdictCondition(t, v, ConditionFunctionBound)
	if bound.Status != metav1.ConditionFalse || bound.Reason != ReasonBindingSpecMismatch {
		t.Fatalf("Bound = %s/%s, want False/%s", bound.Status, bound.Reason, ReasonBindingSpecMismatch)
	}
	ready := verdictCondition(t, v, ConditionReady)
	if ready.Status != metav1.ConditionFalse || ready.Reason != ReasonBindingSpecMismatch {
		t.Fatalf("Ready = %s/%s, want False/%s", ready.Status, ready.Reason, ReasonBindingSpecMismatch)
	}
	if v.refusal != ReasonBindingSpecMismatch {
		t.Errorf("a function newly entering the refusal must be counted as one: refusal = %q", v.refusal)
	}
	if len(v.events) == 0 {
		t.Error("the refusal must raise a Warning event")
	}
	jwks := verdictCondition(t, v, ConditionJWKSTrusted)
	if jwks.Reason != ReasonJWKSNotRendered {
		t.Errorf("a refused function mounts no JWKS: JWKSTrusted reason = %s, want %s", jwks.Reason, ReasonJWKSNotRendered)
	}
}

// When both pins are set and the image is the part that moved, the image-only
// reason is the more specific one and wins; the function is refused either way.
func TestAnImageMismatchOutranksASpecMismatch(t *testing.T) {
	o := specMismatchObservation()
	o.imageMismatch = imagePinMismatch(pinA, imageB)
	v := computeBackendServiceVerdict(jwksBS(), o)
	if got := verdictCondition(t, v, ConditionFunctionBound).Reason; got != ReasonBindingImageMismatch {
		t.Fatalf("Bound reason = %s, want %s", got, ReasonBindingImageMismatch)
	}
}

func TestTheSpecRefusalIsCountedUnderItsOwnReason(t *testing.T) {
	for _, r := range backendServiceRefusalReasons {
		if r == ReasonBindingSpecMismatch {
			return
		}
	}
	t.Fatalf("%s must be a pre-registered reason of the refusals counter", ReasonBindingSpecMismatch)
}

// ---- field coverage ---------------------------------------------------------

// specPinMutators sets ONE field of BackendServiceSpec to a different, valid
// value. The coverage guard below requires an entry for every field the type
// has, so a new field cannot be added without this file (and the lists in
// backendservice_spec_pin.go) being touched in the same change.
var specPinMutators = map[string]func(*appsv1alpha1.BackendServiceSpec){
	"zone":         func(s *appsv1alpha1.BackendServiceSpec) { s.Zone = "billing" },
	"image":        func(s *appsv1alpha1.BackendServiceSpec) { s.Image = imageB },
	"language":     func(s *appsv1alpha1.BackendServiceSpec) { s.Language = "rust" },
	"port":         func(s *appsv1alpha1.BackendServiceSpec) { s.Port = 9191 },
	"protoVersion": func(s *appsv1alpha1.BackendServiceSpec) { s.ProtoVersion = "9.9.9" },
	"wakeAhead":    func(s *appsv1alpha1.BackendServiceSpec) { s.WakeAhead = ptr.To(false) },
	"scaling": func(s *appsv1alpha1.BackendServiceSpec) {
		s.Scaling = &appsv1alpha1.FunctionScalingSpec{MinScale: 1, MaxScale: 3, ContainerConcurrency: 7}
	},
	"resources": func(s *appsv1alpha1.BackendServiceSpec) {
		s.Resources = &appsv1alpha1.ResourcesSpec{CPURequest: "250m", MemoryLimit: "512Mi"}
	},
	"env": func(s *appsv1alpha1.BackendServiceSpec) {
		s.Env = []corev1.EnvVar{{Name: "NODE_OPTIONS", Value: "--import=data:text/javascript,1"}}
	},
	"envFrom": func(s *appsv1alpha1.BackendServiceSpec) { s.EnvFrom = specEnvFromSecret("stripe").EnvFrom },
	"volumes": func(s *appsv1alpha1.BackendServiceSpec) { s.Volumes = specSecretVolume("stripe").Volumes },
	"imagePullSecrets": func(s *appsv1alpha1.BackendServiceSpec) {
		s.ImagePullSecrets = []corev1.LocalObjectReference{{Name: "regcred"}}
	},
}

func specJSONFields(t *testing.T) []string {
	t.Helper()
	typ := reflect.TypeOf(appsv1alpha1.BackendServiceSpec{})
	var names []string
	for i := 0; i < typ.NumField(); i++ {
		tag := typ.Field(i).Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			t.Fatalf("BackendServiceSpec.%s has no json name: the pin cannot classify it", typ.Field(i).Name)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func specPinSortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func renderedFunction(t *testing.T, spec appsv1alpha1.BackendServiceSpec) string {
	t.Helper()
	bs := &appsv1alpha1.BackendService{
		ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: "shop"},
		Spec:       spec,
	}
	objs, err := RenderFunctionObjects(bs, 0)
	if err != nil {
		t.Fatalf("RenderFunctionObjects: %v", err)
	}
	raw, err := json.Marshal(objs)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// THE FIELD COVERAGE GUARD. Every BackendServiceSpec field is either bound by
// the spec pin or on a reviewed exclusion list with a reason. A field added to
// the type fails this test until someone decides which, so a field that reaches
// the pod cannot silently escape the pin.
func TestEveryBackendServiceSpecFieldIsBoundOrReviewed(t *testing.T) {
	fields := specJSONFields(t)

	hashed := map[string]bool{}
	for _, f := range specPinHashedFields {
		if hashed[f] {
			t.Errorf("%q is listed twice in specPinHashedFields", f)
		}
		hashed[f] = true
	}
	for _, f := range fields {
		_, excluded := specPinExcludedFields[f]
		switch {
		case hashed[f] && excluded:
			t.Errorf("field %q is both hashed and excluded: decide one", f)
		case !hashed[f] && !excluded:
			t.Errorf("BackendServiceSpec.%s is neither in specPinHashedFields nor on the reviewed "+
				"specPinExcludedFields list: a field that reaches the pod must be bound by the spec pin, "+
				"or excluded with a reason someone reviewed", f)
		}
		if _, ok := specPinMutators[f]; !ok {
			t.Errorf("BackendServiceSpec.%s has no entry in specPinMutators (this test file): add one", f)
		}
	}
	known := map[string]bool{}
	for _, f := range fields {
		known[f] = true
	}
	for f := range hashed {
		if !known[f] {
			t.Errorf("specPinHashedFields names %q, which BackendServiceSpec does not have (stale entry)", f)
		}
	}
	for _, f := range specPinSortedKeys(specPinExcludedFields) {
		if !known[f] {
			t.Errorf("specPinExcludedFields names %q, which BackendServiceSpec does not have (stale entry)", f)
		}
	}
	for _, f := range specPinSortedKeys(specPinMutators) {
		if !known[f] {
			t.Errorf("specPinMutators names %q, which BackendServiceSpec does not have (stale entry)", f)
		}
	}
}

func TestEveryExclusionCarriesAReviewedReason(t *testing.T) {
	classes := map[string]bool{exclusionNotRendered: true, exclusionOperational: true, exclusionBindingIdentity: true}
	for f, ex := range specPinExcludedFields {
		if !classes[ex.Class] {
			t.Errorf("exclusion %q has class %q, want one of notRendered|operational|bindingIdentity", f, ex.Class)
		}
		if len(strings.Fields(ex.Reason)) < 6 {
			t.Errorf("exclusion %q needs a real reason (a sentence), got %q", f, ex.Reason)
		}
	}
}

// The classification is checked against behaviour, not only against names:
//   - a HASHED field changes the digest when it changes;
//   - an excluded field leaves the digest alone;
//   - a field excluded as notRendered must truly change nothing the operator
//     renders for the function (so the reason "it does not reach the pod" is
//     true), and an operational/identity exclusion must reach the pod (or it
//     would be notRendered).
func TestFieldClassificationMatchesWhatTheOperatorRenders(t *testing.T) {
	base := baseSpec()
	baseDigest := digestOf(t, base)
	baseRender := renderedFunction(t, base)
	for _, f := range specJSONFields(t) {
		mutate := specPinMutators[f]
		if mutate == nil {
			continue // reported by the coverage test
		}
		t.Run(f, func(t *testing.T) {
			s := *base.DeepCopy()
			mutate(&s)
			digestMoved := digestOf(t, s) != baseDigest
			renderMoved := renderedFunction(t, s) != baseRender
			ex, excluded := specPinExcludedFields[f]
			switch {
			case !excluded:
				if !digestMoved {
					t.Errorf("field %q is listed as hashed but changing it does not change the digest", f)
				}
			case ex.Class == exclusionNotRendered:
				if digestMoved {
					t.Errorf("field %q is excluded but changing it changes the digest", f)
				}
				if renderMoved {
					t.Errorf("field %q is excluded as notRendered but changing it changes what the operator renders: "+
						"it reaches the pod, so it must be hashed or reclassified with a reviewed reason", f)
				}
			default:
				if digestMoved {
					t.Errorf("field %q is excluded but changing it changes the digest", f)
				}
				if !renderMoved {
					t.Errorf("field %q is excluded as %s, which says it reaches the pod, but changing it renders "+
						"nothing different: reclassify it as notRendered", f, ex.Class)
				}
			}
		})
	}
}

// An excluded struct-typed field is only ever numbers, strings and bools. If
// someone adds a list, a map or a nested object to scaling or resources, that
// could carry env-like content past the pin, so it must be reviewed.
func TestExcludedStructFieldsCarryOnlyScalars(t *testing.T) {
	typ := reflect.TypeOf(appsv1alpha1.BackendServiceSpec{})
	for i := 0; i < typ.NumField(); i++ {
		name := strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]
		ex, excluded := specPinExcludedFields[name]
		if !excluded {
			continue
		}
		ft := typ.Field(i).Type
		for ft.Kind() == reflect.Ptr {
			ft = ft.Elem()
		}
		switch ft.Kind() {
		case reflect.Struct:
			for j := 0; j < ft.NumField(); j++ {
				switch ft.Field(j).Type.Kind() {
				case reflect.String, reflect.Bool, reflect.Int, reflect.Int32, reflect.Int64:
				default:
					t.Errorf("excluded field %q (%s) has %s of kind %s: only scalars may be excluded without "+
						"another review; hash it or extend this guard deliberately", name, ex.Class, ft.Field(j).Name, ft.Field(j).Type.Kind())
				}
			}
		case reflect.Slice, reflect.Map:
			// imagePullSecrets: a list of names; reviewed individually in its reason.
			if name != "imagePullSecrets" {
				t.Errorf("excluded field %q is a %s: only imagePullSecrets is a reviewed excluded collection", name, ft.Kind())
			}
		}
	}
}

// ---- nothing is rendered into the zone ---------------------------------------

// The spec pin lives only on the zone's spec. Like the image pin it must change
// nothing the operator renders into the zone: deploying a new function spec must
// never roll a zone revision, and a pin must never reach the zone's pod.
func TestASpecPinChangesNothingRenderedIntoTheZone(t *testing.T) {
	bs := &appsv1alpha1.BackendService{
		ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: "default"},
		Spec: appsv1alpha1.BackendServiceSpec{
			Zone: "orders", Image: imageA, ProtoVersion: "1.0.0", WakeAhead: ptr.To(true),
		},
		Status: appsv1alpha1.BackendServiceStatus{ServedProtoVersion: "1.0.0"},
	}
	render := func(entry appsv1alpha1.BackendBinding, fn *appsv1alpha1.BackendService) string {
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: "default", Generation: 1},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    "registry.example.com/app:v1@sha256:" + pinDigestA,
				Backends: []appsv1alpha1.BackendBinding{entry},
			},
		}
		return renderZoneKnativeService(t, app, fn)
	}
	plain := render(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"}, bs)
	if !strings.Contains(plain, "PRICING_SERVICE_URL") {
		t.Fatalf("control: the bound function must render its URL into the zone:\n%s", plain)
	}
	live := mustDigest(bs.Spec)
	otherSpec := bs.Spec.DeepCopy()
	otherSpec.Env = []corev1.EnvVar{{Name: "X", Value: "1"}}
	other := mustDigest(*otherSpec)
	for _, pin := range []string{live, other} {
		if strings.Contains(plain, strings.TrimPrefix(pin, "sha256:")) {
			t.Fatal("control: the digest the test pins must not already appear in the render")
		}
		got := render(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing", SpecDigest: pin}, bs)
		if got != plain {
			t.Fatalf("the zone's Knative Service changed with spec pin %s.\n--- without a pin\n%s\n--- with it\n%s", pin, plain, got)
		}
		if strings.Contains(got, strings.TrimPrefix(pin, "sha256:")) {
			t.Fatalf("the spec pin %s reached the zone's rendered Knative Service", pin)
		}
	}
	// Changing the function's env changes nothing in the zone either.
	changed := bs.DeepCopy()
	changed.Spec.Env = otherSpec.Env
	if got := render(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing", SpecDigest: live}, changed); got != plain {
		t.Fatalf("a function env change changed the zone's Knative Service:\n--- before\n%s\n--- after\n%s", plain, got)
	}
}
