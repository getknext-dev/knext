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
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ADR-0037 lifecycle: the operator reconciles a `<app>-imgcache` DaemonSet on
// spec.scaling.imagePrewarm=true (correct digest, owner ref, distroless-safe
// container wiring), UPDATES it on a digest change, and DELETES it when the
// field is cleared. The full no-`Pulling`-event-on-cold-start proof is OKE-bound
// (a real node image cache) and lives in the scale-to-zero e2e; this envtest
// covers the reconcile contract that gates the merge.
var _ = Describe("Image-prewarm DaemonSet (ADR-0037)", func() {
	ctx := context.Background()
	const image = "registry.example.com/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const image2 = "registry.example.com/app@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

	newReconciler := func() *NextAppReconciler {
		return &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: record.NewFakeRecorder(64),
		}
	}

	dsKey := func(nn types.NamespacedName) types.NamespacedName {
		return types.NamespacedName{Name: nn.Name + "-imgcache", Namespace: nn.Namespace}
	}

	It("creates the DaemonSet when imagePrewarm=true, owner-referenced, with the app digest and distroless-safe wiring", func() {
		nn := types.NamespacedName{Name: "prewarm-on", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:   image,
				Scaling: &appsv1alpha1.ScalingSpec{ImagePrewarm: true},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		ds := &appsv1.DaemonSet{}
		Expect(k8sClient.Get(ctx, dsKey(nn), ds)).To(Succeed())

		// Owner-referenced to the NextApp so it is GC'd on delete.
		Expect(ds.OwnerReferences).To(HaveLen(1))
		Expect(ds.OwnerReferences[0].Name).To(Equal(nn.Name))
		Expect(ds.OwnerReferences[0].Kind).To(Equal("NextApp"))

		spec := ds.Spec.Template.Spec
		Expect(spec.Containers).To(HaveLen(1))
		main := spec.Containers[0]
		// MAIN container runs the exact app digest so kubelet pulls + pins it.
		Expect(main.Image).To(Equal(image))
		// DISTROLESS-SAFETY: the main command must be the copied static helper,
		// NOT the app entrypoint — the app server must never boot.
		Expect(main.Command).NotTo(BeEmpty())
		Expect(main.Command[0]).To(Equal(prewarmHelperBinary))
		Expect(spec.InitContainers).To(HaveLen(1))
		Expect(spec.InitContainers[0].Image).NotTo(Equal(image))
		// Security hardening.
		Expect(spec.AutomountServiceAccountToken).NotTo(BeNil())
		Expect(*spec.AutomountServiceAccountToken).To(BeFalse())
		Expect(*main.SecurityContext.ReadOnlyRootFilesystem).To(BeTrue())
		Expect(*main.SecurityContext.RunAsNonRoot).To(BeTrue())
	})

	It("updates the DaemonSet's app image when the NextApp digest changes", func() {
		nn := types.NamespacedName{Name: "prewarm-update", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:   image,
				Scaling: &appsv1alpha1.ScalingSpec{ImagePrewarm: true},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		// Flip to a new digest (a new revision).
		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		fetched.Spec.Image = image2
		Expect(k8sClient.Update(ctx, fetched)).To(Succeed())

		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		ds := &appsv1.DaemonSet{}
		Expect(k8sClient.Get(ctx, dsKey(nn), ds)).To(Succeed())
		Expect(ds.Spec.Template.Spec.Containers[0].Image).To(Equal(image2),
			"the prewarmer must re-pull the new digest so cold starts skip the pull")
	})

	It("deletes the DaemonSet when imagePrewarm is turned off", func() {
		nn := types.NamespacedName{Name: "prewarm-off", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:   image,
				Scaling: &appsv1alpha1.ScalingSpec{ImagePrewarm: true},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, dsKey(nn), &appsv1.DaemonSet{})).To(Succeed())

		// Turn prewarm off.
		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		fetched.Spec.Scaling.ImagePrewarm = false
		Expect(k8sClient.Update(ctx, fetched)).To(Succeed())

		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		err = k8sClient.Get(ctx, dsKey(nn), &appsv1.DaemonSet{})
		Expect(errors.IsNotFound(err)).To(BeTrue(), "DaemonSet must be deleted when imagePrewarm is cleared")
	})

	It("never creates a DaemonSet when imagePrewarm is unset (opt-in)", func() {
		nn := types.NamespacedName{Name: "prewarm-default", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec:       appsv1alpha1.NextAppSpec{Image: image},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		err = k8sClient.Get(ctx, dsKey(nn), &appsv1.DaemonSet{})
		Expect(errors.IsNotFound(err)).To(BeTrue(), "prewarm is opt-in; no DaemonSet by default")
	})

	It("threads the app ServiceAccount's imagePullSecrets onto the DaemonSet", func() {
		nn := types.NamespacedName{Name: "prewarm-pull", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:   image,
				Scaling: &appsv1alpha1.ScalingSpec{ImagePrewarm: true},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		// First reconcile creates the app SA; stamp a pull secret on it, then
		// reconcile again so the prewarmer inherits it.
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		sa := &corev1.ServiceAccount{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: nn.Name + "-sa", Namespace: nn.Namespace}, sa)).To(Succeed())
		sa.ImagePullSecrets = []corev1.LocalObjectReference{{Name: "ocir-creds"}}
		Expect(k8sClient.Update(ctx, sa)).To(Succeed())

		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		ds := &appsv1.DaemonSet{}
		Expect(k8sClient.Get(ctx, dsKey(nn), ds)).To(Succeed())
		Expect(ds.Spec.Template.Spec.ImagePullSecrets).To(ContainElement(corev1.LocalObjectReference{Name: "ocir-creds"}))
	})
})
