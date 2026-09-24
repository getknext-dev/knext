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
	"k8s.io/utils/ptr"
	"knative.dev/pkg/apis"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #1332: end-to-end, against a real (envtest) apiserver, that the rendered
// Knative Service's app container carries readOnlyRootFilesystem, the
// explicit writable-path mounts it needs to keep working, and that the
// stamped shape survives Knative's OWN defaulting + validation webhooks —
// the thing the unit-level tests (readonly_rootfs_test.go) cannot prove,
// since they build the ksvc object without ever submitting it.
var _ = Describe("NextApp readOnlyRootFilesystem (#1332)", func() {
	ctx := context.Background()
	const image = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

	reconcileApp := func(name string, security *appsv1alpha1.SecuritySpec, build string) types.NamespacedName {
		nn := types.NamespacedName{Name: name, Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    image,
				Build:    build,
				Security: security,
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				cleanupReconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanupReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
					return errors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
				}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
			}
		})

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		return nn
	}

	It("defaults the app container to readOnlyRootFilesystem: true and mounts /tmp + the image cache", func() {
		nn := reconcileApp("rorf-default", nil, "")

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

		Expect(ksvc.Spec.Template.Spec.Containers).To(HaveLen(1))
		c := ksvc.Spec.Template.Spec.Containers[0]

		Expect(c.SecurityContext).NotTo(BeNil())
		Expect(c.SecurityContext.ReadOnlyRootFilesystem).NotTo(BeNil())
		Expect(*c.SecurityContext.ReadOnlyRootFilesystem).To(BeTrue())

		var mountPaths []string
		for _, m := range c.VolumeMounts {
			mountPaths = append(mountPaths, m.MountPath)
		}
		Expect(mountPaths).To(ContainElement("/tmp"))
		Expect(mountPaths).To(ContainElement("/app/.next/standalone/.next/cache"))

		By("passing Knative's own webhook defaulting + validation, not just this repo's rendering")
		// Filtered to ErrorLevel (the documented pattern, apis.FieldError doc
		// comment): Knative's Validate legitimately returns a non-nil
		// FieldError carrying ONLY warnings when the container's own
		// SecurityContext leaves allowPrivilegeEscalation/capabilities/
		// runAsNonRoot/seccompProfile unset — informational, not a rejection
		// (the live admission webhook admits it, proven separately on kind).
		fetched := ksvc.DeepCopy()
		fetched.SetDefaults(ctx)
		Expect(fetched.Validate(ctx).Filter(apis.ErrorLevel)).To(BeNil())
	})

	It("skips the standalone image-cache mount for the vinext single-executable shape", func() {
		nn := reconcileApp("rorf-vinext", nil, "vinext")

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		c := ksvc.Spec.Template.Spec.Containers[0]

		Expect(c.SecurityContext).NotTo(BeNil())
		Expect(c.SecurityContext.ReadOnlyRootFilesystem).NotTo(BeNil())
		Expect(*c.SecurityContext.ReadOnlyRootFilesystem).To(BeTrue())

		var mountPaths []string
		for _, m := range c.VolumeMounts {
			mountPaths = append(mountPaths, m.MountPath)
		}
		Expect(mountPaths).To(ContainElement("/tmp"))
		Expect(mountPaths).NotTo(ContainElement("/app/.next/standalone/.next/cache"))
	})

	It("disables it and drops the volumes/mounts on explicit spec.security.readOnlyRootFilesystem: false", func() {
		nn := reconcileApp("rorf-disabled", &appsv1alpha1.SecuritySpec{ReadOnlyRootFilesystem: ptr.To(false)}, "")

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		c := ksvc.Spec.Template.Spec.Containers[0]

		Expect(c.SecurityContext).NotTo(BeNil())
		Expect(c.SecurityContext.ReadOnlyRootFilesystem).NotTo(BeNil())
		Expect(*c.SecurityContext.ReadOnlyRootFilesystem).To(BeFalse())
		Expect(c.VolumeMounts).To(BeEmpty())
		Expect(ksvc.Spec.Template.Spec.Volumes).To(BeEmpty())

		// See the sibling case above: filtered to ErrorLevel — the container's
		// own SecurityContext still leaves the OTHER hardening fields unset,
		// which is a Knative warning, not a rejection.
		fetched := ksvc.DeepCopy()
		fetched.SetDefaults(ctx)
		Expect(fetched.Validate(ctx).Filter(apis.ErrorLevel)).To(BeNil())
	})
})
