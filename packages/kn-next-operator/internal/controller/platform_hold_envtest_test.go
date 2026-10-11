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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Hold-last-good must not read as success when it drops the app's OWN change.
//
// A deploy that rolls a new image into an app whose merged spec the platform has
// made invalid cannot be applied: the old Knative Service keeps serving. If that
// pass still reported Ready=True with the new generation observed,
// `kubectl wait --for=condition=Ready` (and anything else keyed on the status
// contract) would call the deploy a success while the old image serves. Real API
// server: the generation bump on a spec edit is the API server's, not a fixture's.
var _ = Describe("hold-last-good that drops the app's own change is not Ready", func() {
	const (
		ns      = "default"
		imageV1 = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
		imageV2 = "registry.example.com/app:v2@sha256:def456abc123def456abc123def456abc123def456abc123def456abc123def4"
		appName = "hold-drops-app-change"
	)
	ctx := context.Background()
	nn := types.NamespacedName{Name: appName, Namespace: ns}

	It("reports Ready=False and does not advance the reconciled generation; recovers when the hold lifts", func() {
		holdsBefore := holdsCounter(ReasonEffectiveSpecInvalid)
		DeferCleanup(func() { deletePlatformIfPresent(ctx, "default") })
		Expect(k8sClient.Create(ctx, rawPlatform("default", map[string]interface{}{
			// An active platform that sets no budget: the built-in 80 applies until it does.
			"limits": map[string]interface{}{"timeoutSeconds": int64(600)},
		}))).To(Succeed())

		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: ns},
			// 8 x 10 = 80 connections: exactly the built-in budget, so valid on its own
			// and invalid only once the platform lowers the budget.
			Spec: appsv1alpha1.NextAppSpec{Image: imageV1, Scaling: &appsv1alpha1.ScalingSpec{MaxScale: 8, PoolMax: 10}},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				cleanup := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanup.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
					return apierrors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
				}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
			}
		})

		r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), PlatformCRDPresent: true}
		reconcileOnce := func() {
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())
		}
		get := func() *appsv1alpha1.NextApp {
			cur := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, cur)).To(Succeed())
			return cur
		}
		liveImage := func() string {
			k := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, k)).To(Succeed())
			return k.Spec.Template.Spec.Containers[0].Image
		}

		By("a first pass renders v1; Knative reports the Service Ready")
		reconcileOnce()
		k := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, k)).To(Succeed())
		k.Status.ObservedGeneration = k.Generation
		k.Status.SetConditions(apis.Conditions{{Type: servingv1.ServiceConditionReady, Status: corev1.ConditionTrue}})
		Expect(k8sClient.Status().Update(ctx, k)).To(Succeed())
		reconcileOnce()
		Expect(apimeta.IsStatusConditionTrue(get().Status.Conditions, ConditionReady)).To(BeTrue())
		firstGen := get().Generation

		By("the admin lowers the budget below the app's wall: a PLATFORM-only hold")
		p := &platformv1alpha1.KnextPlatform{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "default"}, p)).To(Succeed())
		p.Spec.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: 40}
		Expect(k8sClient.Update(ctx, p)).To(Succeed())
		reconcileOnce()
		held := get()
		Expect(apimeta.FindStatusCondition(held.Status.Conditions, ConditionPlatformDefaultsApplied).Reason).
			To(Equal(ReasonEffectiveSpecInvalid))
		ready := apimeta.FindStatusCondition(held.Status.Conditions, ConditionReady)
		Expect(ready.Status).To(Equal(metav1.ConditionTrue),
			"nothing of the app's own was dropped, so the live Service's readiness is still the truth")
		Expect(apimeta.IsStatusConditionFalse(held.Status.Conditions, ConditionReconciling)).To(BeTrue())

		By("the fleet metrics see the hold: the gauge counts the app and the counter counted the entry")
		Expect(heldGauge(ReasonEffectiveSpecInvalid)).To(Equal(1.0))
		Expect(holdsCounter(ReasonEffectiveSpecInvalid)-holdsBefore).To(Equal(1.0),
			"a hold is counted once when it begins, not on every pass")

		By("the developer deploys a new image while the hold is in force")
		held.Spec.Image = imageV2
		Expect(k8sClient.Update(ctx, held)).To(Succeed())
		newGen := get().Generation
		Expect(newGen).To(BeNumerically(">", firstGen))

		// A second pass must say the same: the verdict is sticky, not a one-off.
		for pass := 1; pass <= 2; pass++ {
			reconcileOnce()
			cur := get()
			ready = apimeta.FindStatusCondition(cur.Status.Conditions, ConditionReady)
			Expect(ready.Status).To(Equal(metav1.ConditionFalse),
				"pass %d: the old image is serving and the new one is NOT applied - Ready=True is a false green", pass)
			Expect(ready.Reason).To(Equal(ReasonEffectiveSpecInvalid))
			Expect(ready.Message).To(ContainSubstring("spec.scaling"))
			Expect(ready.ObservedGeneration).To(Equal(newGen), "a False verdict about this generation IS an observation of it")
			rec := apimeta.FindStatusCondition(cur.Status.Conditions, ConditionReconciling)
			Expect(rec.Status).To(Equal(metav1.ConditionTrue), "the change is not done; Reconciling=False 'complete' is the lie")
			Expect(rec.ObservedGeneration).To(Equal(firstGen),
				"the reconciled generation must not advance past a change that was not applied")
			Expect(liveImage()).To(Equal(imageV1), "hold-last-good leaves the Service exactly as it is")
		}

		By("the admin relaxes the budget: the change lands and the verdict recovers")
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "default"}, p)).To(Succeed())
		p.Spec.Database.ConnectionBudget = 100
		Expect(k8sClient.Update(ctx, p)).To(Succeed())
		reconcileOnce()
		done := get()
		Expect(liveImage()).To(Equal(imageV2))
		ready = apimeta.FindStatusCondition(done.Status.Conditions, ConditionReady)
		Expect(ready.Status).To(Equal(metav1.ConditionTrue))
		rec := apimeta.FindStatusCondition(done.Status.Conditions, ConditionReconciling)
		Expect(rec.Status).To(Equal(metav1.ConditionFalse))
		Expect(rec.ObservedGeneration).To(Equal(newGen))
		Expect(heldGauge(ReasonEffectiveSpecInvalid)).To(Equal(0.0), "a recovered app leaves the held-apps gauge")
		Expect(holdsCounter(ReasonEffectiveSpecInvalid)-holdsBefore).To(Equal(1.0), "recovery is not a new hold")
	})
})
