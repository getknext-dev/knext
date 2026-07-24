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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #457 — the opt-in bytecode-cache PVC path (spec.cache.enableBytecodeCache) is
// DEPRECATED in favour of the image-baked V8 compile cache (ADR-0035). The path
// still works exactly as before; the reconciler now emits a Warning Event so
// operators depending on it get a migration signal. These tests pin that the
// warning fires when the field is set and is silent when it is unset/false.
var _ = Describe("Bytecode-cache PVC deprecation warning (#457)", func() {
	ctx := context.Background()
	const validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

	newApp := func(name string, cache *appsv1alpha1.CacheSpec) types.NamespacedName {
		nn := types.NamespacedName{Name: name, Namespace: "default"}
		existing := &appsv1alpha1.NextApp{}
		if err := k8sClient.Get(ctx, nn, existing); err != nil && errors.IsNotFound(err) {
			resource := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
				Spec: appsv1alpha1.NextAppSpec{
					Image: validImage,
					Cache: cache,
				},
			}
			Expect(k8sClient.Create(ctx, resource)).To(Succeed())
		}
		return nn
	}

	hasDeprecationWarning := func(events []string) bool {
		for _, e := range events {
			if strings.Contains(e, "Warning") && strings.Contains(e, "DeprecatedBytecodeCachePVC") {
				return true
			}
		}
		return false
	}

	It("emits a Warning DeprecatedBytecodeCachePVC event when EnableBytecodeCache is true", func() {
		nn := newApp("bytecode-deprecated-on", &appsv1alpha1.CacheSpec{EnableBytecodeCache: true})
		DeferCleanup(func() { deleteAndFinalize(ctx, nn) })

		recorder := record.NewFakeRecorder(64)
		r := &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: recorder,
		}

		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		events := drainEvents(recorder)
		Expect(hasDeprecationWarning(events)).To(BeTrue(),
			"expected a Warning DeprecatedBytecodeCachePVC event, got: %v", events)
	})

	It("does NOT emit the deprecation warning when EnableBytecodeCache is false", func() {
		nn := newApp("bytecode-deprecated-off", &appsv1alpha1.CacheSpec{EnableBytecodeCache: false})
		DeferCleanup(func() { deleteAndFinalize(ctx, nn) })

		recorder := record.NewFakeRecorder(64)
		r := &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: recorder,
		}

		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		events := drainEvents(recorder)
		Expect(hasDeprecationWarning(events)).To(BeFalse(),
			"did not expect a deprecation warning when bytecode caching is off, got: %v", events)
	})
})
