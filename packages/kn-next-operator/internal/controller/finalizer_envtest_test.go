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
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// deleteAndFinalize deletes the named NextApp (if present) and drives reconciles
// until it is GC'd, so the external-cleanup finalizer (issue #74) is processed.
// Shared by the AfterEach blocks across the controller test suite.
func deleteAndFinalize(ctx context.Context, nn types.NamespacedName) {
	cur := &appsv1alpha1.NextApp{}
	if err := k8sClient.Get(ctx, nn, cur); err != nil {
		return
	}
	Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
	r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
	Eventually(func() bool {
		_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		return errors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
	}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
}

var _ = Describe("NextApp deletion finalizer", func() {
	const resourceName = "finalizer-app"
	ctx := context.Background()
	nn := types.NamespacedName{Name: resourceName, Namespace: "default"}

	It("adds the finalizer on create and removes it (clearing external state) on delete", func() {
		By("creating the NextApp")
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: resourceName, Namespace: "default"},
			Spec: appsv1alpha1.NextAppSpec{
				Image: "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
				Storage: &appsv1alpha1.StorageSpec{
					Provider: "s3",
					Bucket:   "shared-bucket",
				},
				Cache: &appsv1alpha1.CacheSpec{
					Provider:  "redis",
					URL:       "redis://redis:6379",
					KeyPrefix: resourceName,
				},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())

		fc := &fakeCleaner{}
		r := &NextAppReconciler{
			Client:  k8sClient,
			Scheme:  k8sClient.Scheme(),
			Cleaner: fc,
		}

		By("reconciling — the finalizer must be added")
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(controllerutil.ContainsFinalizer(fetched, ExternalCleanupFinalizer)).To(BeTrue(),
			"finalizer should be present after reconcile")

		By("deleting the NextApp — deletion is paused by the finalizer")
		Expect(k8sClient.Delete(ctx, fetched)).To(Succeed())

		// The object must STILL exist (finalizer not yet removed).
		stillThere := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, stillThere)).To(Succeed())
		Expect(stillThere.DeletionTimestamp).NotTo(BeNil())

		By("reconciling the delete — external cleanup runs, then finalizer is removed")
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		// External cleanup was invoked, scoped to THIS app.
		Expect(fc.cacheCalls).To(HaveLen(1))
		Expect(fc.cacheCalls[0].keyPrefix).To(Equal(resourceName))
		Expect(fc.storageCalls).To(HaveLen(1))
		Expect(fc.storageCalls[0].prefix).To(Equal(resourceName + "/"))

		By("the object is gone only AFTER the finalizer ran")
		gone := &appsv1alpha1.NextApp{}
		err = k8sClient.Get(ctx, nn, gone)
		Expect(errors.IsNotFound(err)).To(BeTrue(), "object should be GC'd once finalizer removed")
	})
})
