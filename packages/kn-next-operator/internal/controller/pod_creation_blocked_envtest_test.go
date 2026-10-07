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
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Reconcile-level proof that the Revision observation is WIRED into the
// verdict: a latest-created Revision whose ResourcesAvailable condition is a
// FailedCreate quota rejection surfaces as PodCreationBlocked on the NextApp,
// and clears when the Revision recovers.
var _ = Describe("NextApp PodCreationBlocked from a rejected revision", func() {
	const (
		namespace  = "default"
		name       = "pcb-app"
		revName    = "pcb-app-00001"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)
	ctx := context.Background()
	nn := types.NamespacedName{Name: name, Namespace: namespace}
	revKey := types.NamespacedName{Name: revName, Namespace: namespace}

	It("sets and clears the condition from the Revision's ResourcesAvailable", func() {
		Expect(k8sClient.Create(ctx, &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec:       appsv1alpha1.NextAppSpec{Image: validImage},
		})).To(Succeed())
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
		reconcileOnce := func() {
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())
		}
		reconcileOnce()

		rev := &servingv1.Revision{ObjectMeta: metav1.ObjectMeta{Name: revName, Namespace: namespace}}
		Expect(k8sClient.Create(ctx, rev)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, rev) })
		setRevision := func(status corev1.ConditionStatus, reason, msg string) {
			Expect(k8sClient.Get(ctx, revKey, rev)).To(Succeed())
			rev.Status.SetConditions(apis.Conditions{{
				Type: servingv1.RevisionConditionResourcesAvailable, Status: status,
				Reason: reason, Message: msg, LastTransitionTime: apis.VolatileTime{Inner: metav1.NewTime(time.Now())},
			}})
			Expect(k8sClient.Status().Update(ctx, rev)).To(Succeed())
		}
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		ksvc.Status.LatestCreatedRevisionName = revName
		Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())

		blockedCond := func() *metav1.Condition {
			app := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, app)).To(Succeed())
			return apimeta.FindStatusCondition(app.Status.Conditions, ConditionPodCreationBlocked)
		}

		setRevision(corev1.ConditionFalse, "FailedCreate", quotaMsg)
		reconcileOnce()
		c := blockedCond()
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionTrue))
		Expect(c.Reason).To(Equal(ReasonQuotaExceeded))
		Expect(c.Message).To(ContainSubstring("exceeded quota"))

		// Knative flips the reason after the progress deadline; pods are still blocked.
		setRevision(corev1.ConditionFalse, "ProgressDeadlineExceeded", "Initial scale was never achieved")
		reconcileOnce()
		Expect(blockedCond()).NotTo(BeNil())
		Expect(blockedCond().Reason).To(Equal(ReasonQuotaExceeded))

		setRevision(corev1.ConditionTrue, "", "")
		reconcileOnce()
		Expect(blockedCond()).To(BeNil())
	})
})
