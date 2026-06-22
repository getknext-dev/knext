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

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// conditionType constants mirror the values set in the reconciler.
const (
	conditionTypeReconciling = "Reconciling"
	conditionTypeReady       = "Ready"
	conditionTypeDegraded    = "Degraded"
)

var _ = Describe("NextApp Status Conditions", func() {
	const (
		resourceName = "conditions-test"
		namespace    = "default"
		// A valid digest-pinned image reference so validateImageRef passes.
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)

	ctx := context.Background()
	namespacedName := types.NamespacedName{Name: resourceName, Namespace: namespace}

	AfterEach(func() {
		resource := &appsv1alpha1.NextApp{}
		if err := k8sClient.Get(ctx, namespacedName, resource); err == nil {
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
			// The external-cleanup finalizer (issue #74) pauses deletion until
			// the operator reconciles the delete; drive a reconcile each poll.
			cleanupReconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			Eventually(func() bool {
				_, _ = cleanupReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
				return errors.IsNotFound(k8sClient.Get(ctx, namespacedName, &appsv1alpha1.NextApp{}))
			}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
		}
	})

	Context("When a NextApp is successfully reconciled", func() {
		It("should set Reconciling=True then Ready=True conditions", func() {
			By("Creating a NextApp with a valid digest-pinned image")
			nextApp := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{
					Name:      resourceName,
					Namespace: namespace,
				},
				Spec: appsv1alpha1.NextAppSpec{
					Image: validImage,
				},
			}
			Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())

			By("Running the reconciler")
			reconciler := &NextAppReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			Expect(err).NotTo(HaveOccurred())

			By("Asserting Status.Conditions are populated")
			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, namespacedName, updated)).To(Succeed())

			Expect(updated.Status.Conditions).NotTo(BeEmpty(),
				"Status.Conditions must be populated after reconciliation")

			By("Finding the Reconciling condition")
			reconcilingCond := findCondition(updated.Status.Conditions, conditionTypeReconciling)
			Expect(reconcilingCond).NotTo(BeNil(), "Reconciling condition must be present")
			Expect(reconcilingCond.ObservedGeneration).To(Equal(updated.Generation),
				"Reconciling.ObservedGeneration must equal the resource generation")

			By("Finding the Ready condition")
			readyCond := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(readyCond).NotTo(BeNil(), "Ready condition must be present")
			Expect(readyCond.Status).To(Equal(metav1.ConditionTrue),
				"Ready condition must be True on a successful reconcile")
			Expect(readyCond.ObservedGeneration).To(Equal(updated.Generation))

			By("Verifying Degraded condition is absent or False after success")
			degradedCond := findCondition(updated.Status.Conditions, conditionTypeDegraded)
			if degradedCond != nil {
				Expect(degradedCond.Status).To(Equal(metav1.ConditionFalse),
					"Degraded condition must be False after a successful reconcile")
			}
		})
	})
})

// findCondition returns the first condition with the given type, or nil.
func findCondition(conditions []metav1.Condition, condType string) *metav1.Condition {
	for i := range conditions {
		if conditions[i].Type == condType {
			return &conditions[i]
		}
	}
	return nil
}
