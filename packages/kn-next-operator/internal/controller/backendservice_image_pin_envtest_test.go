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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// The image pin on a zone's backends[] entry, end to end against a real
// apiserver (ADR-0004 Amendment 3). The threat: a principal with `update` on
// backendservices (and no Secret read, no NextApp write) swaps spec.image of an
// already-bound function, so the operator would mount the zone's database
// Secret into an image they chose. The pin closes it from the zone's side.
// scripts/mutation-prove-2052-backendservice.mjs proves the comparison.

var _ = Describe("BackendService reconciler: the zone's image pin", func() {
	ctx := context.Background()

	withImage := func(image string) func(*appsv1alpha1.BackendService) {
		return func(bs *appsv1alpha1.BackendService) { bs.Spec.Image = image }
	}
	// usesZoneDB: the function reads the zone's own database Secret, which the
	// allowlist permits and which is exactly what a swapped image would inherit.
	usesZoneDB := func(bs *appsv1alpha1.BackendService) {
		bs.Spec.EnvFrom = specEnvFromSecret("orders-db").EnvFrom
	}
	// withStripe adds a second Secret, marked for the zone, so a read of it can fail.
	withStripe := func(bs *appsv1alpha1.BackendService) {
		bs.Spec.EnvFrom = append(bs.Spec.EnvFrom, specEnvFromSecret("stripe").EnvFrom...)
	}
	createStripe := func(ns string) {
		Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
			Name: "stripe", Namespace: ns, Labels: map[string]string{ZoneLabel: "orders"},
		}})).To(Succeed())
	}
	setup := func(pin string, mut ...func(*appsv1alpha1.BackendService)) string {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing", Image: pin})
		createFunction(ctx, ns, "pricing", "orders", append([]func(*appsv1alpha1.BackendService){usesZoneDB}, mut...)...)
		return ns
	}
	ksvcOf := func(ns string) *servingv1.Service {
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, ksvc)).To(Succeed())
		return ksvc
	}
	mountsZoneDB := func(ksvc *servingv1.Service) bool {
		for _, c := range ksvc.Spec.Template.Spec.Containers {
			for _, ef := range c.EnvFrom {
				if ef.SecretRef != nil && ef.SecretRef.Name == "orders-db" {
					return true
				}
			}
		}
		return false
	}
	setZonePin := func(ns, pin string) {
		zone := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "orders"}, zone)).To(Succeed())
		zone.Spec.Backends[0].Image = pin
		Expect(k8sClient.Update(ctx, zone)).To(Succeed())
	}
	setFunctionImage := func(ns, image string) {
		bs := getFunction(ctx, ns, "pricing")
		bs.Spec.Image = image
		Expect(k8sClient.Update(ctx, bs)).To(Succeed())
	}
	ready := func(ns string) *metav1.Condition {
		return functionCondition(getFunction(ctx, ns, "pricing"), ConditionReady)
	}

	It("renders a function whose image digest is the zone's pin", func() {
		ns := setup(pinA, withImage(imageA))
		reconcileFunction(ctx, ns, "pricing")

		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		Expect(mountsZoneDB(ksvcOf(ns))).To(BeTrue())
		bound := functionCondition(getFunction(ctx, ns, "pricing"), ConditionFunctionBound)
		Expect(bound.Status).To(Equal(metav1.ConditionTrue))
	})

	It("refuses a swapped image and removes its Knative Service: nothing mounts the zone's database Secret", func() {
		ns := setup(pinA, withImage(imageA))
		reconcileFunction(ctx, ns, "pricing")
		Expect(mountsZoneDB(ksvcOf(ns))).To(BeTrue(), "precondition: the matching function mounts it")

		By("a principal with only `update` on backendservices swaps the image")
		setFunctionImage(ns, imageB)
		reconcileFunction(ctx, ns, "pricing")

		expectNothingRendered(ctx, ns, "pricing")
		bs := getFunction(ctx, ns, "pricing")
		c := ready(ns)
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonBindingImageMismatch))
		Expect(c.Message).To(ContainSubstring(pinA))
		Expect(c.Message).To(ContainSubstring(pinB))
		Expect(functionCondition(bs, ConditionFunctionBound).Reason).To(Equal(ReasonBindingImageMismatch))
		Expect(bs.Status.URL).To(BeEmpty(), "a refused function advertises no address")
		Expect(functionCondition(bs, ConditionJWKSTrusted).Reason).To(Equal(ReasonJWKSNotRendered))
	})

	It("refuses a bound function that was deleted and re-created with another image", func() {
		ns := setup(pinA, withImage(imageA))
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())

		deleteFunctionAndFinalize(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"})
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeFalse())
		createFunction(ctx, ns, "pricing", "orders", usesZoneDB, withImage(imageB))
		reconcileFunction(ctx, ns, "pricing")

		expectNothingRendered(ctx, ns, "pricing")
		Expect(ready(ns).Reason).To(Equal(ReasonBindingImageMismatch))
	})

	It("never renders a function that is created with the wrong image", func() {
		ns := setup(pinA, withImage(imageB))
		reconcileFunction(ctx, ns, "pricing")

		expectNothingRendered(ctx, ns, "pricing")
		Expect(ready(ns).Reason).To(Equal(ReasonBindingImageMismatch))
	})

	It("keeps today's behaviour with no pin: an image swap rolls out", func() {
		ns := setup("", withImage(imageA))
		reconcileFunction(ctx, ns, "pricing")
		Expect(ksvcOf(ns).Spec.Template.Spec.Containers[0].Image).To(Equal(imageA))

		setFunctionImage(ns, imageB)
		reconcileFunction(ctx, ns, "pricing")

		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		Expect(ksvcOf(ns).Spec.Template.Spec.Containers[0].Image).To(Equal(imageB))
		Expect(ready(ns).Reason).NotTo(Equal(ReasonBindingImageMismatch))
	})

	It("recovers in place once the function returns to the pinned image", func() {
		ns := setup(pinA, withImage(imageA))
		reconcileFunction(ctx, ns, "pricing")
		setFunctionImage(ns, imageB)
		reconcileFunction(ctx, ns, "pricing")
		expectNothingRendered(ctx, ns, "pricing")

		setFunctionImage(ns, imageA)
		reconcileFunction(ctx, ns, "pricing")

		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		Expect(ready(ns).Reason).NotTo(Equal(ReasonBindingImageMismatch))
	})

	// Rotation: the new image and the new pin change together. When the
	// operator sees them already agreeing there is no refusal at any step, so
	// the Knative Service is updated in place: the same object, a new template.
	It("rotates in place when the pin and the image change together", func() {
		ns := setup(pinA, withImage(imageA))
		reconcileFunction(ctx, ns, "pricing")
		before := ksvcOf(ns)

		setZonePin(ns, pinB)
		setFunctionImage(ns, imageB)
		reconcileFunction(ctx, ns, "pricing")

		after := ksvcOf(ns)
		Expect(after.UID).To(Equal(before.UID), "an in-place update, not a teardown and re-create")
		Expect(after.Spec.Template.Spec.Containers[0].Image).To(Equal(imageB))
		Expect(ready(ns).Reason).NotTo(Equal(ReasonBindingImageMismatch))
	})

	// The ordering note the docs carry: two separate writes cannot land in the
	// same instant. Whichever side is written first, the function is refused
	// until the other side follows, then renders again.
	It("refuses between the two writes of a rotation, whichever side goes first, and renders once both agree", func() {
		ns := setup(pinA, withImage(imageA))
		reconcileFunction(ctx, ns, "pricing")

		By("the zone's pin moves first")
		setZonePin(ns, pinB)
		reconcileFunction(ctx, ns, "pricing")
		expectNothingRendered(ctx, ns, "pricing")
		Expect(ready(ns).Reason).To(Equal(ReasonBindingImageMismatch))

		By("the function's image follows")
		setFunctionImage(ns, imageB)
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		Expect(ksvcOf(ns).Spec.Template.Spec.Containers[0].Image).To(Equal(imageB))

		By("the other order: the image moves first")
		setFunctionImage(ns, imageA)
		reconcileFunction(ctx, ns, "pricing")
		expectNothingRendered(ctx, ns, "pricing")
		setZonePin(ns, pinA)
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
	})

	It("a zone that drops its pin falls back to name-only binding", func() {
		ns := setup(pinA, withImage(imageB))
		reconcileFunction(ctx, ns, "pricing")
		expectNothingRendered(ctx, ns, "pricing")

		setZonePin(ns, "")
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
	})

	It("a transient Secret read error with a MATCHING pin leaves a running function as it is", func() {
		ns := setup(pinA, withImage(imageA), withStripe)
		createStripe(ns)
		reconcileFunction(ctx, ns, "pricing")
		running := ksvcOf(ns)

		r := newBSReconciler()
		r.APIReader = &secretMetaFailer{Reader: k8sClient, err: apierrors.NewServiceUnavailable("simulated")}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
		Expect(err).To(HaveOccurred(), "the held error is returned for a retry with backoff")

		Expect(ksvcOf(ns).UID).To(Equal(running.UID), "a read error must not tear a pinned function down")
	})

	It("a swapped image is refused while Secret reads fail too: the mismatch is decided from the specs", func() {
		ns := setup(pinA, withImage(imageA), withStripe)
		createStripe(ns)
		reconcileFunction(ctx, ns, "pricing")
		setFunctionImage(ns, imageB)

		r := newBSReconciler()
		r.APIReader = &secretMetaFailer{Reader: k8sClient, err: apierrors.NewServiceUnavailable("simulated")}
		_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})

		expectNothingRendered(ctx, ns, "pricing")
		Expect(ready(ns).Reason).To(Equal(ReasonBindingImageMismatch))
	})
})

var _ = Describe("NextApp CRD: the backends[].image pin", func() {
	ctx := context.Background()

	create := func(pin string) error {
		ns := bsNamespace(ctx)
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: ns},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    validImageForBS(),
				Backends: []appsv1alpha1.BackendBinding{{Name: "pricing", Service: "pricing", Image: pin}},
			},
		}
		err := k8sClient.Create(ctx, app)
		if err == nil {
			DeferCleanup(deleteAndFinalize, ctx, types.NamespacedName{Namespace: ns, Name: "orders"})
		}
		return err
	}

	It("accepts @sha256:<64 lowercase hex>", func() {
		Expect(create(pinA)).To(Succeed())
	})
	It("accepts an entry with no pin", func() {
		Expect(create("")).To(Succeed())
	})
	DescribeTable("rejects a malformed pin",
		func(pin string) {
			err := create(pin)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("image"))
		},
		Entry("no @ prefix", "sha256:"+pinDigestA),
		Entry("a full image reference, not a digest", "registry.example.com/fn"+pinA),
		Entry("a tag", ":v1"),
		Entry("too short", "@sha256:abc123"),
		Entry("too long", pinA+"0"),
		Entry("uppercase hex", "@sha256:"+"ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC1"),
		Entry("another algorithm", "@sha512:"+pinDigestA),
		Entry("non-hex characters", "@sha256:zzz123def456abc123def456abc123def456abc123def456abc123def456abc1"),
		Entry("trailing newline", pinA+"\n"),
	)
})
