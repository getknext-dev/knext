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
	"errors"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
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
		return apierrors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
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
		Expect(apierrors.IsNotFound(err)).To(BeTrue(), "object should be GC'd once finalizer removed")
	})

	It("proceeds with deletion (fail-open) when external cleanup errors — emits ReasonCleanupFailed, removes the finalizer, and the CR is genuinely gone", func() {
		// ADR-0008 fail-OPEN teardown contract: a transient object-store / Redis
		// failure during cleanup MUST NOT wedge the CR in Terminating. On a
		// cleanup error the finalizer emits a ReasonCleanupFailed Warning and
		// PROCEEDS with deletion. This test FORCES the cleanup-failure branch and
		// pins all three guarantees.
		//
		// If the contract ever regressed to fail-CLOSED (cleanup-error =>
		// requeue-forever / finalizer never removed), assertions 2 and 3 below
		// would fail: the CR would linger in Terminating with the finalizer set.
		const failName = "finalizer-app-cleanup-fail"
		failNN := types.NamespacedName{Name: failName, Namespace: "default"}

		By("creating a NextApp with external storage + cache state to clean up")
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: failName, Namespace: "default"},
			Spec: appsv1alpha1.NextAppSpec{
				Image: "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
				Storage: &appsv1alpha1.StorageSpec{
					Provider: "s3",
					Bucket:   "shared-bucket",
				},
				Cache: &appsv1alpha1.CacheSpec{
					Provider:  "redis",
					URL:       "redis://redis:6379",
					KeyPrefix: failName,
				},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())

		// SEAM: fakeCleaner.storageErr / cacheErr force both cleanup collaborators
		// to return an error, driving cleanupExternalState's best-effort branch.
		fc := &fakeCleaner{
			storageErr: errors.New("object store unreachable (injected)"),
			cacheErr:   errors.New("redis unreachable (injected)"),
		}
		rec := record.NewFakeRecorder(64)
		r := &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Cleaner:  fc,
			Recorder: rec,
		}

		By("reconciling — the finalizer must be added")
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: failNN})
		Expect(err).NotTo(HaveOccurred())
		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, failNN, fetched)).To(Succeed())
		Expect(controllerutil.ContainsFinalizer(fetched, ExternalCleanupFinalizer)).To(BeTrue())

		By("deleting the NextApp — deletion is paused by the finalizer")
		Expect(k8sClient.Delete(ctx, fetched)).To(Succeed())
		stillThere := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, failNN, stillThere)).To(Succeed())
		Expect(stillThere.DeletionTimestamp).NotTo(BeNil())

		By("reconciling the delete — cleanup ERRORS, but deletion must proceed (fail-open)")
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: failNN})
		Expect(err).NotTo(HaveOccurred(),
			"cleanup error must NOT surface as a reconcile error — fail-open, not fail-closed")

		// Cleanup was actually attempted (and it failed via the injected errors).
		Expect(fc.storageCalls).To(HaveLen(1))
		Expect(fc.cacheCalls).To(HaveLen(1))

		By("assertion 1: a ReasonCleanupFailed Warning event was emitted")
		events := drainEvents(rec)
		var sawCleanupFailed bool
		for _, e := range events {
			if strings.Contains(e, ReasonCleanupFailed) && strings.Contains(e, "Warning") {
				sawCleanupFailed = true
				break
			}
		}
		Expect(sawCleanupFailed).To(BeTrue(),
			"expected a Warning %s event on cleanup failure; got: %v", ReasonCleanupFailed, events)

		By("assertion 2: the external-cleanup finalizer was removed despite the cleanup error")
		afterReconcile := &appsv1alpha1.NextApp{}
		getErr := k8sClient.Get(ctx, failNN, afterReconcile)
		if getErr == nil {
			Expect(controllerutil.ContainsFinalizer(afterReconcile, ExternalCleanupFinalizer)).To(BeFalse(),
				"finalizer must be removed even when cleanup fails (fail-open)")
		} else {
			Expect(apierrors.IsNotFound(getErr)).To(BeTrue())
		}

		By("assertion 3: the CR is genuinely GONE — not lingering in Terminating")
		gone := &appsv1alpha1.NextApp{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, failNN, gone))).To(BeTrue(),
			"CR must be fully deleted after a fail-open cleanup — never stuck Terminating")
	})
})
