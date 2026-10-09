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

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// #1865 — spec.networking.visibility renders (and re-asserts, and removes)
// the Knative `networking.knative.dev/visibility: cluster-local` label on the
// child ksvc, through the REAL Reconcile loop against the real envtest
// apiserver (suite_test.go's CRDDirectoryPaths), not just a single call to
// buildDesiredKsvc — "survives reconcile" and "toggling it off removes it"
// are both claims about CreateOrUpdate's behaviour across MULTIPLE
// reconciles against an object that already exists on the cluster, which a
// fresh-ksvc unit test (as preview_annotation_disposition_test.go uses)
// cannot exercise.
var _ = Describe("NextApp spec.networking.visibility (#1865)", func() {
	const namespace = "default"
	const validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	const visibilityLabel = "networking.knative.dev/visibility"

	ctx := context.Background()

	reconcileOnce := func(name string) {
		r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, reconcile.Request{
			NamespacedName: types.NamespacedName{Name: name, Namespace: namespace},
		})
		Expect(err).NotTo(HaveOccurred())
	}

	getKsvcLabels := func(name string) map[string]string {
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, ksvc)).To(Succeed())
		return ksvc.Labels
	}

	It("renders the cluster-local label when spec.networking.visibility is set, and it survives a second reconcile", func() {
		name := "networking-visibility-set"
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:      validImage,
				Networking: &appsv1alpha1.NetworkingSpec{Visibility: appsv1alpha1.VisibilityClusterLocal},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		DeferCleanup(func() { deleteAndFinalize(ctx, nn) })

		reconcileOnce(name)
		Expect(getKsvcLabels(name)).To(HaveKeyWithValue(visibilityLabel, "cluster-local"))

		// Reconcile again against the EXISTING ksvc (CreateOrUpdate's Get path,
		// not Create) — the label must be RE-ASSERTED, not merely a one-time
		// stamp that the next pass leaves alone by accident.
		reconcileOnce(name)
		Expect(getKsvcLabels(name)).To(HaveKeyWithValue(visibilityLabel, "cluster-local"))
	})

	It("renders NO cluster-local label when spec.networking is unset — byte-identical to pre-#1865 CRs", func() {
		name := "networking-visibility-unset"
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: validImage,
				// Networking deliberately left nil.
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		DeferCleanup(func() { deleteAndFinalize(ctx, nn) })

		reconcileOnce(name)
		Expect(getKsvcLabels(name)).NotTo(HaveKey(visibilityLabel))
	})

	It("removes a previously-rendered cluster-local label when visibility is toggled back to unset", func() {
		name := "networking-visibility-toggle-off"
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:      validImage,
				Networking: &appsv1alpha1.NetworkingSpec{Visibility: appsv1alpha1.VisibilityClusterLocal},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		DeferCleanup(func() { deleteAndFinalize(ctx, nn) })

		reconcileOnce(name)
		Expect(getKsvcLabels(name)).To(HaveKeyWithValue(visibilityLabel, "cluster-local"))

		// Flip the field back off and reconcile again: the operator is the
		// label's SOLE writer (ADR-0001), so it must actively DELETE a label
		// it previously rendered rather than leaving it stale on the ksvc.
		current := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, current)).To(Succeed())
		current.Spec.Networking = nil
		Expect(k8sClient.Update(ctx, current)).To(Succeed())

		reconcileOnce(name)
		Expect(getKsvcLabels(name)).NotTo(HaveKey(visibilityLabel))
	})

	It("still REJECTS an unrecognised visibility value at admission — the enum is not open", func() {
		name := "networking-visibility-bad-enum"
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:      validImage,
				Networking: &appsv1alpha1.NetworkingSpec{Visibility: "visible-to-everyone"},
			},
		}
		err := k8sClient.Create(ctx, app)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("visibility"))
	})
})
