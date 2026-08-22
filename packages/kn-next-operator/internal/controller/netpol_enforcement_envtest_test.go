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
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #744: the operator writes a default-on NetworkPolicy, but on flannel (OKE
// GA, OrbStack) nothing enforces it, and until the NetworkPolicyEnforced
// condition nothing said so at runtime. This envtest proves the condition
// end-to-end through Reconcile — including the UNENFORCED half, not just the
// happy one — against a real apiserver whose DaemonSets are the detection
// signal.
var _ = Describe("NetworkPolicyEnforced condition (#744)", func() {
	ctx := context.Background()
	const image = "registry.example.com/app@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

	newReconciler := func() *NextAppReconciler {
		return &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: record.NewFakeRecorder(64),
		}
	}

	cniDaemonSet := func(name string) *appsv1.DaemonSet {
		labels := map[string]string{"app": name}
		return &appsv1.DaemonSet{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "kube-system"},
			Spec: appsv1.DaemonSetSpec{
				Selector: &metav1.LabelSelector{MatchLabels: labels},
				Template: corev1.PodTemplateSpec{
					ObjectMeta: metav1.ObjectMeta{Labels: labels},
					Spec: corev1.PodSpec{Containers: []corev1.Container{
						{Name: name, Image: "registry.example.com/cni@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
					}},
				},
			},
		}
	}

	getCondition := func(nn types.NamespacedName) *metav1.Condition {
		fetched := &appsv1alpha1.NextApp{}
		ExpectWithOffset(1, k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		return apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionNetworkPolicyEnforced)
	}

	It("reports Unknown/CannotDetermine when no CNI signature exists (the honest fallback)", func() {
		nn := types.NamespacedName{Name: "netpol-unknown", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec:       appsv1alpha1.NextAppSpec{Image: image},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		_, err := newReconciler().Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		c := getCondition(nn)
		Expect(c).NotTo(BeNil(), "default-on NetworkPolicy must surface an enforcement verdict")
		Expect(c.Status).To(Equal(metav1.ConditionUnknown))
		Expect(c.Reason).To(Equal(ReasonEnforcementUnknown))
		Expect(c.Message).To(ContainSubstring("unenforced"),
			"cannot-determine must tell the reader to treat the policy as unenforced")
	})

	It("reports False/NoPolicyController on flannel, then True once a policy controller appears", func() {
		flannel := cniDaemonSet("kube-flannel-ds")
		Expect(k8sClient.Create(ctx, flannel)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, flannel) })

		nn := types.NamespacedName{Name: "netpol-flannel", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec:       appsv1alpha1.NextAppSpec{Image: image},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		// The UNENFORCED half — the case #744 exists for.
		c := getCondition(nn)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonNoPolicyController))
		Expect(c.Message).To(ContainSubstring("declarative only"))
		Expect(c.Message).To(ContainSubstring("kube-flannel-ds"))

		// A policy controller arrives (e.g. Calico installed): next reconcile
		// flips the verdict to enforced.
		calico := cniDaemonSet("calico-node")
		Expect(k8sClient.Create(ctx, calico)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, calico) })

		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		c = getCondition(nn)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionTrue))
		Expect(c.Reason).To(Equal(ReasonPolicyControllerDetected))
		Expect(c.Message).To(ContainSubstring("calico-node"))
	})

	It("reports nothing when the NetworkPolicy is disabled", func() {
		nn := types.NamespacedName{Name: "netpol-disabled", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    image,
				Security: &appsv1alpha1.SecuritySpec{NetworkPolicy: ptr.To(false)},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		_, err := newReconciler().Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		Expect(getCondition(nn)).To(BeNil(),
			"no NetworkPolicy is reconciled, so no enforcement claim may appear")
	})
})
