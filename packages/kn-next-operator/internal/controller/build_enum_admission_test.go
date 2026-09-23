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

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #1219 — `spec.build` gains a THIRD selectable value, "webpack": a second
// spelling of the standalone shape (`next build --webpack` emits the same
// `.next/standalone` tree as the existing "turbopack" value). This suite
// exercises the apiserver-enforced half of that change: envtest loads the
// REAL generated CRD (`config/crd/bases/apps.kn-next.dev_nextapps.yaml`,
// suite_test.go's CRDDirectoryPaths), so `Create` here goes through the same
// `+kubebuilder:validation:Enum` admission a real cluster applies — not a
// hand-rolled string check that could drift from the CRD.
var _ = Describe("NextApp spec.build admission (#1219)", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)

	ctx := context.Background()

	It("ADMITS spec.build: \"webpack\" — the CRD enum now includes it", func() {
		name := "build-enum-webpack"
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: validImage,
				Build: "webpack",
			},
		}
		Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())
		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
			}
		})

		// Round-trips exactly, not coerced or dropped.
		stored := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, stored)).To(Succeed())
		Expect(stored.Spec.Build).To(Equal("webpack"))
	})

	// Both halves, deliberately: widening the enum must not also widen it to
	// "anything" — a builder id the CLI's artifact contract has never heard of
	// must still be REJECTED at admission, exactly as it was before this
	// change. Without this, a passing "webpack admitted" test alone would
	// stay green even if the enum had been dropped entirely (open string).
	It("still REJECTS an unrecognised build value — the enum is not open", func() {
		name := "build-enum-unknown"
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: validImage,
				Build: "rollup",
			},
		}
		err := k8sClient.Create(ctx, nextApp)
		Expect(err).To(HaveOccurred())
		Expect(errors.IsInvalid(err)).To(BeTrue())
		Expect(err.Error()).To(ContainSubstring("build"))
	})

	// The pre-existing values are unaffected — widening the enum is additive,
	// not a rewrite. Both prior values asserted so neither can silently regress.
	It("still admits the pre-existing values, turbopack and vinext", func() {
		for _, build := range []string{"turbopack", "vinext"} {
			name := "build-enum-" + build
			nn := types.NamespacedName{Name: name, Namespace: namespace}
			nextApp := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
				Spec: appsv1alpha1.NextAppSpec{
					Image: validImage,
					Build: build,
				},
			}
			Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())
			DeferCleanup(func() {
				cur := &appsv1alpha1.NextApp{}
				if err := k8sClient.Get(ctx, nn, cur); err == nil {
					Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				}
			})
		}
	})
})
