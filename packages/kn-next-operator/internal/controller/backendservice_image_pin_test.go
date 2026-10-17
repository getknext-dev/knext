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
	"context"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The image pin on a zone's backends[] entry (ADR-0004 Amendment 3): the zone
// names WHICH image it agreed to bind, not only which name. The comparison is
// positive evidence read from the specs (never from a Secret or an apiserver
// answer), so a mismatch refuses the function like any other refusal and a
// transient read error can never produce one.
// scripts/mutation-prove-2052-backendservice.mjs proves each rule below.

const (
	pinDigestA = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	pinDigestB = "fff123def456abc123def456abc123def456abc123def456abc123def456abc2"
	pinDigestC = "eee999def456abc123def456abc123def456abc123def456abc123def456abc3"
	pinA       = "@sha256:" + pinDigestA
	pinB       = "@sha256:" + pinDigestB
	pinC       = "@sha256:" + pinDigestC
	imageA     = "registry.example.com/fn:v1@sha256:" + pinDigestA
	imageB     = "registry.example.com/fn:v1@sha256:" + pinDigestB
)

func TestImagePinMismatch(t *testing.T) {
	cases := []struct {
		name         string
		pin, image   string
		wantMismatch bool
	}{
		{"no pin keeps today's behaviour", "", imageA, false},
		{"no pin, any image", "", imageB, false},
		{"matching digest", pinA, imageA, false},
		{"the registry path may differ, the content may not", pinA, "mirror.example.org/other/name@sha256:" + pinDigestA, false},
		{"another digest", pinA, imageB, true},
		{"a tag-only image has no digest to compare: fail closed", pinA, "registry.example.com/fn:v1", true},
		{"a tag that merely contains the digest text is not a digest", pinA, "registry.example.com/fn:sha256-" + pinDigestA, true},
		{"two digests in one reference: fail closed", pinA, imageB + pinA, true},
		{"uppercase hex is not the pinned digest", pinA, "registry.example.com/fn@sha256:" + strings.ToUpper(pinDigestA), true},
		{"a longer digest that starts with the pin", pinA, imageA + "0", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := imagePinMismatch(tc.pin, tc.image)
			if (got != "") != tc.wantMismatch {
				t.Fatalf("imagePinMismatch(%q, %q) = %q, want mismatch=%v", tc.pin, tc.image, got, tc.wantMismatch)
			}
		})
	}
}

func TestImagePinMismatchNamesBothDigests(t *testing.T) {
	msg := imagePinMismatch(pinA, imageB)
	for _, want := range []string{pinA, pinB} {
		if !strings.Contains(msg, want) {
			t.Errorf("the mismatch message must name %s so the owner can act on it: %q", want, msg)
		}
	}
}

func mismatchObservation() functionObservation {
	o := acceptedObservation(zoneJWKSControlled, "")
	o.imageMismatch = imagePinMismatch(pinA, imageB)
	return o
}

func TestAMismatchIsNotAccepted(t *testing.T) {
	if !acceptedObservation(zoneJWKSControlled, "").accepted() {
		t.Fatal("control: the matching observation must be accepted")
	}
	if mismatchObservation().accepted() {
		t.Fatal("a function whose image is not the zone's pin must not be accepted: nothing may render or mount")
	}
}

// A function that would be accepted but for unreadable Secrets is held, never
// torn down. A mismatch is not an unreadable anything: it is decided from the
// specs, so the function is refused even while a Secret read errors.
func TestAMismatchIsDecidedEvenWhenASecretReadFails(t *testing.T) {
	o := mismatchObservation()
	o.unverified = []unverifiedSecret{{name: "stripe", err: "timeout"}}
	if o.undecided() {
		t.Fatal("a mismatched function must not be held as undecided: the mismatch is a definitive refusal")
	}
	o = acceptedObservation(zoneJWKSControlled, "")
	o.unverified = []unverifiedSecret{{name: "stripe", err: "timeout"}}
	if !o.undecided() {
		t.Fatal("control: with no mismatch the same unreadable Secret still holds the function")
	}
}

func TestVerdictForAMismatchIsBindingImageMismatch(t *testing.T) {
	v := computeBackendServiceVerdict(jwksBS(), mismatchObservation())

	bound := verdictCondition(t, v, ConditionFunctionBound)
	if bound.Status != metav1.ConditionFalse || bound.Reason != ReasonBindingImageMismatch {
		t.Fatalf("Bound = %s/%s, want False/%s", bound.Status, bound.Reason, ReasonBindingImageMismatch)
	}
	for _, want := range []string{pinA, pinB} {
		if !strings.Contains(bound.Message, want) {
			t.Errorf("Bound message must name %s: %q", want, bound.Message)
		}
	}
	ready := verdictCondition(t, v, ConditionReady)
	if ready.Status != metav1.ConditionFalse || ready.Reason != ReasonBindingImageMismatch {
		t.Fatalf("Ready = %s/%s, want False/%s", ready.Status, ready.Reason, ReasonBindingImageMismatch)
	}
	if v.refusal != ReasonBindingImageMismatch {
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

func TestTheRefusalIsCountedUnderItsOwnReason(t *testing.T) {
	for _, r := range backendServiceRefusalReasons {
		if r == ReasonBindingImageMismatch {
			return
		}
	}
	t.Fatalf("%s must be a pre-registered reason of the refusals counter", ReasonBindingImageMismatch)
}

// renderZoneKnativeService drives one real Reconcile of the zone, with the
// function in the namespace, and returns the zone's Knative Service serialised.
// (renderApp renders every child, which includes the per-zone signing key and
// key set; those are random by design and are not what a pin could change.)
func renderZoneKnativeService(t *testing.T, app *appsv1alpha1.NextApp, objs ...client.Object) string {
	t.Helper()
	scheme := goldenTestScheme(t, false)
	all := []client.Object{app.DeepCopy()}
	for _, o := range objs {
		all = append(all, o.DeepCopyObject().(client.Object))
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(all...).
		WithStatusSubresource(&appsv1alpha1.NextApp{}).Build()
	r := &NextAppReconciler{
		Client:                   c,
		Scheme:                   scheme,
		Clock:                    func() time.Time { return goldenClock },
		BackendServiceCRDPresent: true,
	}
	ctx := context.Background()
	if _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: app.Name, Namespace: app.Namespace}}); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	ksvcs := listKind(t, ctx, c, scheme, "Service", app.Namespace)
	if len(ksvcs) != 1 {
		t.Fatalf("want exactly the zone's Knative Service, got %d", len(ksvcs))
	}
	return string(marshalNormalized(t, scheme, ksvcs[0]))
}

// The pin lives only on the zone's spec. It must change nothing the operator
// renders into the zone: deploying a new function image must never roll a zone
// revision, and a pin must never reach the zone's pod environment.
func TestAPinChangesNothingRenderedIntoTheZone(t *testing.T) {
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
	if strings.Contains(plain, pinDigestC) {
		t.Fatal("control: the digest the test pins must not already appear in the render")
	}
	// Pins matching the function's image, differing from it, and one the whole
	// render has never seen: none may change a byte.
	for _, pin := range []string{pinA, pinB, pinC} {
		got := render(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing", Image: pin}, bs)
		if got != plain {
			t.Fatalf("the zone's Knative Service changed with image pin %s.\n--- without a pin\n%s\n--- with it\n%s", pin, plain, got)
		}
	}
	// And deploying another function image changes nothing in the zone either.
	swapped := bs.DeepCopy()
	swapped.Spec.Image = imageB
	if got := render(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing", Image: pinA}, swapped); got != plain {
		t.Fatalf("a function image swap changed the zone's Knative Service:\n--- before\n%s\n--- after\n%s", plain, got)
	}
}
