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
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// markKsvcReadyAndReconcile is a shared envtest helper: envtest runs no Knative
// controllers, so a child Knative Service never acquires a real "Ready" condition
// on its own. Tests that want the honest-Ready path to reach NextApp Ready=True
// must therefore stamp the ksvc Ready=True themselves, then re-reconcile so the
// operator observes it. (Before the honest-Ready change the operator set Ready=True
// unconditionally, so these tests didn't need to do this — that was the false-green.)
func markKsvcReadyAndReconcile(ctx context.Context, nn types.NamespacedName) {
	ksvc := &servingv1.Service{}
	ExpectWithOffset(1, k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
	ksvc.Status.ObservedGeneration = ksvc.Generation
	ksvc.Status.SetConditions(apis.Conditions{
		{Type: servingv1.ServiceConditionReady, Status: corev1.ConditionTrue},
	})
	ExpectWithOffset(1, k8sClient.Status().Update(ctx, ksvc)).To(Succeed())

	reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
}

// These tests pin the P0 "honest Ready" hardening: the operator must NOT report
// NextApp Ready=True merely because it successfully wrote the child Knative
// Service. Ready must mirror the ksvc's OWN readiness — otherwise a NextApp whose
// pods are CrashLoopBackOff / ImagePullBackOff reports a false-green that misleads
// operators and rollback/traffic-split automation during the exact incident they
// need to detect.

var _ = Describe("NextApp Ready gating on real Knative Service health", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)

	ctx := context.Background()

	// createAndReconcile creates the NextApp, reconciles once (which writes the
	// child ksvc), and registers finalizer-aware cleanup. Returns the name.
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

	// markKsvcNotReady forces the child Knative Service to report its own Ready
	// condition False with a crash/pull reason, simulating CrashLoopBackOff.
	markKsvcNotReady := func(nn types.NamespacedName) {
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		ksvc.Status.ObservedGeneration = ksvc.Generation
		ksvc.Status.SetConditions(apis.Conditions{
			{
				Type:     servingv1.ServiceConditionReady,
				Status:   corev1.ConditionFalse,
				Reason:   "RevisionFailed",
				Message:  "Revision \"app-00001\" failed with message: Back-off pulling image (ImagePullBackOff).",
				Severity: apis.ConditionSeverityError,
			},
		})
		Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())
	}

	Context("When the child Knative Service is NOT Ready (crash/pull failure)", func() {
		It("must report NextApp Ready=False with Reason=KnativeServiceNotReady (no false-green)", func() {
			By("Creating and reconciling a NextApp")
			nn := createAndReconcile("ready-gate-notready")

			By("Forcing the child ksvc to report Ready=False (ImagePullBackOff)")
			markKsvcNotReady(nn)

			By("Reconciling again so the operator observes the unhealthy ksvc")
			reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			res, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			By("Asserting NextApp Ready=False / Reason=KnativeServiceNotReady")
			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())

			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready).NotTo(BeNil(), "Ready condition must be present")
			Expect(ready.Status).To(Equal(metav1.ConditionFalse),
				"Ready must be False when the child ksvc is not Ready (no false-green)")
			Expect(ready.Reason).To(Equal("KnativeServiceNotReady"))

			By("Asserting Degraded=True reflects the pull/crash detail")
			degraded := findCondition(updated.Status.Conditions, conditionTypeDegraded)
			Expect(degraded).NotTo(BeNil(), "Degraded condition must be present")
			Expect(degraded.Status).To(Equal(metav1.ConditionTrue),
				"Degraded must be True when the ksvc reports a failure")
			Expect(degraded.Message).To(ContainSubstring("ImagePullBackOff"))

			By("Asserting a bounded RequeueAfter so status converges to real health")
			Expect(res.RequeueAfter).To(BeNumerically(">", 0),
				"a not-yet-Ready ksvc must schedule a bounded requeue")
			Expect(res.RequeueAfter).To(BeNumerically("<=", 60_000_000_000),
				"RequeueAfter must be bounded (<= 60s)")
		})
	})

	Context("When the child Knative Service IS Ready", func() {
		It("reports NextApp Ready=True / Degraded=False and does not requeue", func() {
			By("Creating and reconciling a NextApp")
			nn := createAndReconcile("ready-gate-ready")

			By("Forcing the child ksvc to report Ready=True")
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			ksvc.Status.ObservedGeneration = ksvc.Generation
			ksvc.Status.SetConditions(apis.Conditions{
				{Type: servingv1.ServiceConditionReady, Status: corev1.ConditionTrue},
			})
			ksvc.Status.URL = apis.HTTP("ready-gate-ready.default.example.com")
			Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())

			By("Reconciling again so the operator observes the healthy ksvc")
			reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			res, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())

			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready).NotTo(BeNil())
			Expect(ready.Status).To(Equal(metav1.ConditionTrue),
				"Ready must be True when the child ksvc is Ready")

			degraded := findCondition(updated.Status.Conditions, conditionTypeDegraded)
			if degraded != nil {
				Expect(degraded.Status).To(Equal(metav1.ConditionFalse))
			}

			Expect(res.RequeueAfter).To(BeZero(),
				"a Ready ksvc must not schedule a periodic requeue")
		})
	})
})
