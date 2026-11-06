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
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/types"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

var _ = Describe("NextApp Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default",
		}
		nextapp := &appsv1alpha1.NextApp{}

		BeforeEach(func() {
			By("creating the custom resource for the Kind NextApp")
			err := k8sClient.Get(ctx, typeNamespacedName, nextapp)
			if err != nil && errors.IsNotFound(err) {
				resource := &appsv1alpha1.NextApp{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: appsv1alpha1.NextAppSpec{
						// A digest-pinned image is required by validateImageRef (A1-digest).
						Image: validImage,
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			By("Cleanup the specific resource instance NextApp")
			// deleteAndFinalize drives the delete-reconcile so the external-cleanup
			// finalizer (issue #74) is removed and the object is GC'd.
			deleteAndFinalize(ctx, typeNamespacedName)
		})
		It("adds the finalizer, creates the child Knative Service and sets a verdict condition", func() {
			By("Reconciling the created resource")
			controllerReconciler := &NextAppReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			fetched := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, typeNamespacedName, fetched)).To(Succeed())

			By("the external-cleanup finalizer was added")
			Expect(controllerutil.ContainsFinalizer(fetched, ExternalCleanupFinalizer)).To(BeTrue())

			By("exactly one child Knative Service exists, owned by the NextApp")
			svcs := &servingv1.ServiceList{}
			Expect(k8sClient.List(ctx, svcs, client.InNamespace(typeNamespacedName.Namespace))).To(Succeed())
			var children []servingv1.Service
			for _, svc := range svcs.Items {
				if metav1.IsControlledBy(&svc, fetched) {
					children = append(children, svc)
				}
			}
			Expect(children).To(HaveLen(1))
			Expect(children[0].Name).To(Equal(resourceName))

			By("computeStatusVerdict set the Ready condition (envtest runs no Knative controller, so the child is not Ready)")
			ready := apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionReady)
			Expect(ready).NotTo(BeNil(), "Ready condition must be set by the status verdict")
			Expect(ready.Status).To(Equal(metav1.ConditionFalse))
			Expect(ready.Reason).To(Equal("KnativeServiceNotReady"))
		})
	})
})
