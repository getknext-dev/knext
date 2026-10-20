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

// The spec pin on a zone's backends[] entry, end to end against a real
// apiserver (ADR-0004 Amendment 4). The threat the image pin left open: a
// principal with only `update` on backendservices keeps the pinned digest and
// adds env (NODE_OPTIONS=--import=...), envFrom or a volume, so their code runs
// inside the pinned image with the zone's database Secret mounted. The spec pin
// binds those too.
// scripts/mutation-prove-2052-backendservice.mjs proves the comparison.

var _ = Describe("BackendService reconciler: the zone's spec pin", func() {
	ctx := context.Background()

	// usesZoneDB: the function reads the zone's own database Secret, which the
	// allowlist permits and which is exactly what an injected env would inherit.
	usesZoneDB := func(bs *appsv1alpha1.BackendService) {
		bs.Spec.EnvFrom = specEnvFromSecret("orders-db").EnvFrom
		bs.Spec.Image = imageA
	}
	createStripe := func(ns string) {
		Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
			Name: "stripe", Namespace: ns, Labels: map[string]string{ZoneLabel: "orders"},
		}})).To(Succeed())
	}
	digestOfLive := func(ns string) string {
		d, err := backendSpecDigest(&getFunction(ctx, ns, "pricing").Spec)
		Expect(err).NotTo(HaveOccurred())
		return d
	}
	// setup creates the zone and the function, then pins the function's spec as
	// it is stored. A pin of "" leaves the zone with the name-only binding.
	setup := func(pinLive bool, mut ...func(*appsv1alpha1.BackendService)) string {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders", append([]func(*appsv1alpha1.BackendService){usesZoneDB}, mut...)...)
		if pinLive {
			setZoneSpecPin(ctx, ns, digestOfLive(ns))
		}
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
	editFunction := func(ns string, mut func(*appsv1alpha1.BackendService)) {
		bs := getFunction(ctx, ns, "pricing")
		mut(bs)
		Expect(k8sClient.Update(ctx, bs)).To(Succeed())
	}
	injectEnv := func(bs *appsv1alpha1.BackendService) {
		bs.Spec.Env = append(bs.Spec.Env, corev1.EnvVar{
			Name: "NODE_OPTIONS", Value: "--import=data:text/javascript,console.log(process.env)",
		})
	}
	ready := func(ns string) *metav1.Condition {
		return functionCondition(getFunction(ctx, ns, "pricing"), ConditionReady)
	}
	expectSpecRefusal := func(ns, pin string) {
		expectNothingRendered(ctx, ns, "pricing")
		bs := getFunction(ctx, ns, "pricing")
		c := ready(ns)
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonBindingSpecMismatch))
		Expect(c.Message).To(ContainSubstring(pin))
		Expect(c.Message).To(ContainSubstring(digestOfLive(ns)), "the message names the digest the live spec has")
		Expect(functionCondition(bs, ConditionFunctionBound).Reason).To(Equal(ReasonBindingSpecMismatch))
		Expect(bs.Status.URL).To(BeEmpty(), "a refused function advertises no address")
		Expect(functionCondition(bs, ConditionJWKSTrusted).Reason).To(Equal(ReasonJWKSNotRendered))
	}

	It("renders a function whose spec is the zone's pin", func() {
		ns := setup(true)
		reconcileFunction(ctx, ns, "pricing")

		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		Expect(mountsZoneDB(ksvcOf(ns))).To(BeTrue())
		bound := functionCondition(getFunction(ctx, ns, "pricing"), ConditionFunctionBound)
		Expect(bound.Status).To(Equal(metav1.ConditionTrue))
	})

	It("refuses env added under a pinned spec, keeping the pinned image: nothing mounts the zone's database Secret", func() {
		ns := setup(true)
		reconcileFunction(ctx, ns, "pricing")
		Expect(mountsZoneDB(ksvcOf(ns))).To(BeTrue(), "precondition: the matching function mounts it")
		pin := digestOfLive(ns)

		By("a principal with only `update` on backendservices adds NODE_OPTIONS, keeping the pinned digest")
		editFunction(ns, injectEnv)
		Expect(getFunction(ctx, ns, "pricing").Spec.Image).To(Equal(imageA), "the image is untouched: the image pin alone would accept this")
		reconcileFunction(ctx, ns, "pricing")

		expectSpecRefusal(ns, pin)
	})

	It("refuses envFrom added under a pinned spec", func() {
		ns := setup(true)
		createStripe(ns)
		reconcileFunction(ctx, ns, "pricing")
		pin := digestOfLive(ns)

		editFunction(ns, func(bs *appsv1alpha1.BackendService) {
			bs.Spec.EnvFrom = append(bs.Spec.EnvFrom, specEnvFromSecret("stripe").EnvFrom...)
		})
		reconcileFunction(ctx, ns, "pricing")

		expectSpecRefusal(ns, pin)
	})

	It("refuses a volume added under a pinned spec", func() {
		ns := setup(true)
		reconcileFunction(ctx, ns, "pricing")
		pin := digestOfLive(ns)

		editFunction(ns, func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Volumes = append(bs.Spec.Volumes, appsv1alpha1.FunctionVolume{
				Name: "scratch", MountPath: "/scratch", EmptyDir: &corev1.EmptyDirVolumeSource{},
			})
		})
		reconcileFunction(ctx, ns, "pricing")

		expectSpecRefusal(ns, pin)
	})

	It("refuses an env var reordered under a pinned spec (order decides $(VAR) expansion)", func() {
		ns := setup(false, func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Env = []corev1.EnvVar{{Name: "A", Value: "1"}, {Name: "B", Value: "$(A)"}}
		})
		setZoneSpecPin(ctx, ns, digestOfLive(ns))
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue(), "precondition")
		pin := digestOfLive(ns)

		editFunction(ns, func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Env = []corev1.EnvVar{{Name: "B", Value: "$(A)"}, {Name: "A", Value: "1"}}
		})
		reconcileFunction(ctx, ns, "pricing")

		expectSpecRefusal(ns, pin)
	})

	It("refuses a swapped image under a spec pin too (the image is part of the digest)", func() {
		ns := setup(true)
		reconcileFunction(ctx, ns, "pricing")
		pin := digestOfLive(ns)

		editFunction(ns, func(bs *appsv1alpha1.BackendService) { bs.Spec.Image = imageB })
		reconcileFunction(ctx, ns, "pricing")

		expectSpecRefusal(ns, pin)
	})

	It("does not refuse tuning that is not hashed: port, scaling, resources, protoVersion", func() {
		ns := setup(true)
		reconcileFunction(ctx, ns, "pricing")

		editFunction(ns, func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Port = 9090
			bs.Spec.ProtoVersion = "1.1.0"
			bs.Spec.Scaling = &appsv1alpha1.FunctionScalingSpec{MinScale: 0, MaxScale: 3}
			bs.Spec.Resources = &appsv1alpha1.ResourcesSpec{CPURequest: "100m", MemoryLimit: "128Mi"}
		})
		reconcileFunction(ctx, ns, "pricing")

		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		Expect(ready(ns).Reason).NotTo(Equal(ReasonBindingSpecMismatch))
	})

	It("keeps today's behaviour with no pin: an added env rolls out", func() {
		ns := setup(false)
		reconcileFunction(ctx, ns, "pricing")

		editFunction(ns, injectEnv)
		reconcileFunction(ctx, ns, "pricing")

		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		var names []string
		for _, e := range ksvcOf(ns).Spec.Template.Spec.Containers[0].Env {
			names = append(names, e.Name)
		}
		Expect(names).To(ContainElement("NODE_OPTIONS"))
		Expect(ready(ns).Reason).NotTo(Equal(ReasonBindingSpecMismatch))
	})

	It("recovers in place once the function returns to the pinned spec", func() {
		ns := setup(true)
		reconcileFunction(ctx, ns, "pricing")
		editFunction(ns, injectEnv)
		reconcileFunction(ctx, ns, "pricing")
		expectNothingRendered(ctx, ns, "pricing")

		editFunction(ns, func(bs *appsv1alpha1.BackendService) { bs.Spec.Env = nil })
		reconcileFunction(ctx, ns, "pricing")

		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		Expect(ready(ns).Reason).NotTo(Equal(ReasonBindingSpecMismatch))
	})

	// Rotation: the new spec and the new pin change together. When the operator
	// sees them already agreeing there is no refusal at any step, so the
	// Knative Service is updated in place: the same object, a new template.
	It("rotates in place when the pin and the spec change together", func() {
		ns := setup(true)
		reconcileFunction(ctx, ns, "pricing")
		before := ksvcOf(ns)

		editFunction(ns, func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Env = append(bs.Spec.Env, corev1.EnvVar{Name: "LOG_LEVEL", Value: "debug"})
		})
		setZoneSpecPin(ctx, ns, digestOfLive(ns))
		reconcileFunction(ctx, ns, "pricing")

		after := ksvcOf(ns)
		Expect(after.UID).To(Equal(before.UID), "an in-place update, not a teardown and re-create")
		Expect(ready(ns).Reason).NotTo(Equal(ReasonBindingSpecMismatch))
		var names []string
		for _, e := range after.Spec.Template.Spec.Containers[0].Env {
			names = append(names, e.Name)
		}
		Expect(names).To(ContainElement("LOG_LEVEL"))
	})

	It("refuses between the two writes of a rotation, whichever side goes first, and renders once both agree", func() {
		ns := setup(true)
		reconcileFunction(ctx, ns, "pricing")
		oldPin := digestOfLive(ns)

		By("the function changes first")
		editFunction(ns, func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Env = append(bs.Spec.Env, corev1.EnvVar{Name: "LOG_LEVEL", Value: "debug"})
		})
		reconcileFunction(ctx, ns, "pricing")
		expectNothingRendered(ctx, ns, "pricing")
		Expect(ready(ns).Reason).To(Equal(ReasonBindingSpecMismatch))
		setZoneSpecPin(ctx, ns, digestOfLive(ns))
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())

		By("the other order: the zone's pin moves first")
		setZoneSpecPin(ctx, ns, oldPin)
		reconcileFunction(ctx, ns, "pricing")
		expectNothingRendered(ctx, ns, "pricing")
		editFunction(ns, func(bs *appsv1alpha1.BackendService) { bs.Spec.Env = nil })
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
	})

	It("a zone that drops its spec pin falls back to the weaker binding", func() {
		ns := setup(true)
		reconcileFunction(ctx, ns, "pricing")
		editFunction(ns, injectEnv)
		reconcileFunction(ctx, ns, "pricing")
		expectNothingRendered(ctx, ns, "pricing")

		setZoneSpecPin(ctx, ns, "")
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
	})

	It("reports the image mismatch, the more specific reason, when both pins are set and the image moved", func() {
		ns := setup(true)
		setZoneImagePin(ctx, ns, "@sha256:"+pinDigestA)
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue(), "precondition: both pins match")

		editFunction(ns, func(bs *appsv1alpha1.BackendService) { bs.Spec.Image = imageB })
		reconcileFunction(ctx, ns, "pricing")

		expectNothingRendered(ctx, ns, "pricing")
		Expect(ready(ns).Reason).To(Equal(ReasonBindingImageMismatch))
	})

	It("an image pin alone still lets env be added (the weaker binding is unchanged)", func() {
		ns := setup(false)
		setZoneImagePin(ctx, ns, "@sha256:"+pinDigestA)
		reconcileFunction(ctx, ns, "pricing")

		editFunction(ns, injectEnv)
		reconcileFunction(ctx, ns, "pricing")

		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue(), "the image-only pin does not see env: this is the gap the spec pin closes")
	})

	It("a transient Secret read error with a MATCHING spec leaves a running function as it is", func() {
		ns := setup(false, func(bs *appsv1alpha1.BackendService) {
			bs.Spec.EnvFrom = append(bs.Spec.EnvFrom, specEnvFromSecret("stripe").EnvFrom...)
		})
		createStripe(ns)
		setZoneSpecPin(ctx, ns, digestOfLive(ns))
		reconcileFunction(ctx, ns, "pricing")
		running := ksvcOf(ns)

		r := newBSReconciler()
		r.APIReader = &secretMetaFailer{Reader: k8sClient, err: apierrors.NewServiceUnavailable("simulated")}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
		Expect(err).To(HaveOccurred(), "the held error is returned for a retry with backoff")

		Expect(ksvcOf(ns).UID).To(Equal(running.UID), "a read error must not tear a pinned function down")
	})

	It("a changed spec is refused while Secret reads fail too: the mismatch is decided from the specs", func() {
		ns := setup(false, func(bs *appsv1alpha1.BackendService) {
			bs.Spec.EnvFrom = append(bs.Spec.EnvFrom, specEnvFromSecret("stripe").EnvFrom...)
		})
		createStripe(ns)
		setZoneSpecPin(ctx, ns, digestOfLive(ns))
		reconcileFunction(ctx, ns, "pricing")
		editFunction(ns, injectEnv)

		r := newBSReconciler()
		r.APIReader = &secretMetaFailer{Reader: k8sClient, err: apierrors.NewServiceUnavailable("simulated")}
		_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})

		expectNothingRendered(ctx, ns, "pricing")
		Expect(ready(ns).Reason).To(Equal(ReasonBindingSpecMismatch))
	})
})

func setZoneSpecPin(ctx context.Context, ns, pin string) {
	zone := &appsv1alpha1.NextApp{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "orders"}, zone)).To(Succeed())
	zone.Spec.Backends[0].SpecDigest = pin
	Expect(k8sClient.Update(ctx, zone)).To(Succeed())
}

func setZoneImagePin(ctx context.Context, ns, pin string) {
	zone := &appsv1alpha1.NextApp{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "orders"}, zone)).To(Succeed())
	zone.Spec.Backends[0].Image = pin
	Expect(k8sClient.Update(ctx, zone)).To(Succeed())
}

var _ = Describe("NextApp CRD: the backends[].specDigest pin", func() {
	ctx := context.Background()

	create := func(pin string) error {
		ns := bsNamespace(ctx)
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: ns},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    validImageForBS(),
				Backends: []appsv1alpha1.BackendBinding{{Name: "pricing", Service: "pricing", SpecDigest: pin}},
			},
		}
		err := k8sClient.Create(ctx, app)
		if err == nil {
			DeferCleanup(deleteAndFinalize, ctx, types.NamespacedName{Namespace: ns, Name: "orders"})
		}
		return err
	}

	It("accepts sha256:<64 lowercase hex>", func() {
		Expect(create("sha256:" + pinDigestA)).To(Succeed())
	})
	It("accepts an entry with no spec pin", func() {
		Expect(create("")).To(Succeed())
	})
	DescribeTable("rejects a malformed spec pin",
		func(pin string) {
			err := create(pin)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("specDigest"))
		},
		Entry("an image-style @sha256: prefix", "@sha256:"+pinDigestA),
		Entry("no algorithm prefix", pinDigestA),
		Entry("too short", "sha256:abc123"),
		Entry("too long", "sha256:"+pinDigestA+"0"),
		Entry("uppercase hex", "sha256:ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC1"),
		Entry("another algorithm", "sha512:"+pinDigestA),
		Entry("non-hex characters", "sha256:zzz123def456abc123def456abc123def456abc123def456abc123def456abc1"),
		Entry("trailing newline", "sha256:"+pinDigestA+"\n"),
	)
})
