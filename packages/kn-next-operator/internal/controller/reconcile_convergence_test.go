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

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// These tests pin issue #98: the reconciler must CONVERGE — once a NextApp is
// reconciled and unchanged, a second reconcile pass must perform NO status write
// (otherwise the status write re-enqueues its own watch event → ~45/s hot-loop).
// They also assert the finalizer-add no longer races the status update (no
// "object has been modified" conflict spam), and that the no-op guard does NOT
// over-suppress real changes (spec change + owned-resource drift still persist).

var _ = Describe("NextApp Controller reconcile convergence (#98)", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
		// a different valid digest-pinned ref for the spec-change regression test.
		validImage2 = "registry.example.com/app:v2@sha256:def456abc123def456abc123def456abc123def456abc123def456abc123def4"
	)

	ctx := context.Background()

	// createAndConverge creates the NextApp, reconciles once (converging), and
	// registers finalizer-aware cleanup. Returns the namespaced name.
	createAndConverge := func(name string, spec appsv1alpha1.NextAppSpec) types.NamespacedName {
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		spec.Image = orDefault(spec.Image, validImage)
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec:       spec,
		}
		Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())

		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				cleanup := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanup.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
					return errors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
				}, "10s", "100ms").Should(BeTrue())
			}
		})

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		return nn
	}

	// RED test 1 (primary): an unchanged object must NOT be written on the second
	// reconcile pass. Fails against current code (the eager Reconciling=True status
	// write bumps resourceVersion on every pass).
	It("performs no status write when reconciling an unchanged converged object", func() {
		nn := createAndConverge("converge-noop", appsv1alpha1.NextAppSpec{Image: validImage})

		before := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, before)).To(Succeed())
		beforeRV := before.ResourceVersion
		beforeStatus := *before.Status.DeepCopy()

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		after := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, after)).To(Succeed())

		By("not bumping resourceVersion (no write to the API server)")
		Expect(after.ResourceVersion).To(Equal(beforeRV),
			"a no-op reconcile must not write status (resourceVersion must be unchanged)")

		By("leaving the observed status byte-identical")
		Expect(after.Status).To(Equal(beforeStatus))
	})

	// Test 2 (no-conflict): two rapid reconciles must not surface a conflict
	// ("object has been modified"). The finalizer-via-Patch removes the
	// update/status-update race.
	It("does not surface IsConflict on two rapid reconciles", func() {
		nn := types.NamespacedName{Name: "converge-noconflict", Namespace: namespace}
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: namespace},
			Spec:       appsv1alpha1.NextAppSpec{Image: validImage},
		}
		Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())
		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				cleanup := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanup.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
					return errors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
				}, "10s", "100ms").Should(BeTrue())
			}
		})

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err1 := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		_, err2 := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})

		Expect(errors.IsConflict(err1)).To(BeFalse(), "first reconcile must not conflict")
		Expect(errors.IsConflict(err2)).To(BeFalse(), "second reconcile must not conflict")
		Expect(err1).NotTo(HaveOccurred())
		Expect(err2).NotTo(HaveOccurred())
	})

	// Test 3 (does NOT over-suppress — regression guard): the no-op guard must
	// only skip TRUE no-ops. A spec change must persist (ObservedGeneration
	// advances), and owned-resource drift (ksvc Status.URL) must flow into status.
	It("still writes status when the spec changes (does not over-suppress)", func() {
		nn := createAndConverge("converge-specchange", appsv1alpha1.NextAppSpec{Image: validImage})

		before := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, before)).To(Succeed())
		beforeRV := before.ResourceVersion

		// Change the spec to a different valid digest-pinned image.
		cur := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, cur)).To(Succeed())
		cur.Spec.Image = validImage2
		Expect(k8sClient.Update(ctx, cur)).To(Succeed())

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		after := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, after)).To(Succeed())

		By("bumping resourceVersion (the change must persist)")
		Expect(after.ResourceVersion).NotTo(Equal(beforeRV))

		By("advancing ObservedGeneration on the Ready condition")
		ready := findCondition(after.Status.Conditions, conditionTypeReady)
		Expect(ready).NotTo(BeNil())
		Expect(ready.ObservedGeneration).To(Equal(after.Generation))
	})

	It("propagates owned ksvc Status.URL into NextApp status (does not over-suppress drift)", func() {
		nn := createAndConverge("converge-urldrift", appsv1alpha1.NextAppSpec{Image: validImage})

		// Simulate Knative populating the ksvc URL out-of-band.
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		ksvc.Status.URL = apis.HTTP("converge-urldrift.default.example.com")
		Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		after := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, after)).To(Succeed())
		Expect(after.Status.URL).To(Equal("http://converge-urldrift.default.example.com"))
	})
})
