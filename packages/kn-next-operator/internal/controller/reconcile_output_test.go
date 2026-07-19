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
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// These tests assert the reconcile OUTPUT — the child objects the reconciler
// emits onto the (envtest) API server — per issue #72 / ADR-0001 (the operator
// is the single source of truth for cluster state).

var _ = Describe("NextApp Controller reconcile output", func() {
	const (
		namespace = "default"
		// digest-pinned image so validateImageRef (A1-digest) accepts it.
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)

	ctx := context.Background()

	// reconcileOnce creates the NextApp, runs the reconciler once and returns
	// the namespaced name for child lookups. Cleanup is registered via DeferCleanup.
	reconcileOnce := func(name string, spec appsv1alpha1.NextAppSpec) types.NamespacedName {
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		spec.Image = orDefault(spec.Image, validImage)
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec:       spec,
		}
		Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())

		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				// The external-cleanup finalizer (issue #74) pauses deletion
				// until the operator reconciles the delete; drive a reconcile so
				// the finalizer is removed and the object is GC'd.
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

	ownedBy := func(refs []metav1.OwnerReference, name string) bool {
		for _, ref := range refs {
			if ref.Kind == "NextApp" && ref.Name == name {
				return true
			}
		}
		return false
	}

	Context("Knative Service (ksvc)", func() {
		It("creates a ksvc digest-pinned to Spec.Image with scaling annotations and the SA reference", func() {
			nn := reconcileOnce("ksvc-app", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MinScale:             2,
					MaxScale:             7,
					ContainerConcurrency: 50,
				},
				TimeoutSeconds: 120,
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			By("pinning the container image to the digest-pinned Spec.Image")
			containers := ksvc.Spec.Template.Spec.Containers
			Expect(containers).To(HaveLen(1))
			Expect(containers[0].Image).To(Equal(validImage))
			Expect(containers[0].Image).To(ContainSubstring("@sha256:"))
			Expect(containers[0].Image).NotTo(ContainSubstring(":latest"))

			By("mapping Spec.Scaling onto the autoscaling annotations")
			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/min-scale", "2"))
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "7"))

			By("mapping containerConcurrency and timeout from spec")
			Expect(ksvc.Spec.Template.Spec.ContainerConcurrency).NotTo(BeNil())
			Expect(*ksvc.Spec.Template.Spec.ContainerConcurrency).To(Equal(int64(50)))
			Expect(ksvc.Spec.Template.Spec.TimeoutSeconds).NotTo(BeNil())
			Expect(*ksvc.Spec.Template.Spec.TimeoutSeconds).To(Equal(int64(120)))

			By("referencing the generated ServiceAccount")
			Expect(ksvc.Spec.Template.Spec.ServiceAccountName).To(Equal(nn.Name + "-sa"))

			By("exposing the container port 3000")
			Expect(containers[0].Ports).To(HaveLen(1))
			Expect(containers[0].Ports[0].ContainerPort).To(Equal(int32(3000)))

			By("being owner-referenced by the NextApp")
			Expect(ownedBy(ksvc.OwnerReferences, nn.Name)).To(BeTrue())
		})

		It("defaults containerConcurrency to 20 (#377, ADR-0028) and timeout to 300 when scaling/timeout are unset", func() {
			// #377 / ADR-0028: the high-traffic default. cc=100 made reactive
			// scale-to-N inert (a pod absorbed 100 concurrent requests before
			// Knative added a 2nd replica). 20 is the documented, W1-refinable
			// interim. Still overridable via spec.scaling.containerConcurrency.
			nn := reconcileOnce("ksvc-defaults", appsv1alpha1.NextAppSpec{Image: validImage})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Spec.Template.Spec.ContainerConcurrency).NotTo(BeNil())
			Expect(*ksvc.Spec.Template.Spec.ContainerConcurrency).To(Equal(int64(20)))
			Expect(ksvc.Spec.Template.Spec.TimeoutSeconds).NotTo(BeNil())
			Expect(*ksvc.Spec.Template.Spec.TimeoutSeconds).To(Equal(int64(300)))

			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/min-scale", "0"))
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "10"))
		})

		It("injects KNEXT_DB_POOL_MAX into the app container when spec.scaling.poolMax is declared (#378)", func() {
			// #378 (W3, ADR-0029): close the declared-vs-runtime poolMax drift.
			// spec.scaling.poolMax was validation-only (ADR-0028) — the operator
			// gated maxScale × poolMax ≤ 80 at admission but never told the app
			// what its per-pod cap was, so @knext/lib's pg Pool could open more
			// than poolMax connections/pod and blow the budget at runtime. The
			// operator now injects the declared cap as KNEXT_DB_POOL_MAX so
			// getDbPool() can enforce it. maxScale(7) × poolMax(5) = 35 ≤ 80.
			nn := reconcileOnce("ksvc-poolmax", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MinScale: 0,
					MaxScale: 7,
					PoolMax:  5,
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			env := ksvc.Spec.Template.Spec.Containers[0].Env
			Expect(envValue(env, "KNEXT_DB_POOL_MAX")).To(Equal("5"),
				"the operator must inject the declared per-pod pool cap so the app can enforce it at runtime")
		})

		It("does NOT inject KNEXT_DB_POOL_MAX when spec.scaling.poolMax is unset (#378 back-compat)", func() {
			// When poolMax is undeclared (0) the wall is documented-only
			// (ADR-0028 §3): the operator cannot enforce a cap it does not know,
			// so it injects no env — every pre-existing CR that never set poolMax
			// is unaffected and the app falls back to its DB_POOL_MAX default.
			nn := reconcileOnce("ksvc-no-poolmax", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 10},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			env := ksvc.Spec.Template.Spec.Containers[0].Env
			Expect(hasEnvKey(env, "KNEXT_DB_POOL_MAX")).To(BeFalse(),
				"no per-pod cap env when poolMax is undeclared (back-compat)")
		})

		It("renders scale-to-zero-eligible annotations (min-scale 0, max-scale 1) for #39 activation", func() {
			// A2-3 (#39): the activation path requires the revision to be eligible
			// to scale to zero (min-scale 0) and to wake on demand. A single-replica
			// ceiling (max-scale 1) makes the nightly scale-from-zero e2e
			// deterministic — exactly one pod is woken by the activator. This is the
			// deterministic per-PR gate that proves the operator maps the CR onto the
			// autoscaling annotations the activator relies on.
			nn := reconcileOnce("ksvc-scale-from-zero", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MinScale: 0,
					MaxScale: 1,
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/min-scale", "0"),
				"min-scale must be 0 so the revision is eligible to scale to zero")
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "1"),
				"max-scale must be 1 so exactly one pod is woken on activation")
		})

		It("stamps autoscaling.knative.dev/target-burst-capacity when spec.scaling.targetBurstCapacity is set (#411, ADR-0032)", func() {
			// -1 = always keep the activator in the request path as a burst
			// buffer, pacing an unpredicted spike into pods as they scale
			// rather than letting the first Running pod eat the whole burst.
			nn := reconcileOnce("ksvc-tbc-set", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MinScale:             1,
					MaxScale:             7,
					ContainerConcurrency: 20,
					TargetBurstCapacity:  ptr.To(int32(-1)),
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/target-burst-capacity", "-1"))
			By("coexisting with the existing min/max-scale + cc annotations")
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/min-scale", "1"))
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "7"))
		})

		It("does NOT stamp target-burst-capacity when spec.scaling.targetBurstCapacity is unset (#411 back-compat)", func() {
			nn := reconcileOnce("ksvc-tbc-unset", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 10},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Spec.Template.Annotations).NotTo(HaveKey("autoscaling.knative.dev/target-burst-capacity"),
				"no TBC annotation when the field is unset — preserves the Knative default (back-compat)")
		})

		It("stamps a non-negative targetBurstCapacity (a numeric burst capacity, not always-activator) (#411)", func() {
			nn := reconcileOnce("ksvc-tbc-numeric", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Scaling: &appsv1alpha1.ScalingSpec{TargetBurstCapacity: ptr.To(int32(200))},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Spec.Template.Annotations).To(
				HaveKeyWithValue("autoscaling.knative.dev/target-burst-capacity", "200"))
		})

		It("stamps both panic annotations when spec.scaling.panicWindowPercentage and panicThresholdPercentage are set (#413, ADR-0033)", func() {
			nn := reconcileOnce("ksvc-panic-both-set", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MinScale:                 1,
					MaxScale:                 7,
					ContainerConcurrency:     20,
					TargetBurstCapacity:      ptr.To(int32(-1)),
					PanicWindowPercentage:    ptr.To(int32(10)),
					PanicThresholdPercentage: ptr.To(int32(200)),
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/panic-window-percentage", "10"))
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/panic-threshold-percentage", "200"))
			By("coexisting with min/max-scale + cc + targetBurstCapacity")
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/min-scale", "1"))
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "7"))
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/target-burst-capacity", "-1"))
		})

		It("does NOT stamp either panic annotation when both are unset (#413 back-compat)", func() {
			nn := reconcileOnce("ksvc-panic-unset", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 10},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Spec.Template.Annotations).NotTo(HaveKey("autoscaling.knative.dev/panic-window-percentage"),
				"no panic-window annotation when unset — preserves the Knative default (10%)")
			Expect(ksvc.Spec.Template.Annotations).NotTo(HaveKey("autoscaling.knative.dev/panic-threshold-percentage"),
				"no panic-threshold annotation when unset — preserves the Knative default (200%)")
		})

		It("stamps only panicWindowPercentage when panicThresholdPercentage is unset (#413)", func() {
			nn := reconcileOnce("ksvc-panic-window-only", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Scaling: &appsv1alpha1.ScalingSpec{PanicWindowPercentage: ptr.To(int32(20))},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Spec.Template.Annotations).To(
				HaveKeyWithValue("autoscaling.knative.dev/panic-window-percentage", "20"))
			Expect(ksvc.Spec.Template.Annotations).NotTo(HaveKey("autoscaling.knative.dev/panic-threshold-percentage"))
		})

		It("stamps only panicThresholdPercentage when panicWindowPercentage is unset (#413)", func() {
			nn := reconcileOnce("ksvc-panic-threshold-only", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Scaling: &appsv1alpha1.ScalingSpec{PanicThresholdPercentage: ptr.To(int32(150))},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Spec.Template.Annotations).NotTo(HaveKey("autoscaling.knative.dev/panic-window-percentage"))
			Expect(ksvc.Spec.Template.Annotations).To(
				HaveKeyWithValue("autoscaling.knative.dev/panic-threshold-percentage", "150"))
		})

		It("stamps the build-id label onto the revision (pod) template when Spec.BuildID is set (#93)", func() {
			nn := reconcileOnce("ksvc-buildid", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				BuildID: "20240101120000",
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			By("placing apps.kn-next.dev/build-id on the template so it propagates to every Revision")
			Expect(ksvc.Spec.Template.Labels).To(
				HaveKeyWithValue(appsv1alpha1.BuildIDLabel, "20240101120000"),
			)
		})

		It("does NOT stamp the build-id label when Spec.BuildID is empty (back-compat)", func() {
			nn := reconcileOnce("ksvc-no-buildid", appsv1alpha1.NextAppSpec{Image: validImage})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Spec.Template.Labels).NotTo(HaveKey(appsv1alpha1.BuildIDLabel))
		})
	})

	Context("ServiceAccount", func() {
		It("creates a non-automounting SA owner-referenced by the NextApp", func() {
			nn := reconcileOnce("sa-app", appsv1alpha1.NextAppSpec{Image: validImage})

			sa := &corev1.ServiceAccount{}
			saName := types.NamespacedName{Name: nn.Name + "-sa", Namespace: namespace}
			Expect(k8sClient.Get(ctx, saName, sa)).To(Succeed())

			By("disabling service-account token automount (least-privilege contract)")
			Expect(sa.AutomountServiceAccountToken).NotTo(BeNil())
			Expect(*sa.AutomountServiceAccountToken).To(BeFalse())

			By("being owner-referenced by the NextApp")
			Expect(ownedBy(sa.OwnerReferences, nn.Name)).To(BeTrue())
		})
	})

	Context("Bytecode-cache PVC", func() {
		It("is NOT created when EnableBytecodeCache is false", func() {
			nn := reconcileOnce("pvc-off", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Cache: &appsv1alpha1.CacheSpec{EnableBytecodeCache: false},
			})

			pvc := &corev1.PersistentVolumeClaim{}
			pvcName := types.NamespacedName{Name: nn.Name + "-bytecode-cache", Namespace: namespace}
			err := k8sClient.Get(ctx, pvcName, pvc)
			Expect(errors.IsNotFound(err)).To(BeTrue(),
				"PVC must not exist when bytecode caching is disabled")

			By("not mounting a bytecode-cache volume into the ksvc")
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			Expect(ksvc.Spec.Template.Spec.Volumes).To(BeEmpty())
			Expect(ksvc.Spec.Template.Spec.Containers[0].VolumeMounts).To(BeEmpty())
		})

		It("IS created with the configured size and mounted when EnableBytecodeCache is true", func() {
			nn := reconcileOnce("pvc-on", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Cache: &appsv1alpha1.CacheSpec{
					// Provider must be set for the cache env block (incl.
					// NODE_COMPILE_CACHE) to be emitted — see nextapp_controller.go.
					Provider:            "redis",
					URL:                 "redis://cache:6379",
					EnableBytecodeCache: true,
					BytecodeCacheSize:   "1Gi",
				},
			})

			pvc := &corev1.PersistentVolumeClaim{}
			pvcName := types.NamespacedName{Name: nn.Name + "-bytecode-cache", Namespace: namespace}
			Expect(k8sClient.Get(ctx, pvcName, pvc)).To(Succeed())

			By("sizing the PVC to Spec.Cache.BytecodeCacheSize")
			Expect(pvc.Spec.Resources.Requests.Storage()).NotTo(BeNil())
			Expect(pvc.Spec.Resources.Requests.Storage().Equal(resource.MustParse("1Gi"))).To(BeTrue())
			Expect(pvc.Spec.AccessModes).To(ContainElement(corev1.ReadWriteOnce))

			By("being owner-referenced by the NextApp")
			Expect(ownedBy(pvc.OwnerReferences, nn.Name)).To(BeTrue())

			By("mounting the PVC into the ksvc at /cache/bytecode")
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			vols := ksvc.Spec.Template.Spec.Volumes
			Expect(vols).To(HaveLen(1))
			Expect(vols[0].Name).To(Equal("bytecode-cache"))
			Expect(vols[0].PersistentVolumeClaim).NotTo(BeNil())
			Expect(vols[0].PersistentVolumeClaim.ClaimName).To(Equal(nn.Name + "-bytecode-cache"))

			mounts := ksvc.Spec.Template.Spec.Containers[0].VolumeMounts
			Expect(mounts).To(HaveLen(1))
			Expect(mounts[0].Name).To(Equal("bytecode-cache"))
			Expect(mounts[0].MountPath).To(Equal("/cache/bytecode"))

			By("setting NODE_COMPILE_CACHE so the runtime uses the mounted cache")
			Expect(envValue(ksvc.Spec.Template.Spec.Containers[0].Env, "NODE_COMPILE_CACHE")).
				To(Equal("/cache/bytecode/latest"))
		})

		It("defaults the PVC size to 512Mi when BytecodeCacheSize is unset", func() {
			nn := reconcileOnce("pvc-default-size", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Cache: &appsv1alpha1.CacheSpec{EnableBytecodeCache: true},
			})

			pvc := &corev1.PersistentVolumeClaim{}
			pvcName := types.NamespacedName{Name: nn.Name + "-bytecode-cache", Namespace: namespace}
			Expect(k8sClient.Get(ctx, pvcName, pvc)).To(Succeed())
			Expect(pvc.Spec.Resources.Requests.Storage().Equal(resource.MustParse("512Mi"))).To(BeTrue())
		})

		// Documents a real coupling in the reconciler: the bytecode-cache volume
		// and mount are gated only on EnableBytecodeCache, but the
		// NODE_COMPILE_CACHE env var is nested under the cache *Provider* block.
		// With bytecode caching on but no cache Provider, the PVC is still mounted
		// while NODE_COMPILE_CACHE is NOT set. This asserts that as-built behavior
		// (a candidate cleanup is flagged in the issue report, not changed here).
		It("mounts the PVC but omits NODE_COMPILE_CACHE when no cache Provider is set", func() {
			nn := reconcileOnce("pvc-no-provider", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Cache: &appsv1alpha1.CacheSpec{EnableBytecodeCache: true},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			By("still mounting the bytecode-cache volume")
			Expect(ksvc.Spec.Template.Spec.Volumes).To(HaveLen(1))
			Expect(ksvc.Spec.Template.Spec.Containers[0].VolumeMounts).To(HaveLen(1))

			By("NOT setting NODE_COMPILE_CACHE (gated on cache Provider)")
			Expect(envValue(ksvc.Spec.Template.Spec.Containers[0].Env, "NODE_COMPILE_CACHE")).
				To(BeEmpty())
		})
	})

	// Bun analog of NODE_COMPILE_CACHE (measured on next@16.2.4 standalone,
	// Bun 1.3.5: warm transpiler cache = -56ms / ~20% off time-to-first-response;
	// `bun build --bytecode` hard-fails on the standalone server, so the runtime
	// transpiler cache env var is the mechanism). Wired exactly like
	// NODE_COMPILE_CACHE — same Provider+EnableBytecodeCache gate, same PVC —
	// plus the runtime=bun gate: the var is meaningless under Node.
	Context("Bun transpiler cache (runtime=bun)", func() {
		It("sets BUN_RUNTIME_TRANSPILER_CACHE_PATH on the mounted PVC when runtime is bun", func() {
			nn := reconcileOnce("bun-tc-on", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Runtime: "bun",
				Cache: &appsv1alpha1.CacheSpec{
					Provider:            "redis",
					URL:                 "redis://cache:6379",
					EnableBytecodeCache: true,
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			env := ksvc.Spec.Template.Spec.Containers[0].Env

			By("pointing Bun's runtime transpiler cache into the bytecode-cache PVC")
			Expect(envValue(env, "BUN_RUNTIME_TRANSPILER_CACHE_PATH")).
				To(Equal("/cache/bytecode/bun-transpiler"))

			By("keeping NODE_COMPILE_CACHE unchanged (inert under Bun, needed if rebooted under Node)")
			Expect(envValue(env, "NODE_COMPILE_CACHE")).
				To(Equal("/cache/bytecode/latest"))
		})

		It("does NOT set BUN_RUNTIME_TRANSPILER_CACHE_PATH when runtime is node/unset (Node env byte-identical)", func() {
			nn := reconcileOnce("bun-tc-node", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Cache: &appsv1alpha1.CacheSpec{
					Provider:            "redis",
					URL:                 "redis://cache:6379",
					EnableBytecodeCache: true,
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			Expect(envValue(ksvc.Spec.Template.Spec.Containers[0].Env, "BUN_RUNTIME_TRANSPILER_CACHE_PATH")).
				To(BeEmpty())
		})

		It("does NOT set BUN_RUNTIME_TRANSPILER_CACHE_PATH without EnableBytecodeCache (no PVC to write to)", func() {
			nn := reconcileOnce("bun-tc-nocache", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Runtime: "bun",
				Cache: &appsv1alpha1.CacheSpec{
					Provider: "redis",
					URL:      "redis://cache:6379",
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			Expect(envValue(ksvc.Spec.Template.Spec.Containers[0].Env, "BUN_RUNTIME_TRANSPILER_CACHE_PATH")).
				To(BeEmpty())
		})
	})

	Context("RUM env propagation (#94)", func() {
		It("does NOT set NEXT_PUBLIC_RUM_ENABLED when RUM is off", func() {
			nn := reconcileOnce("rum-off", appsv1alpha1.NextAppSpec{
				Image:         validImage,
				Observability: &appsv1alpha1.ObservabilitySpec{Enabled: true},
			})
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			env := ksvc.Spec.Template.Spec.Containers[0].Env
			Expect(envValue(env, "NEXT_PUBLIC_RUM_ENABLED")).To(BeEmpty())
			Expect(envValue(env, "NEXT_PUBLIC_RUM_SAMPLE_RATE")).To(BeEmpty())
		})

		It("sets NEXT_PUBLIC_RUM_ENABLED and sample rate when RUM is on", func() {
			nn := reconcileOnce("rum-on", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Observability: &appsv1alpha1.ObservabilitySpec{
					Enabled: true,
					Rum:     &appsv1alpha1.RumSpec{Enabled: true, SampleRate: "0.25"},
				},
			})
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			env := ksvc.Spec.Template.Spec.Containers[0].Env
			Expect(envValue(env, "NEXT_PUBLIC_RUM_ENABLED")).To(Equal("true"))
			Expect(envValue(env, "NEXT_PUBLIC_RUM_SAMPLE_RATE")).To(Equal("0.25"))
		})

		It("omits the sample-rate env when unset", func() {
			nn := reconcileOnce("rum-on-nosample", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Observability: &appsv1alpha1.ObservabilitySpec{
					Enabled: true,
					Rum:     &appsv1alpha1.RumSpec{Enabled: true},
				},
			})
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			env := ksvc.Spec.Template.Spec.Containers[0].Env
			Expect(envValue(env, "NEXT_PUBLIC_RUM_ENABLED")).To(Equal("true"))
			Expect(envValue(env, "NEXT_PUBLIC_RUM_SAMPLE_RATE")).To(BeEmpty())
		})
	})

	Context("OTel tracing env propagation (#30)", func() {
		It("does NOT set OTEL_TRACING_ENABLED when tracing is off", func() {
			nn := reconcileOnce("tracing-off", appsv1alpha1.NextAppSpec{
				Image:         validImage,
				Observability: &appsv1alpha1.ObservabilitySpec{Enabled: true},
			})
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			env := ksvc.Spec.Template.Spec.Containers[0].Env
			Expect(envValue(env, "OTEL_TRACING_ENABLED")).To(BeEmpty())
			Expect(envValue(env, "OTEL_EXPORTER_OTLP_ENDPOINT")).To(BeEmpty())
			Expect(envValue(env, "OTEL_TRACES_SAMPLER_ARG")).To(BeEmpty())
		})

		It("sets OTEL_TRACING_ENABLED, endpoint, and sampler arg when tracing is on", func() {
			nn := reconcileOnce("tracing-on", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Observability: &appsv1alpha1.ObservabilitySpec{
					Enabled: true,
					Tracing: &appsv1alpha1.TracingSpec{
						Enabled:    true,
						Endpoint:   "http://tempo.monitoring:4317",
						SampleRate: "0.25",
					},
				},
			})
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			env := ksvc.Spec.Template.Spec.Containers[0].Env
			Expect(envValue(env, "OTEL_TRACING_ENABLED")).To(Equal("true"))
			Expect(envValue(env, "OTEL_EXPORTER_OTLP_ENDPOINT")).To(Equal("http://tempo.monitoring:4317"))
			Expect(envValue(env, "OTEL_TRACES_SAMPLER_ARG")).To(Equal("0.25"))
		})

		It("omits endpoint and sampler env when unset, keeping the enable flag", func() {
			nn := reconcileOnce("tracing-on-defaults", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Observability: &appsv1alpha1.ObservabilitySpec{
					Enabled: true,
					Tracing: &appsv1alpha1.TracingSpec{Enabled: true},
				},
			})
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			env := ksvc.Spec.Template.Spec.Containers[0].Env
			Expect(envValue(env, "OTEL_TRACING_ENABLED")).To(Equal("true"))
			Expect(envValue(env, "OTEL_EXPORTER_OTLP_ENDPOINT")).To(BeEmpty())
			Expect(envValue(env, "OTEL_TRACES_SAMPLER_ARG")).To(BeEmpty())
		})
	})

	Context("pod identity env (#184)", func() {
		// The HOSTNAME=0.0.0.0 bind override clobbers kubelet's
		// HOSTNAME=<pod-name>, and the operator can NOT restore the pod name
		// via the downward API: valueFrom.fieldRef in ksvc env is
		// feature-gated on stock Knative (`kubernetes.podspec-fieldref`,
		// Disabled by default — serving pkg/apis/config/features.go), so the
		// validation webhook would reject the Service on any cluster that
		// hasn't opted in. The pod identity is instead recovered by the knext
		// runtime from the kernel hostname (buildChildEnv → KNEXT_POD_NAME →
		// otel host.name). envtest runs no Knative webhook, so this guard
		// pins the DECISION: no env var may use valueFrom.
		It("keeps HOSTNAME=0.0.0.0 and never emits downward-API (valueFrom) env", func() {
			nn := reconcileOnce("pod-identity-env", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Observability: &appsv1alpha1.ObservabilitySpec{
					Enabled: true,
					Tracing: &appsv1alpha1.TracingSpec{Enabled: true},
				},
			})
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			env := ksvc.Spec.Template.Spec.Containers[0].Env

			By("keeping the HOSTNAME=0.0.0.0 bind override (defense-in-depth, #178)")
			Expect(envValue(env, "HOSTNAME")).To(Equal("0.0.0.0"))

			By("not injecting KNEXT_POD_NAME as a literal (a static value would lie about pod identity)")
			Expect(envValue(env, "KNEXT_POD_NAME")).To(BeEmpty())

			By("never using valueFrom/fieldRef — rejected by stock Knative validation")
			for _, e := range env {
				Expect(e.ValueFrom).To(BeNil(),
					"env %q uses valueFrom — kubernetes.podspec-fieldref is Disabled by default on stock Knative; the webhook would reject this ksvc (#184)", e.Name)
			}
		})
	})

	Context("KafkaSource", func() {
		It("is NOT created when Revalidation is unset", func() {
			nn := reconcileOnce("kafka-off", appsv1alpha1.NextAppSpec{Image: validImage})

			ks := newKafkaSourceObj()
			ksName := types.NamespacedName{Name: nn.Name + "-revalidation-source", Namespace: namespace}
			err := k8sClient.Get(ctx, ksName, ks)
			Expect(errors.IsNotFound(err)).To(BeTrue(),
				"KafkaSource must not exist when revalidation is not configured")
		})

		It("is NOT created when queue is kafka but ProvisionKafkaSource is unset (consumer deferred, #95)", func() {
			nn := reconcileOnce("kafka-deferred", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Revalidation: &appsv1alpha1.RevalidationSpec{
					Queue:          "kafka",
					KafkaBrokerUrl: "kafka-broker:9092",
				},
			})

			By("not provisioning a KafkaSource that points at the unbuilt revalidator sink")
			ks := newKafkaSourceObj()
			ksName := types.NamespacedName{Name: nn.Name + "-revalidation-source", Namespace: namespace}
			err := k8sClient.Get(ctx, ksName, ks)
			Expect(errors.IsNotFound(err)).To(BeTrue(),
				"KafkaSource must not exist while the revalidator consumer is unbuilt and opt-in is off")

			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())

			By("surfacing a non-fatal RevalidationDeferred condition")
			deferred := findCondition(updated.Status.Conditions, conditionTypeRevalidationDeferred)
			Expect(deferred).NotTo(BeNil(), "RevalidationDeferred condition must be set")
			Expect(deferred.Status).To(Equal(metav1.ConditionTrue))
			Expect(deferred.Reason).To(Equal("ConsumerNotProvisioned"))

			By("keeping Ready=True once the child ksvc is Ready (the deferral is non-fatal)")
			// Honest-Ready: NextApp Ready mirrors the child ksvc's health. envtest runs
			// no Knative controllers, so stamp the ksvc Ready and re-reconcile, then
			// confirm the RevalidationDeferred deferral does NOT drag Ready=False.
			markKsvcReadyAndReconcile(ctx, nn)
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())
			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready).NotTo(BeNil())
			Expect(ready.Status).To(Equal(metav1.ConditionTrue))
		})

		It("IS created with the topic/brokers/sink when kafka + ProvisionKafkaSource=true", func() {
			nn := reconcileOnce("kafka-on", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Revalidation: &appsv1alpha1.RevalidationSpec{
					Queue:                "kafka",
					KafkaBrokerUrl:       "kafka-broker:9092",
					ProvisionKafkaSource: ptr.To(true),
				},
			})

			ks := newKafkaSourceObj()
			ksName := types.NamespacedName{Name: nn.Name + "-revalidation-source", Namespace: namespace}
			Expect(k8sClient.Get(ctx, ksName, ks)).To(Succeed())

			spec, found, err := unstructured.NestedMap(ks.Object, "spec")
			Expect(err).NotTo(HaveOccurred())
			Expect(found).To(BeTrue())

			By("targeting the per-app revalidation topic")
			topics, _, _ := unstructured.NestedStringSlice(ks.Object, "spec", "topics")
			Expect(topics).To(ContainElement(nn.Name + "-revalidation"))

			By("pointing at the configured Kafka broker")
			brokers, _, _ := unstructured.NestedStringSlice(ks.Object, "spec", "bootstrapServers")
			Expect(brokers).To(ContainElement("kafka-broker:9092"))

			By("setting the consumer group")
			Expect(spec["consumerGroup"]).To(Equal(nn.Name + "-revalidation"))

			By("sinking events to the revalidator ksvc")
			sinkName, _, _ := unstructured.NestedString(ks.Object, "spec", "sink", "ref", "name")
			Expect(sinkName).To(Equal(nn.Name + "-revalidator"))

			By("being owner-referenced by the NextApp")
			Expect(ownedBy(ks.GetOwnerReferences(), nn.Name)).To(BeTrue())
		})
	})

	// Scheduled warm-floor (ADR-0030, W5/#380): the OPERATOR is the SINGLE writer
	// of the ksvc min-scale annotation. On each reconcile it evaluates the
	// warmSchedule windows against NOW (clock-injectable in tests) and folds the
	// active-window floor into min-scale; outside every window min-scale falls back
	// to Spec.MinScale (default 0, scale-to-zero). It RequeueAfter's the next window
	// boundary. No CronJobs, no patcher RBAC, no external writer — so the floor
	// never reverts/thrashes.
	Context("warm-schedule operator-owned min-scale floor", func() {
		// reconcileWithClock creates the NextApp and runs ONE reconcile with the
		// reconciler's clock pinned to `now`, returning the namespaced name + the
		// reconcile result (so the RequeueAfter boundary can be asserted).
		reconcileWithClock := func(name string, now time.Time, spec appsv1alpha1.NextAppSpec) (types.NamespacedName, reconcile.Result) {
			nn := types.NamespacedName{Name: name, Namespace: namespace}
			spec.Image = orDefault(spec.Image, validImage)
			app := &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace}, Spec: spec}
			Expect(k8sClient.Create(ctx, app)).To(Succeed())
			DeferCleanup(func() {
				cur := &appsv1alpha1.NextApp{}
				if err := k8sClient.Get(ctx, nn, cur); err == nil {
					Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
					cleanup := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
					_, _ = cleanup.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
				}
			})
			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Clock: func() time.Time { return now }}
			res, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())
			return nn, res
		}

		minScaleOf := func(nn types.NamespacedName) string {
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			return ksvc.Spec.Template.Annotations["autoscaling.knative.dev/min-scale"]
		}

		// A window that spans the whole day in UTC, so "now" (any UTC instant that is
		// not exactly 00:00) is inside it.
		allDayWindow := appsv1alpha1.WarmWindow{Start: "1 0 * * *", End: "59 23 * * *", Replicas: 3, Timezone: "UTC"}

		It("creates NO CronJobs/RBAC (the mechanism is annotation-only, no children)", func() {
			now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
			nn, _ := reconcileWithClock("warm-nochildren", now, appsv1alpha1.NextAppSpec{
				Scaling: &appsv1alpha1.ScalingSpec{MaxScale: 8, WarmSchedule: []appsv1alpha1.WarmWindow{allDayWindow}},
			})
			cj := &batchv1.CronJob{}
			Err := k8sClient.Get(ctx, types.NamespacedName{Name: nn.Name + "-warm-0-set", Namespace: namespace}, cj)
			Expect(errors.IsNotFound(Err)).To(BeTrue(), "no CronJob: warm-floor is operator-owned, annotation-only")
			sa := &corev1.ServiceAccount{}
			Err = k8sClient.Get(ctx, types.NamespacedName{Name: nn.Name + "-warm-patcher", Namespace: namespace}, sa)
			Expect(errors.IsNotFound(Err)).To(BeTrue(), "no patcher SA: no external writer")
			role := &rbacv1.Role{}
			Err = k8sClient.Get(ctx, types.NamespacedName{Name: nn.Name + "-warm-patcher", Namespace: namespace}, role)
			Expect(errors.IsNotFound(Err)).To(BeTrue(), "no patcher Role: no external writer")
		})

		It("sets ksvc min-scale to the active window's replicas (INSIDE the window)", func() {
			now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC) // noon UTC, inside allDayWindow
			nn, res := reconcileWithClock("warm-inside", now, appsv1alpha1.NextAppSpec{
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 8, WarmSchedule: []appsv1alpha1.WarmWindow{allDayWindow}},
			})
			Expect(minScaleOf(nn)).To(Equal("3"), "min-scale must equal the active window floor")
			Expect(res.RequeueAfter).To(BeNumerically(">", 0), "must requeue to the next boundary")
		})

		It("keeps the floor across a SECOND reconcile — no revert (single-writer)", func() {
			now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
			nn, _ := reconcileWithClock("warm-noreset", now, appsv1alpha1.NextAppSpec{
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 8, WarmSchedule: []appsv1alpha1.WarmWindow{allDayWindow}},
			})
			Expect(minScaleOf(nn)).To(Equal("3"))
			By("running a second reconcile at the same instant — the floor MUST survive")
			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Clock: func() time.Time { return now }}
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())
			Expect(minScaleOf(nn)).To(Equal("3"), "the operator is the single writer: no revert to Spec.MinScale")
		})

		It("falls back to Spec.MinScale OUTSIDE all windows (scale-to-zero preserved)", func() {
			// Window only 08:00-09:00 UTC; evaluate at 12:00 UTC => outside.
			w := appsv1alpha1.WarmWindow{Start: "0 8 * * *", End: "0 9 * * *", Replicas: 5, Timezone: "UTC"}
			now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
			nn, res := reconcileWithClock("warm-outside", now, appsv1alpha1.NextAppSpec{
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 8, WarmSchedule: []appsv1alpha1.WarmWindow{w}},
			})
			Expect(minScaleOf(nn)).To(Equal("0"), "outside the window the floor is Spec.MinScale (0)")
			Expect(res.RequeueAfter).To(BeNumerically(">", 0), "still requeues to the next window start")
		})

		It("honours Spec.MinScale as a lower bound (max of Spec.MinScale and window)", func() {
			// Outside the window, Spec.MinScale=2 must still hold.
			w := appsv1alpha1.WarmWindow{Start: "0 8 * * *", End: "0 9 * * *", Replicas: 5, Timezone: "UTC"}
			now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
			nn, _ := reconcileWithClock("warm-floorfloor", now, appsv1alpha1.NextAppSpec{
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 2, MaxScale: 8, WarmSchedule: []appsv1alpha1.WarmWindow{w}},
			})
			Expect(minScaleOf(nn)).To(Equal("2"), "Spec.MinScale is the floor outside windows")
		})

		It("takes the MAX replicas across overlapping active windows", func() {
			now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
			windows := []appsv1alpha1.WarmWindow{
				{Start: "1 0 * * *", End: "59 23 * * *", Replicas: 2, Timezone: "UTC"},
				{Start: "0 10 * * *", End: "0 14 * * *", Replicas: 6, Timezone: "UTC"},
			}
			nn, _ := reconcileWithClock("warm-overlap", now, appsv1alpha1.NextAppSpec{
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 8, WarmSchedule: windows},
			})
			Expect(minScaleOf(nn)).To(Equal("6"), "overlapping windows => max replicas wins")
		})

		It("drops the floor when the schedule is removed (no lingering warm state)", func() {
			now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
			nn, _ := reconcileWithClock("warm-clear", now, appsv1alpha1.NextAppSpec{
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 8, WarmSchedule: []appsv1alpha1.WarmWindow{allDayWindow}},
			})
			Expect(minScaleOf(nn)).To(Equal("3"))
			By("removing the schedule and re-reconciling")
			cur := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, cur)).To(Succeed())
			cur.Spec.Scaling.WarmSchedule = nil
			Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Clock: func() time.Time { return now }}
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())
			Expect(minScaleOf(nn)).To(Equal("0"), "cleared schedule => floor back to Spec.MinScale")
		})
	})

	Context("Error path: invalid image", func() {
		It("ends not-Ready/Degraded and creates no ksvc or SA child", func() {
			name := "bad-image"
			nn := types.NamespacedName{Name: name, Namespace: namespace}
			nextApp := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
				// tag-only / :latest-style image — must be rejected by validateImageRef.
				Spec: appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:latest"},
			}
			Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())
			DeferCleanup(func() {
				cur := &appsv1alpha1.NextApp{}
				if err := k8sClient.Get(ctx, nn, cur); err == nil {
					Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				}
			})

			reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).To(HaveOccurred(), "an invalid image must surface as a reconcile error (requeue)")

			By("setting Ready=False and Degraded=True")
			updated := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, updated)).To(Succeed())
			ready := findCondition(updated.Status.Conditions, conditionTypeReady)
			Expect(ready).NotTo(BeNil())
			Expect(ready.Status).To(Equal(metav1.ConditionFalse))
			degraded := findCondition(updated.Status.Conditions, conditionTypeDegraded)
			Expect(degraded).NotTo(BeNil())
			Expect(degraded.Status).To(Equal(metav1.ConditionTrue))

			By("creating no orphaned ksvc child")
			ksvc := &servingv1.Service{}
			Expect(errors.IsNotFound(k8sClient.Get(ctx, nn, ksvc))).To(BeTrue())

			By("creating no orphaned ServiceAccount child")
			sa := &corev1.ServiceAccount{}
			saName := types.NamespacedName{Name: name + "-sa", Namespace: namespace}
			Expect(errors.IsNotFound(k8sClient.Get(ctx, saName, sa))).To(BeTrue())
		})
	})

	// Issue #92: rollback via Knative revision traffic split. The reconciler
	// renders ksvc.Spec.Traffic from the CR's spec.traffic intent.
	Context("Traffic split (#92 rollback)", func() {
		It("leaves ksvc.Spec.Traffic nil when spec.traffic is unset (back-compat, byte-identical)", func() {
			nn := reconcileOnce("traffic-default", appsv1alpha1.NextAppSpec{Image: validImage})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			Expect(ksvc.Spec.Traffic).To(BeEmpty(),
				"unset traffic must leave Knative to default 100%% latest-ready (no spec.traffic)")
		})

		It("pins 100%% to a named revision when spec.traffic.revisionName is set with no canary", func() {
			nn := reconcileOnce("traffic-pinned", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Traffic: &appsv1alpha1.TrafficSpec{RevisionName: "traffic-pinned-00001"},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			Expect(ksvc.Spec.Traffic).To(HaveLen(1))
			t := ksvc.Spec.Traffic[0]
			Expect(t.RevisionName).To(Equal("traffic-pinned-00001"))
			Expect(t.LatestRevision).NotTo(BeNil())
			Expect(*t.LatestRevision).To(BeFalse())
			Expect(t.Percent).NotTo(BeNil())
			Expect(*t.Percent).To(Equal(int64(100)))
		})

		It("splits canary 20%% to latest / 80%% to the pinned revision", func() {
			nn := reconcileOnce("traffic-canary", appsv1alpha1.NextAppSpec{
				Image:   validImage,
				Traffic: &appsv1alpha1.TrafficSpec{RevisionName: "traffic-canary-00001", CanaryPercent: 20},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			Expect(ksvc.Spec.Traffic).To(HaveLen(2))

			var pinned, latest *servingv1.TrafficTarget
			for i := range ksvc.Spec.Traffic {
				tt := &ksvc.Spec.Traffic[i]
				if tt.RevisionName != "" {
					pinned = tt
				} else {
					latest = tt
				}
			}
			Expect(pinned).NotTo(BeNil())
			Expect(latest).NotTo(BeNil())

			Expect(pinned.RevisionName).To(Equal("traffic-canary-00001"))
			Expect(pinned.LatestRevision).NotTo(BeNil())
			Expect(*pinned.LatestRevision).To(BeFalse())
			Expect(pinned.Percent).NotTo(BeNil())
			Expect(*pinned.Percent).To(Equal(int64(80)))

			Expect(latest.LatestRevision).NotTo(BeNil())
			Expect(*latest.LatestRevision).To(BeTrue())
			Expect(latest.Percent).NotTo(BeNil())
			Expect(*latest.Percent).To(Equal(int64(20)))

			Expect(*pinned.Percent + *latest.Percent).To(Equal(int64(100)))
		})

		It("clears a prior traffic split when spec.traffic transitions back to nil (no stale pin)", func() {
			name := "traffic-transition"
			nn := types.NamespacedName{Name: name, Namespace: namespace}
			nextApp := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
				Spec: appsv1alpha1.NextAppSpec{
					Image:   validImage,
					Traffic: &appsv1alpha1.TrafficSpec{RevisionName: name + "-00001"},
				},
			}
			Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())
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

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			Expect(ksvc.Spec.Traffic).To(HaveLen(1), "precondition: traffic pinned")

			// Transition spec.traffic back to nil (latest-ready) and reconcile again.
			cur := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, cur)).To(Succeed())
			cur.Spec.Traffic = nil
			Expect(k8sClient.Update(ctx, cur)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred())

			ksvc2 := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc2)).To(Succeed())
			Expect(ksvc2.Spec.Traffic).To(BeEmpty(),
				"reverting to latest-ready must clear the prior pinned split")
		})
	})

	// Preview environments (#91). Characterization: the operator already applies
	// preview overrides from Spec.Preview — these tests lock that behavior in.
	// A preview is EPHEMERAL (ADR-0013): the operator forces max-scale=1 /
	// min-scale=0 / a 30s scale-to-zero retention window and stamps
	// environment=preview / pr-id labels on the ksvc, EVEN WHEN the spec requests
	// a larger scale (the preview override wins).
	Context("Preview environment (#91)", func() {
		It("does NOT stamp preview labels/annotations when Preview is unset (back-compat)", func() {
			nn := reconcileOnce("preview-off", appsv1alpha1.NextAppSpec{Image: validImage})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Labels).NotTo(HaveKey("environment"))
			Expect(ksvc.Labels).NotTo(HaveKey("pr-id"))
			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).NotTo(HaveKey("autoscaling.knative.dev/scale-to-zero-pod-retention-period"))
		})

		It("stamps environment=preview / pr-id labels and forces the preview scaling overrides", func() {
			nn := reconcileOnce("preview-on", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Preview: &appsv1alpha1.PreviewSpec{
					Enabled: true,
					PRID:    "123",
					Branch:  "feat/x",
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			By("stamping the preview identity labels on the ksvc")
			Expect(ksvc.Labels).To(HaveKeyWithValue("environment", "preview"))
			Expect(ksvc.Labels).To(HaveKeyWithValue("pr-id", "123"))

			By("forcing the ephemeral scaling overrides")
			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "1"))
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/min-scale", "0"))
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/scale-to-zero-pod-retention-period", "30s"))
		})

		It("the preview override WINS over a Spec.Scaling request for a larger max-scale", func() {
			nn := reconcileOnce("preview-override", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MinScale: 3,
					MaxScale: 10,
				},
				Preview: &appsv1alpha1.PreviewSpec{
					Enabled: true,
					PRID:    "456",
					Branch:  "feat/y",
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "1"),
				"preview max-scale=1 must override Spec.Scaling.MaxScale=10")
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/min-scale", "0"),
				"preview min-scale=0 must override Spec.Scaling.MinScale=3")
		})

		It("still stamps target-burst-capacity under the preview max-scale=1 override (#411)", func() {
			nn := reconcileOnce("preview-tbc", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MaxScale:            10,
					TargetBurstCapacity: ptr.To(int32(-1)),
				},
				Preview: &appsv1alpha1.PreviewSpec{
					Enabled: true,
					PRID:    "999",
					Branch:  "feat/z",
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "1"),
				"preview override still wins on max-scale")
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/target-burst-capacity", "-1"),
				"TBC must coexist with the preview scaling override, not be dropped by it")
		})

		It("still stamps the panic annotations under the preview max-scale=1 override (#413)", func() {
			nn := reconcileOnce("preview-panic", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MaxScale:                 10,
					PanicWindowPercentage:    ptr.To(int32(15)),
					PanicThresholdPercentage: ptr.To(int32(150)),
				},
				Preview: &appsv1alpha1.PreviewSpec{
					Enabled: true,
					PRID:    "998",
					Branch:  "feat/y",
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "1"),
				"preview override still wins on max-scale")
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/panic-window-percentage", "15"),
				"panic-window must coexist with the preview scaling override, not be dropped by it")
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/panic-threshold-percentage", "150"),
				"panic-threshold must coexist with the preview scaling override, not be dropped by it")
		})

		It("does not apply preview overrides when Preview.Enabled is false", func() {
			nn := reconcileOnce("preview-disabled", appsv1alpha1.NextAppSpec{
				Image: validImage,
				Preview: &appsv1alpha1.PreviewSpec{
					Enabled: false,
					PRID:    "789",
				},
			})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Labels).NotTo(HaveKey("environment"))
			Expect(ksvc.Spec.Template.Annotations).NotTo(
				HaveKey("autoscaling.knative.dev/scale-to-zero-pod-retention-period"))
		})
	})
})

// envValue returns the value of the named env var, or "" if absent.
func envValue(envs []corev1.EnvVar, name string) string {
	for _, e := range envs {
		if e.Name == name {
			return e.Value
		}
	}
	return ""
}

// hasEnvKey reports whether an env var with the given name is present (unlike
// envValue, it distinguishes "absent" from "present but empty").
func hasEnvKey(envs []corev1.EnvVar, name string) bool {
	for _, e := range envs {
		if e.Name == name {
			return true
		}
	}
	return false
}

// newKafkaSourceObj returns an empty unstructured KafkaSource for Get calls.
func newKafkaSourceObj() *unstructured.Unstructured {
	ks := &unstructured.Unstructured{}
	ks.SetAPIVersion("sources.knative.dev/v1beta1")
	ks.SetKind("KafkaSource")
	return ks
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}
