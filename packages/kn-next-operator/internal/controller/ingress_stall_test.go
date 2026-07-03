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
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// These tests pin the loud-failure half of issue #208: when the cluster's
// ingress-class does not match the class any installed ingress controller
// serves (e.g. `kourier.knative.dev` vs net-kourier's real
// `kourier.ingress.networking.knative.dev`), Knative Serving leaves the Route's
// KIngress unreconciled FOREVER, with only an opaque
// `IngressNotConfigured / "Ingress has not yet been reconciled."` Unknown
// condition on the ksvc. Nothing errors; routes just never program.
//
// The operator must convert that silent stall into a loud, actionable signal:
// after a bounded window, NextApp Ready=False with Reason=IngressNotProgrammed,
// a message that names the class net-kourier actually serves, and a Warning
// event — so `kubectl describe nextapp` tells the operator exactly what to fix.
var _ = Describe("NextApp loud failure on stalled ingress programming (#208)", func() {
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

	// markKsvcIngressNotConfigured stamps the child ksvc with the exact condition
	// shape Knative Serving produces when no ingress controller reconciles the
	// Route's KIngress (route_lifecycle.go MarkIngressNotConfigured): Ready and
	// RoutesReady Unknown, Reason=IngressNotConfigured. `age` back-dates the
	// LastTransitionTime so tests can simulate a stall older than the window.
	markKsvcIngressNotConfigured := func(nn types.NamespacedName, age time.Duration) {
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		ltt := apis.VolatileTime{Inner: metav1.NewTime(time.Now().Add(-age))}
		ksvc.Status.ObservedGeneration = ksvc.Generation
		ksvc.Status.SetConditions(apis.Conditions{
			{
				Type:               servingv1.ServiceConditionReady,
				Status:             corev1.ConditionUnknown,
				Reason:             "IngressNotConfigured",
				Message:            "Ingress has not yet been reconciled.",
				LastTransitionTime: ltt,
			},
			{
				Type:               servingv1.ServiceConditionRoutesReady,
				Status:             corev1.ConditionUnknown,
				Reason:             "IngressNotConfigured",
				Message:            "Ingress has not yet been reconciled.",
				LastTransitionTime: ltt,
			},
		})
		Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())
	}

	Context("when the ksvc has reported IngressNotConfigured for longer than the stall window", func() {
		It("reports Ready=False Reason=IngressNotProgrammed naming the real net-kourier class, and emits a Warning event", func() {
			nn := createAndReconcile("ingress-stall-old")

			By("Back-dating an IngressNotConfigured stall past the window")
			markKsvcIngressNotConfigured(nn, ingressProgrammingStallWindow+3*time.Minute)

			By("Reconciling with an event recorder wired")
			recorder := record.NewFakeRecorder(64)
			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}
			res, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())

			By("Asserting Ready=False with the specific IngressNotProgrammed reason")
			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready).NotTo(BeNil())
			Expect(ready.Status).To(Equal(metav1.ConditionFalse))
			Expect(ready.Reason).To(Equal(ReasonIngressNotProgrammed),
				"a stalled ingress must surface its own reason, not the generic KnativeServiceNotReady")
			Expect(ready.Message).To(ContainSubstring("kourier.ingress.networking.knative.dev"),
				"the message must name the class net-kourier actually serves so the fix is actionable")
			Expect(ready.Message).To(ContainSubstring("ingress-class"))

			By("Asserting Degraded=True carries the same actionable reason")
			degraded := findCondition(updated.Status.Conditions, conditionTypeDegraded)
			Expect(degraded).NotTo(BeNil())
			Expect(degraded.Status).To(Equal(metav1.ConditionTrue))
			Expect(degraded.Reason).To(Equal(ReasonIngressNotProgrammed))

			By("Asserting a Warning IngressNotProgrammed event was emitted")
			events := drainEvents(recorder)
			found := false
			for _, e := range events {
				if strings.Contains(e, "Warning") && strings.Contains(e, ReasonIngressNotProgrammed) {
					found = true
				}
			}
			Expect(found).To(BeTrue(), "expected a Warning IngressNotProgrammed event, got: %v", events)

			By("Asserting the bounded requeue is preserved so the stall keeps re-evaluating")
			Expect(res.RequeueAfter).To(BeNumerically(">", 0))
		})

		It("does not spam events or churn status on repeated reconciles while stalled", func() {
			nn := createAndReconcile("ingress-stall-repeat")

			By("Back-dating an IngressNotConfigured stall past the window")
			markKsvcIngressNotConfigured(nn, ingressProgrammingStallWindow+3*time.Minute)

			recorder := record.NewFakeRecorder(64)
			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}

			By("Reconciling twice while the stall persists")
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			afterFirst := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, afterFirst)).To(Succeed())
			firstReady := findCondition(afterFirst.Status.Conditions, conditionTypeReady)
			Expect(firstReady).NotTo(BeNil())
			Expect(firstReady.Reason).To(Equal(ReasonIngressNotProgrammed))

			_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			By("Asserting exactly ONE Warning IngressNotProgrammed event (transition-only, no 30s spam)")
			stallEvents := 0
			for _, e := range drainEvents(recorder) {
				if strings.Contains(e, "Warning") && strings.Contains(e, ReasonIngressNotProgrammed) {
					stallEvents++
				}
			}
			Expect(stallEvents).To(Equal(1),
				"the stall alarm must fire on TRANSITION into the stall, not on every requeue")

			By("Asserting the second reconcile performed NO status write (static message, #98 no-op guard holds)")
			afterSecond := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, afterSecond)).To(Succeed())
			secondReady := findCondition(afterSecond.Status.Conditions, conditionTypeReady)
			Expect(secondReady).NotTo(BeNil())
			Expect(secondReady.Message).To(Equal(firstReady.Message),
				"the condition message must be STATIC — a growing elapsed would defeat the no-op guard")
			Expect(afterSecond.ResourceVersion).To(Equal(afterFirst.ResourceVersion),
				"a converged stalled object must not be re-written every requeue (self-watch churn)")
		})
	})

	Context("when IngressNotConfigured is fresh (within the stall window)", func() {
		It("keeps the generic KnativeServiceNotReady reason and does not fire the stall alarm", func() {
			nn := createAndReconcile("ingress-stall-fresh")

			By("Stamping a just-transitioned IngressNotConfigured condition")
			markKsvcIngressNotConfigured(nn, 0)

			recorder := record.NewFakeRecorder(64)
			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}
			res, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())

			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready).NotTo(BeNil())
			Expect(ready.Status).To(Equal(metav1.ConditionFalse))
			Expect(ready.Reason).To(Equal("KnativeServiceNotReady"),
				"a fresh IngressNotConfigured is normal startup latency, not yet a stall")

			for _, e := range drainEvents(recorder) {
				Expect(e).NotTo(ContainSubstring(ReasonIngressNotProgrammed),
					"no stall alarm before the window elapses")
			}

			Expect(res.RequeueAfter).To(BeNumerically(">", 0),
				"must keep requeueing so the stall window is eventually evaluated")
		})
	})
})
