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
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/prometheus/client_golang/prometheus/testutil"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// drainEvents collects all currently-buffered events from a FakeRecorder without blocking.
func drainEvents(rec *record.FakeRecorder) []string {
	var events []string
	for {
		select {
		case e := <-rec.Events:
			events = append(events, e)
		default:
			return events
		}
	}
}

var _ = Describe("NextApp Controller Events & Metrics", func() {
	ctx := context.Background()

	Context("on a successful reconcile", func() {
		const resourceName = "events-success"
		nn := types.NamespacedName{Name: resourceName, Namespace: "default"}

		BeforeEach(func() {
			existing := &appsv1alpha1.NextApp{}
			err := k8sClient.Get(ctx, nn, existing)
			if err != nil && errors.IsNotFound(err) {
				resource := &appsv1alpha1.NextApp{
					ObjectMeta: metav1.ObjectMeta{Name: resourceName, Namespace: "default"},
					Spec: appsv1alpha1.NextAppSpec{
						Image: "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			resource := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, resource); err == nil {
				Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
			}
		})

		It("records a Normal Reconciled event and increments the success counter", func() {
			recorder := record.NewFakeRecorder(64)
			before := testutil.ToFloat64(reconcileTotal.WithLabelValues("success"))

			r := &NextAppReconciler{
				Client:   k8sClient,
				Scheme:   k8sClient.Scheme(),
				Recorder: recorder,
			}

			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			events := drainEvents(recorder)
			Expect(events).NotTo(BeEmpty())
			found := false
			for _, e := range events {
				if strings.Contains(e, "Normal") && strings.Contains(e, "Reconciled") {
					found = true
				}
			}
			Expect(found).To(BeTrue(), "expected a Normal Reconciled event, got: %v", events)

			after := testutil.ToFloat64(reconcileTotal.WithLabelValues("success"))
			Expect(after).To(BeNumerically(">", before))
		})
	})

	Context("on a failure path (invalid :latest image)", func() {
		const resourceName = "events-failure"
		nn := types.NamespacedName{Name: resourceName, Namespace: "default"}

		BeforeEach(func() {
			existing := &appsv1alpha1.NextApp{}
			err := k8sClient.Get(ctx, nn, existing)
			if err != nil && errors.IsNotFound(err) {
				resource := &appsv1alpha1.NextApp{
					ObjectMeta: metav1.ObjectMeta{Name: resourceName, Namespace: "default"},
					Spec: appsv1alpha1.NextAppSpec{
						// :latest must be rejected by validateImageRef.
						Image: "registry.example.com/app:latest",
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			resource := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, resource); err == nil {
				Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
			}
		})

		It("records a Warning InvalidImage event and increments the error counter", func() {
			recorder := record.NewFakeRecorder(64)
			before := testutil.ToFloat64(reconcileErrors)

			r := &NextAppReconciler{
				Client:   k8sClient,
				Scheme:   k8sClient.Scheme(),
				Recorder: recorder,
			}

			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).To(HaveOccurred())

			events := drainEvents(recorder)
			Expect(events).NotTo(BeEmpty())
			found := false
			for _, e := range events {
				if strings.Contains(e, "Warning") && strings.Contains(e, "InvalidImage") {
					found = true
				}
			}
			Expect(found).To(BeTrue(), "expected a Warning InvalidImage event, got: %v", events)

			after := testutil.ToFloat64(reconcileErrors)
			Expect(after).To(BeNumerically(">", before))
		})
	})
})
