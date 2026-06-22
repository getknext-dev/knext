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

	corev1 "k8s.io/api/core/v1"
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

		It("defaults containerConcurrency to 100 and timeout to 300 when scaling/timeout are unset", func() {
			nn := reconcileOnce("ksvc-defaults", appsv1alpha1.NextAppSpec{Image: validImage})

			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

			Expect(ksvc.Spec.Template.Spec.ContainerConcurrency).NotTo(BeNil())
			Expect(*ksvc.Spec.Template.Spec.ContainerConcurrency).To(Equal(int64(100)))
			Expect(ksvc.Spec.Template.Spec.TimeoutSeconds).NotTo(BeNil())
			Expect(*ksvc.Spec.Template.Spec.TimeoutSeconds).To(Equal(int64(300)))

			annotations := ksvc.Spec.Template.Annotations
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/min-scale", "0"))
			Expect(annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "10"))
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

			By("keeping Ready=True (the deferral is non-fatal)")
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
