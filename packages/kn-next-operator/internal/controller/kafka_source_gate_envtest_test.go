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
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #475 — the operator must NEVER create a KafkaSource whose sink is the unbuilt
// `{app}-revalidator` Knative Service. The gate is a spec PRECONDITION in
// validation.ValidateNextAppSpec, so the admission webhook rejects the write AND
// the fail-closed reconciler refuses to act on a CR that predates the gate —
// which is what makes "never creates a dangling source" a property of the
// operator rather than of the webhook being reachable.
//
// The envtest environment DOES install a KafkaSource CRD fixture
// (config/testdata/crds/kafkasources.sources.knative.dev.yaml), so the
// reconciler is genuinely able to create one here: an empty list is evidence
// the gate held, not evidence the kind was unresolvable.
var _ = Describe("KafkaSource admission gate (#475)", func() {
	ctx := context.Background()
	const image = "registry.example.com/app@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

	newReconciler := func() *NextAppReconciler {
		return &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: record.NewFakeRecorder(64),
		}
	}

	listKafkaSources := func(ns string) *unstructured.UnstructuredList {
		list := &unstructured.UnstructuredList{}
		list.SetAPIVersion("sources.knative.dev/v1beta1")
		list.SetKind("KafkaSourceList")
		Expect(k8sClient.List(ctx, list, client.InNamespace(ns))).To(Succeed())
		return list
	}

	It("refuses to reconcile a stored CR with provisionKafkaSource=true and creates no KafkaSource", func() {
		nn := types.NamespacedName{Name: "kafka-gate-on", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: image,
				Revalidation: &appsv1alpha1.RevalidationSpec{
					Queue:                "kafka",
					KafkaBrokerUrl:       "kafka.default.svc:9092",
					ProvisionKafkaSource: ptr.To(true),
				},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("provisionKafkaSource"))
		Expect(err.Error()).To(ContainSubstring("not implemented"))

		// No dangling source anywhere in the namespace.
		Expect(listKafkaSources(nn.Namespace).Items).To(BeEmpty())

		// The single sanctioned inline precondition branch reports it honestly.
		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		degraded := apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionDegraded)
		Expect(degraded).NotTo(BeNil())
		Expect(degraded.Status).To(Equal(metav1.ConditionTrue))
		Expect(degraded.Reason).To(Equal("InvalidSpec"))
	})

	It("leaves the honest RevalidationDeferred status untouched for the unset case", func() {
		nn := types.NamespacedName{Name: "kafka-gate-off", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: image,
				Revalidation: &appsv1alpha1.RevalidationSpec{
					Queue:          "kafka",
					KafkaBrokerUrl: "kafka.default.svc:9092",
				},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		for _, item := range listKafkaSources(nn.Namespace).Items {
			Expect(item.GetName()).NotTo(Equal(nn.Name + "-revalidation-source"))
		}

		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		deferredCond := apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionRevalidationDeferred)
		Expect(deferredCond).NotTo(BeNil())
		Expect(deferredCond.Status).To(Equal(metav1.ConditionTrue))
		Expect(deferredCond.Reason).To(Equal("ConsumerNotProvisioned"))
	})
})
