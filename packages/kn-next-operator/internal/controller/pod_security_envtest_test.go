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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Pod Security `restricted` on the rendered pods, end to end: a real reconcile
// into a real apiserver (so the stored CRD schema must keep spec.security
// .runAsNonRoot rather than prune it), read back, run through the Kubernetes
// Pod Security evaluator, and through Knative's own defaulting and validation.
var _ = Describe("Pod Security restricted on rendered pods", func() {
	ctx := context.Background()

	restrictedCheck := func(ksvc *servingv1.Service, wantRunAsNonRoot bool) {
		GinkgoHelper()
		Expect(ksvc.Spec.Template.Spec.Containers).To(HaveLen(1))
		c := ksvc.Spec.Template.Spec.Containers[0]
		Expect(c.SecurityContext).NotTo(BeNil())
		sc := c.SecurityContext
		Expect(sc.AllowPrivilegeEscalation).To(Equal(ptr.To(false)))
		Expect(sc.Capabilities).To(Equal(&corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}))
		Expect(sc.SeccompProfile).To(Equal(&corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}))
		if wantRunAsNonRoot {
			Expect(sc.RunAsNonRoot).To(Equal(ptr.To(true)))
		} else {
			Expect(sc.RunAsNonRoot).To(BeNil())
		}
		Expect(ksvc.Spec.Template.Spec.SecurityContext).To(BeNil(),
			"Knative's webhook rejects a pod-level securityContext on a stock install")

		fetched := ksvc.DeepCopy()
		fetched.SetDefaults(ctx)
		Expect(fetched.Validate(ctx).Filter(apis.ErrorLevel)).To(BeNil())

		violations := restrictedViolations(GinkgoT(), revisionPodSpec(ksvc))
		if wantRunAsNonRoot {
			Expect(violations).To(BeEmpty())
		} else {
			Expect(violations).To(HaveLen(1))
			Expect(violations[0]).To(ContainSubstring("runAsNonRoot"))
		}
	}

	reconcileApp := func(name string, security *appsv1alpha1.SecuritySpec) *servingv1.Service {
		nn := types.NamespacedName{Name: name, Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
				Security: security,
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				cleanup := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanup.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
					return errors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
				}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
			}
		})
		_, err := (&NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}).Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		return ksvc
	}

	It("renders a NextApp that the restricted profile admits, by default", func() {
		restrictedCheck(reconcileApp("psa-default", nil), true)
	})

	It("keeps the other three fields when the NextApp opts out of runAsNonRoot", func() {
		restrictedCheck(reconcileApp("psa-optout", &appsv1alpha1.SecuritySpec{RunAsNonRoot: ptr.To(false)}), false)
	})

	It("renders a BackendService that the restricted profile admits", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders")
		reconcileFunction(ctx, ns, "pricing")

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, ksvc)).To(Succeed())
		restrictedCheck(ksvc, true)
	})
})
