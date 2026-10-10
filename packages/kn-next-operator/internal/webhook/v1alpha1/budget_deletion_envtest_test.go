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

package v1alpha1

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Real API server, real webhook: lowering the platform's connectionBudget must
// not wedge deletion of an app that was admitted under the old budget. The
// finalizer is removed with a metadata merge patch, exactly as the reconciler
// does it (nextapp_controller.go), and that patch is an UPDATE through the webhook.
var _ = Describe("a lowered connectionBudget (envtest, webhook installed)", Ordered, func() {
	const (
		ns        = "default"
		finalizer = "apps.kn-next.dev/external-cleanup"
		image     = "registry.example.com/app:v1@sha256:abc123def456"
		image2    = "registry.example.com/app:v2@sha256:def456abc123"
	)
	ctx := context.Background()

	setBudget := func(n int32) {
		p := &platformv1alpha1.KnextPlatform{}
		err := k8sClient.Get(ctx, client.ObjectKey{Name: platformv1alpha1.SingletonName}, p)
		if apierrors.IsNotFound(err) {
			p = &platformv1alpha1.KnextPlatform{
				ObjectMeta: metav1.ObjectMeta{Name: platformv1alpha1.SingletonName},
				Spec: platformv1alpha1.KnextPlatformSpec{
					Database: &platformv1alpha1.PlatformDatabase{ConnectionBudget: n},
				},
			}
			Expect(k8sClient.Create(ctx, p)).To(Succeed())
			return
		}
		Expect(err).NotTo(HaveOccurred())
		p.Spec.Database = &platformv1alpha1.PlatformDatabase{ConnectionBudget: n}
		Expect(k8sClient.Update(ctx, p)).To(Succeed())
	}

	mkApp := func(name string, maxScale, poolMax int32) *appsv1alpha1.NextApp {
		return &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Finalizers: []string{finalizer}},
			Spec: appsv1alpha1.NextAppSpec{
				Image:   image,
				Scaling: &appsv1alpha1.ScalingSpec{MaxScale: maxScale, PoolMax: poolMax},
			},
		}
	}

	BeforeAll(func() {
		setBudget(160)
		DeferCleanup(func() {
			p := &platformv1alpha1.KnextPlatform{ObjectMeta: metav1.ObjectMeta{Name: platformv1alpha1.SingletonName}}
			Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, p))).To(Succeed())
		})
	})

	It("lets an over-budget app be deleted: the finalizer-removal patch passes and the object is gone", func() {
		app := mkApp("wedge-delete", 10, 10) // wall 100, admitted under 160
		Expect(k8sClient.Create(ctx, app)).To(Succeed())

		setBudget(40) // the app is now over budget
		// The webhook reads the platform live; wait until the lowered budget bites.
		Eventually(func() error {
			probe := mkApp("wedge-probe", 10, 10)
			probe.Finalizers = nil
			err := k8sClient.Create(ctx, probe)
			if err == nil {
				_ = k8sClient.Delete(ctx, probe)
			}
			return err
		}, 10*time.Second, 200*time.Millisecond).Should(HaveOccurred())

		Expect(k8sClient.Delete(ctx, app)).To(Succeed())
		got := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(app), got)).To(Succeed())
		Expect(got.DeletionTimestamp).NotTo(BeNil(), "the finalizer holds the object in Terminating")

		patch := client.MergeFrom(got.DeepCopy())
		got.Finalizers = nil
		Expect(k8sClient.Patch(ctx, got, patch)).To(Succeed(), "finalizer removal must pass the webhook")

		Eventually(func() bool {
			err := k8sClient.Get(ctx, client.ObjectKeyFromObject(app), &appsv1alpha1.NextApp{})
			return apierrors.IsNotFound(err)
		}, 10*time.Second, 200*time.Millisecond).Should(BeTrue(), "the object is gone")
	})

	It("admits a metadata-only update, and an image-only update, of an over-budget app", func() {
		setBudget(160)
		app := mkApp("wedge-meta", 10, 10)
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		DeferCleanup(func() {
			got := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, client.ObjectKeyFromObject(app), got); err != nil {
				return
			}
			_ = k8sClient.Delete(ctx, got)
			patch := client.MergeFrom(got.DeepCopy())
			got.Finalizers = nil
			_ = k8sClient.Patch(ctx, got, patch)
		})

		setBudget(40)
		Eventually(func() error {
			probe := mkApp("wedge-probe2", 10, 10)
			probe.Finalizers = nil
			err := k8sClient.Create(ctx, probe)
			if err == nil {
				_ = k8sClient.Delete(ctx, probe)
			}
			return err
		}, 10*time.Second, 200*time.Millisecond).Should(HaveOccurred())

		got := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(app), got)).To(Succeed())
		got.Labels = map[string]string{"team": "a"}
		Expect(k8sClient.Update(ctx, got)).To(Succeed(), "metadata-only update")

		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(app), got)).To(Succeed())
		got.Spec.Image = image2
		Expect(k8sClient.Update(ctx, got)).To(Succeed(), "image-only update (ratchet)")

		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(app), got)).To(Succeed())
		got.Spec.Scaling.MaxScale = 11
		err := k8sClient.Update(ctx, got)
		Expect(err).To(HaveOccurred(), "raising the footprint above the budget is still rejected")
		Expect(err.Error()).To(ContainSubstring("budget"))
	})
})
