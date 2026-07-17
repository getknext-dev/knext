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
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// End-to-end characterization of the #312 scale-state + last-deploy status
// fields: after a reconcile that observes a Ready child ksvc (with a latest-ready
// revision and an Inactive == scaled-to-zero revision), the NextApp status must
// carry observedRevision, scaledToZero, and lastSuccessfulDeployTime.
var _ = Describe("NextApp scale-state & last-deploy status (#312)", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)
	ctx := context.Background()

	createAndReconcile := func(name string) types.NamespacedName {
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
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
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		return nn
	}

	It("populates observedRevision, scaledToZero, and lastSuccessfulDeployTime once Ready", func() {
		nn := createAndReconcile("deploystate-app")
		revName := nn.Name + "-00001"

		By("Stamping the child ksvc Ready=True with a latest-ready revision")
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		ksvc.Status.ObservedGeneration = ksvc.Generation
		ksvc.Status.SetConditions(apis.Conditions{
			{Type: servingv1.ServiceConditionReady, Status: corev1.ConditionTrue},
		})
		ksvc.Status.LatestReadyRevisionName = revName
		Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())

		By("Creating a Ready-but-Inactive Revision (scaled to zero)")
		rev := &servingv1.Revision{
			ObjectMeta: metav1.ObjectMeta{Name: revName, Namespace: namespace},
		}
		Expect(k8sClient.Create(ctx, rev)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, rev) })
		rev.Status.SetConditions(apis.Conditions{
			{Type: servingv1.RevisionConditionReady, Status: corev1.ConditionTrue},
			{Type: servingv1.RevisionConditionActive, Status: corev1.ConditionFalse, Reason: "NoTraffic"},
		})
		Expect(k8sClient.Status().Update(ctx, rev)).To(Succeed())

		By("Reconciling so the operator observes the Ready ksvc + Inactive revision")
		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		updated := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())
		Expect(updated.Status.ObservedRevision).To(Equal(revName))
		Expect(updated.Status.LastSuccessfulDeployTime).NotTo(BeNil(),
			"lastSuccessfulDeployTime must be stamped once the ksvc is Ready")
		Expect(updated.Status.ScaledToZero).NotTo(BeNil())
		Expect(*updated.Status.ScaledToZero).To(BeTrue(),
			"an Inactive Ready revision means the app is scaled to zero")
	})
})
