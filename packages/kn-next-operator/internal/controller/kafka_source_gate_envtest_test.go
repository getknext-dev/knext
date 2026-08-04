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
	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #475 — the operator must NEVER create a KafkaSource whose sink is the unbuilt
// `{app}-revalidator` Knative Service. The instrument is INERTNESS, not
// rejection: `revalidationDeferred` ignores `provisionKafkaSource` entirely, so
// the reconciler's KafkaSource block is unreachable through the guard it already
// has, while the CR keeps applying and the app keeps reconciling.
//
// Rejecting instead would have narrowed `v1alpha1` in place (ADR-0017 §2.1) and
// wedged stored CRs: the validation gate returns before database binding, the
// ksvc, the NetworkPolicy and the warm-floor, so an app carrying the flag would
// stop being reconciled entirely on operator upgrade with no user action. The
// "still reconciles" assertions below are the regression guard for that wedge —
// they are the half that would go green again if someone re-added a rejection,
// so they assert the ksvc EXISTS, not merely that no error was returned.
//
// The envtest environment DOES install a KafkaSource CRD fixture
// (config/testdata/crds/kafkasources.sources.knative.dev.yaml), so the
// reconciler is genuinely able to create one here: an empty list is evidence
// the flag is inert, not evidence the kind was unresolvable.
var _ = Describe("KafkaSource inertness (#475)", func() {
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

	It("ignores provisionKafkaSource=true: no KafkaSource, app still fully reconciled, withdrawal surfaced", func() {
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

		recorder := record.NewFakeRecorder(64)
		r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		// No dangling source anywhere in the namespace.
		Expect(listKafkaSources(nn.Namespace).Items).To(BeEmpty())

		// ANTI-WEDGE: the app is still reconciled end-to-end. A rejection on the
		// shared validation path returns before this child is created, so the ksvc
		// existing is what proves the CR did not stop being reconciled.
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		Expect(ksvc.Spec.Template.Spec.Containers[0].Image).To(Equal(image))

		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())

		// An inert field is NOT an invalid spec: whatever the child ksvc's health
		// says (envtest runs no Knative controllers, so it is legitimately not
		// Ready here), the app must never be degraded for InvalidSpec — that reason
		// is the fingerprint of the rejection this change replaced.
		degraded := apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionDegraded)
		Expect(degraded).NotTo(BeNil())
		Expect(degraded.Reason).NotTo(Equal("InvalidSpec"))

		// The withdrawal is surfaced honestly, with its own reason.
		deferredCond := apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionRevalidationDeferred)
		Expect(deferredCond).NotTo(BeNil())
		Expect(deferredCond.Status).To(Equal(metav1.ConditionTrue))
		Expect(deferredCond.Reason).To(Equal(ReasonProvisionKafkaSourceInert))

		// ...and as a Warning event, so `kubectl describe nextapp` shows it.
		Expect(drainEvents(recorder)).To(ContainElement(SatisfyAll(
			ContainSubstring(corev1.EventTypeWarning),
			ContainSubstring(ReasonProvisionKafkaSourceInert),
		)))
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
