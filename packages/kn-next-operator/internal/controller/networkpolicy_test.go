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
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

var _ = Describe("NextApp NetworkPolicy reconciliation", func() {
	ctx := context.Background()

	// reconcileApp creates the NextApp with the given security spec, reconciles
	// it once, and returns the namespaced name. Cleanup is registered via
	// DeferCleanup so the external-cleanup finalizer is driven correctly.
	reconcileApp := func(name string, security *appsv1alpha1.SecuritySpec) types.NamespacedName {
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
			deleteAndFinalize(ctx, nn)
		})

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		return nn
	}

	policyName := func(app string) types.NamespacedName {
		return types.NamespacedName{Name: app + "-allow-ingress", Namespace: "default"}
	}

	It("creates an owner-referenced in-cluster-only NetworkPolicy by default (Security nil)", func() {
		nn := reconcileApp("np-default", nil)

		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, policyName(nn.Name), np)).To(Succeed())

		By("targeting the app's Knative serving pods via podSelector")
		Expect(np.Spec.PodSelector.MatchLabels).To(HaveKeyWithValue("serving.knative.dev/service", nn.Name))

		By("declaring an Ingress policy type")
		Expect(np.Spec.PolicyTypes).To(ContainElement(networkingv1.PolicyTypeIngress))

		By("restricting ingress to in-cluster sources (knative-serving + gateway + same namespace)")
		Expect(np.Spec.Ingress).To(HaveLen(1))
		froms := np.Spec.Ingress[0].From
		Expect(froms).NotTo(BeEmpty())

		var nsLabels []string
		sameNamespace := false
		for _, peer := range froms {
			if peer.NamespaceSelector != nil {
				for _, expr := range peer.NamespaceSelector.MatchExpressions {
					if expr.Key == "kubernetes.io/metadata.name" {
						nsLabels = append(nsLabels, expr.Values...)
					}
				}
				for _, v := range peer.NamespaceSelector.MatchLabels {
					nsLabels = append(nsLabels, v)
				}
			}
			// A from-peer with neither selector populated would mean "all sources"
			// in the same namespace; an empty PodSelector with nil NamespaceSelector
			// means same-namespace-only.
			if peer.NamespaceSelector == nil && peer.PodSelector != nil {
				sameNamespace = true
			}
		}
		Expect(nsLabels).To(ContainElement("knative-serving"))
		Expect(nsLabels).To(ContainElement("kourier-system"))
		Expect(sameNamespace).To(BeTrue(), "expected a same-namespace ingress peer")

		By("owner-referencing the NextApp so it is GC'd on delete")
		Expect(np.OwnerReferences).To(HaveLen(1))
		Expect(np.OwnerReferences[0].Kind).To(Equal("NextApp"))
		Expect(np.OwnerReferences[0].Name).To(Equal(nn.Name))
	})

	It("creates the NetworkPolicy when Security.NetworkPolicy is explicitly true", func() {
		nn := reconcileApp("np-explicit-true", &appsv1alpha1.SecuritySpec{NetworkPolicy: ptr.To(true)})

		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, policyName(nn.Name), np)).To(Succeed())
		Expect(np.Spec.PodSelector.MatchLabels).To(HaveKeyWithValue("serving.knative.dev/service", nn.Name))
	})

	It("does not create the NetworkPolicy when Security.NetworkPolicy is false", func() {
		nn := reconcileApp("np-disabled", &appsv1alpha1.SecuritySpec{NetworkPolicy: ptr.To(false)})

		np := &networkingv1.NetworkPolicy{}
		err := k8sClient.Get(ctx, policyName(nn.Name), np)
		Expect(errors.IsNotFound(err)).To(BeTrue(), "expected no NetworkPolicy when disabled")
	})

	It("deletes a previously-created NetworkPolicy when toggled to false", func() {
		nn := reconcileApp("np-toggle", nil)

		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, policyName(nn.Name), np)).To(Succeed())

		By("toggling NetworkPolicy off and re-reconciling")
		app := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, app)).To(Succeed())
		app.Spec.Security = &appsv1alpha1.SecuritySpec{NetworkPolicy: ptr.To(false)}
		Expect(k8sClient.Update(ctx, app)).To(Succeed())

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		err = k8sClient.Get(ctx, policyName(nn.Name), np)
		Expect(errors.IsNotFound(err)).To(BeTrue(), "expected NetworkPolicy removed after toggle to false")
	})
})
