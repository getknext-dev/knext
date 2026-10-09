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
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// PrivateExposure end-to-end through Reconcile against a real apiserver: a
// Knative DomainMapping targeting a cluster-local NextApp's ksvc publishes it
// on the public ingress, so the operator must surface a Warning condition —
// and never touch the user's DomainMapping.
var _ = Describe("PrivateExposure condition (DomainMapping publishes a private app)", func() {
	ctx := context.Background()
	const namespace = "default"
	const image = "registry.example.com/app@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

	reconcileOnce := func(name string) {
		r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: record.NewFakeRecorder(64)}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: name, Namespace: namespace}})
		Expect(err).NotTo(HaveOccurred())
	}

	newApp := func(name string, private bool) types.NamespacedName {
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec:       appsv1alpha1.NextAppSpec{Image: image},
		}
		if private {
			app.Spec.Networking = &appsv1alpha1.NetworkingSpec{Visibility: appsv1alpha1.VisibilityClusterLocal}
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		DeferCleanup(func() { deleteAndFinalize(ctx, nn) })
		return nn
	}

	createDM := func(dmName, target string) {
		d := dm(namespace, dmName, target)
		Expect(k8sClient.Create(ctx, d)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, d) })
	}

	exposure := func(nn types.NamespacedName) *metav1.Condition {
		got := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, got)).To(Succeed())
		return apimeta.FindStatusCondition(got.Status.Conditions, ConditionPrivateExposure)
	}

	It("sets the condition for cluster-local app + matching DomainMapping, then clears it when the DomainMapping is deleted", func() {
		nn := newApp("pe-private", true)
		reconcileOnce(nn.Name)
		Expect(exposure(nn)).To(BeNil())

		createDM("pe-private.example.com", nn.Name)
		reconcileOnce(nn.Name)
		c := exposure(nn)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionTrue))
		Expect(c.Reason).To(Equal(ReasonDomainMappingPublishesPrivateApp))
		Expect(c.Message).To(ContainSubstring("pe-private.example.com"))

		// The operator must NOT mutate or delete the user's DomainMapping.
		d := dm(namespace, "pe-private.example.com", nn.Name)
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: d.Name, Namespace: namespace}, d)).To(Succeed())
		Expect(d.DeletionTimestamp.IsZero()).To(BeTrue())
		Expect(d.Spec.Ref.Name).To(Equal(nn.Name))

		Expect(k8sClient.Delete(ctx, d)).To(Succeed())
		reconcileOnce(nn.Name)
		Expect(exposure(nn)).To(BeNil())
	})

	It("does not flag a PUBLIC app that has a DomainMapping", func() {
		nn := newApp("pe-public", false)
		createDM("pe-public.example.com", nn.Name)
		reconcileOnce(nn.Name)
		Expect(exposure(nn)).To(BeNil())
	})

	It("does not flag a private app when the DomainMapping targets another service", func() {
		nn := newApp("pe-private-other", true)
		createDM("pe-elsewhere.example.com", "some-other-service")
		reconcileOnce(nn.Name)
		Expect(exposure(nn)).To(BeNil())
	})
})
