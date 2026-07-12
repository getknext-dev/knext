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
	"fmt"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// revisionGetFailingClient wraps the real envtest client but fails every GET
// of a Knative Revision with a transient (non-NotFound) error — simulating an
// API-server hiccup during the pinned-revision existence check. Everything
// else passes through, so the reconcile proceeds normally.
type revisionGetFailingClient struct {
	client.Client
}

func (c *revisionGetFailingClient) Get(
	ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption,
) error {
	if _, ok := obj.(*servingv1.Revision); ok {
		return fmt.Errorf("transient: connection refused")
	}
	return c.Client.Get(ctx, key, obj, opts...)
}

// These tests pin the ADR-0014 follow-up: when spec.traffic.revisionName pins
// a Revision that no longer exists (e.g. GC'd by Knative), the operator must
// surface a first-class Degraded=True / PinnedRevisionNotFound verdict with an
// actionable message — instead of relaying only Knative's opaque
// RevisionMissing text — while STILL rendering the declared traffic intent
// into the ksvc (no second-writer semantics change).
//
// Race guard (stateless): the verdict fires only when the Revision GET is
// NotFound AND the ksvc's RoutesReady/Ready condition has been non-True for
// longer than a bounded window derived from Knative's own lastTransitionTime —
// the ingressProgrammingStalled discipline. A normal deploy window (revision
// not created yet, route progressing / fresh transition) must NOT degrade.
var _ = Describe("NextApp Degraded on unresolvable pinned revision (ADR-0014)", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
		ghost      = "ghost-00042"
	)

	ctx := context.Background()

	createAndReconcile := func(name, pin string) types.NamespacedName {
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Traffic: &appsv1alpha1.TrafficSpec{RevisionName: pin},
			},
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

	// markKsvcRevisionMissing stamps the child ksvc with the condition shape
	// Knative Serving produces when a traffic target names a nonexistent
	// revision (route_lifecycle.go MarkMissingTrafficTarget): Ready and
	// RoutesReady False, Reason=RevisionMissing. `age` back-dates the
	// LastTransitionTime so tests can place the failure inside/outside the
	// stall window.
	markKsvcRevisionMissing := func(nn types.NamespacedName, age time.Duration) {
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		ltt := apis.VolatileTime{Inner: metav1.NewTime(time.Now().Add(-age))}
		ksvc.Status.ObservedGeneration = ksvc.Generation
		ksvc.Status.SetConditions(apis.Conditions{
			{
				Type:               servingv1.ServiceConditionReady,
				Status:             corev1.ConditionFalse,
				Reason:             "RevisionMissing",
				Message:            fmt.Sprintf("Revision %q referenced in traffic not found.", ghost),
				LastTransitionTime: ltt,
			},
			{
				Type:               servingv1.ServiceConditionRoutesReady,
				Status:             corev1.ConditionFalse,
				Reason:             "RevisionMissing",
				Message:            fmt.Sprintf("Revision %q referenced in traffic not found.", ghost),
				LastTransitionTime: ltt,
			},
		})
		Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())
	}

	// markKsvcDeploying stamps a FRESH in-progress rollout: Ready/RoutesReady
	// Unknown with Reason=Deploying and LastTransitionTime=now — the normal
	// deploy window during which a not-yet-created revision must NOT trip the
	// PinnedRevisionNotFound alarm.
	markKsvcDeploying := func(nn types.NamespacedName) {
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		ltt := apis.VolatileTime{Inner: metav1.NewTime(time.Now())}
		ksvc.Status.ObservedGeneration = ksvc.Generation
		ksvc.Status.SetConditions(apis.Conditions{
			{
				Type:               servingv1.ServiceConditionReady,
				Status:             corev1.ConditionUnknown,
				Reason:             "Deploying",
				Message:            "Revision is being deployed.",
				LastTransitionTime: ltt,
			},
			{
				Type:               servingv1.ServiceConditionRoutesReady,
				Status:             corev1.ConditionUnknown,
				Reason:             "Deploying",
				Message:            "Revision is being deployed.",
				LastTransitionTime: ltt,
			},
		})
		Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())
	}

	markKsvcReady := func(nn types.NamespacedName) {
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		ltt := apis.VolatileTime{Inner: metav1.NewTime(time.Now())}
		ksvc.Status.ObservedGeneration = ksvc.Generation
		ksvc.Status.SetConditions(apis.Conditions{
			{Type: servingv1.ServiceConditionReady, Status: corev1.ConditionTrue, LastTransitionTime: ltt},
			{Type: servingv1.ServiceConditionRoutesReady, Status: corev1.ConditionTrue, LastTransitionTime: ltt},
			{Type: servingv1.ServiceConditionConfigurationsReady, Status: corev1.ConditionTrue, LastTransitionTime: ltt},
		})
		Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())
	}

	createRevision := func(name string) {
		rev := &servingv1.Revision{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		}
		Expect(k8sClient.Create(ctx, rev)).To(Succeed())
		DeferCleanup(func() {
			cur := &servingv1.Revision{}
			nn := types.NamespacedName{Name: name, Namespace: namespace}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
			}
		})
	}

	countPinEvents := func(rec *record.FakeRecorder) int {
		n := 0
		for _, e := range drainEvents(rec) {
			if strings.Contains(e, "Warning") && strings.Contains(e, ReasonPinnedRevisionNotFound) {
				n++
			}
		}
		return n
	}

	Context("(a) when the pin names a ghost revision and the route is NOT progressing", func() {
		It("reports Ready=False + Degraded=True with reason PinnedRevisionNotFound, an actionable static message, ONE Warning event, and still renders the declared traffic intent", func() {
			nn := createAndReconcile("pin-ghost-degrades", ghost)

			By("Back-dating a RevisionMissing route failure past the stall window")
			markKsvcRevisionMissing(nn, pinnedRevisionStallWindow+3*time.Minute)

			recorder := record.NewFakeRecorder(64)
			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}
			res, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())

			By("Asserting Ready=False with the specific PinnedRevisionNotFound reason")
			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready).NotTo(BeNil())
			Expect(ready.Status).To(Equal(metav1.ConditionFalse))
			Expect(ready.Reason).To(Equal(ReasonPinnedRevisionNotFound),
				"a ghost pin must surface its own reason, not the generic KnativeServiceNotReady")

			By("Asserting the message is actionable: names the revision, kubectl get revisions, kn-next rollback / clear-the-pin")
			Expect(ready.Message).To(ContainSubstring(ghost))
			Expect(ready.Message).To(ContainSubstring(fmt.Sprintf("kubectl get revisions -n %s", namespace)))
			Expect(ready.Message).To(ContainSubstring("kn-next rollback"))
			Expect(ready.Message).To(ContainSubstring("clear"))

			By("Asserting Degraded=True carries the same reason")
			degraded := findCondition(updated.Status.Conditions, conditionTypeDegraded)
			Expect(degraded).NotTo(BeNil())
			Expect(degraded.Status).To(Equal(metav1.ConditionTrue))
			Expect(degraded.Reason).To(Equal(ReasonPinnedRevisionNotFound))

			By("Asserting exactly one Warning PinnedRevisionNotFound event")
			Expect(countPinEvents(recorder)).To(Equal(1))

			By("Asserting the bounded requeue keeps re-evaluating")
			Expect(res.RequeueAfter).To(BeNumerically(">", 0))

			By("Asserting the declared traffic intent is STILL rendered into the ksvc (no second-writer change)")
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			Expect(ksvc.Spec.Traffic).To(HaveLen(1))
			Expect(ksvc.Spec.Traffic[0].RevisionName).To(Equal(ghost))
		})
	})

	Context("(b) when the pin is moved back to an existing revision", func() {
		It("clears the PinnedRevisionNotFound verdict", func() {
			nn := createAndReconcile("pin-ghost-clears", ghost)
			markKsvcRevisionMissing(nn, pinnedRevisionStallWindow+3*time.Minute)

			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			degradedApp := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, degradedApp)).To(Succeed())
			Expect(findCondition(degradedApp.Status.Conditions, conditionTypeReady).Reason).
				To(Equal(ReasonPinnedRevisionNotFound), "precondition: the ghost pin degraded first")

			By("Re-pinning to a revision that exists and letting Knative report Ready")
			const realRev = "pin-ghost-clears-00001"
			createRevision(realRev)
			Expect(k8sClient.Get(ctx, nn, degradedApp)).To(Succeed())
			degradedApp.Spec.Traffic.RevisionName = realRev
			Expect(k8sClient.Update(ctx, degradedApp)).To(Succeed())
			_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())
			markKsvcReady(nn)

			_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())
			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready.Status).To(Equal(metav1.ConditionTrue))
			degraded := findCondition(updated.Status.Conditions, conditionTypeDegraded)
			Expect(degraded.Status).To(Equal(metav1.ConditionFalse))
			Expect(degraded.Reason).NotTo(Equal(ReasonPinnedRevisionNotFound))
		})
	})

	Context("(c) when the degraded object is already converged", func() {
		It("performs NO status write on requeue (static message — the #98 no-op guard) and does not re-emit the event", func() {
			nn := createAndReconcile("pin-ghost-converged", ghost)
			markKsvcRevisionMissing(nn, pinnedRevisionStallWindow+3*time.Minute)

			recorder := record.NewFakeRecorder(64)
			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}

			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())
			afterFirst := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, afterFirst)).To(Succeed())
			firstReady := findCondition(afterFirst.Status.Conditions, conditionTypeReady)
			Expect(firstReady.Reason).To(Equal(ReasonPinnedRevisionNotFound))

			_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			afterSecond := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, afterSecond)).To(Succeed())
			Expect(findCondition(afterSecond.Status.Conditions, conditionTypeReady).Message).
				To(Equal(firstReady.Message),
					"the condition message must be STATIC — no per-reconcile timestamps/counters")
			Expect(afterSecond.ResourceVersion).To(Equal(afterFirst.ResourceVersion),
				"a converged degraded object must not be re-written every requeue (#98 self-watch churn)")

			By("Asserting the Warning fired on TRANSITION only, not per requeue")
			Expect(countPinEvents(recorder)).To(Equal(1))
		})
	})

	Context("(d) when the revision is not found but the route is progressing (normal deploy window)", func() {
		It("does NOT degrade with PinnedRevisionNotFound", func() {
			nn := createAndReconcile("pin-deploy-race", "pin-deploy-race-00002")

			By("Stamping a FRESH Deploying rollout (recent lastTransitionTime)")
			markKsvcDeploying(nn)

			recorder := record.NewFakeRecorder(64)
			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}
			res, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())
			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready.Status).To(Equal(metav1.ConditionFalse))
			Expect(ready.Reason).To(Equal("KnativeServiceNotReady"),
				"a fresh deploy window is normal latency, not a ghost pin")
			degraded := findCondition(updated.Status.Conditions, conditionTypeDegraded)
			Expect(degraded.Reason).NotTo(Equal(ReasonPinnedRevisionNotFound))

			Expect(countPinEvents(recorder)).To(BeZero())
			Expect(res.RequeueAfter).To(BeNumerically(">", 0),
				"must keep requeueing so the stall window is eventually evaluated")
		})
	})

	Context("(e) when the Revision GET fails with a transient (non-NotFound) error", func() {
		It("does not degrade a healthy-so-far app with PinnedRevisionNotFound", func() {
			nn := createAndReconcile("pin-transient-fresh", ghost)
			markKsvcRevisionMissing(nn, pinnedRevisionStallWindow+3*time.Minute)

			recorder := record.NewFakeRecorder(64)
			r := &NextAppReconciler{
				Client:   &revisionGetFailingClient{k8sClient},
				Scheme:   k8sClient.Scheme(),
				Recorder: recorder,
			}
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())
			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready.Reason).To(Equal("KnativeServiceNotReady"),
				"a transient GET error is NOT evidence the revision is gone — treat as unknown")
			Expect(countPinEvents(recorder)).To(BeZero())
		})

		It("keeps a prior PinnedRevisionNotFound verdict instead of flip-flopping", func() {
			nn := createAndReconcile("pin-transient-keeps", ghost)
			markKsvcRevisionMissing(nn, pinnedRevisionStallWindow+3*time.Minute)

			By("Entering the degraded state with the real client")
			recorder := record.NewFakeRecorder(64)
			real := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}
			_, err := real.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())
			afterReal := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, afterReal)).To(Succeed())
			Expect(findCondition(afterReal.Status.Conditions, conditionTypeReady).Reason).
				To(Equal(ReasonPinnedRevisionNotFound))

			By("Reconciling with a client whose Revision GET fails transiently")
			failing := &NextAppReconciler{
				Client:   &revisionGetFailingClient{k8sClient},
				Scheme:   k8sClient.Scheme(),
				Recorder: recorder,
			}
			_, err = failing.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			afterFailing := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, afterFailing)).To(Succeed())
			ready := findCondition(afterFailing.Status.Conditions, conditionTypeReady)
			Expect(ready.Reason).To(Equal(ReasonPinnedRevisionNotFound),
				"the prior verdict must be KEPT while the check is inconclusive")
			Expect(afterFailing.ResourceVersion).To(Equal(afterReal.ResourceVersion),
				"keeping the prior verdict must be a status no-op (#98 guard)")

			By("Asserting only the original transition emitted a Warning")
			Expect(countPinEvents(recorder)).To(Equal(1))
		})
	})
})
