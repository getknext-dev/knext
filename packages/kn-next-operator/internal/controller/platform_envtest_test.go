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
	"path/filepath"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/config"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	servingv1beta1 "knative.dev/serving/pkg/apis/serving/v1beta1"
)

// The platform layer against a REAL API server (ADR-0064): what the CRD's schema
// and CEL actually admit, that status.platform survives the NextApp CRD's schema
// (a fake client validates nothing), and that the operator starts and works with
// and without the KnextPlatform CRD.

func rawPlatform(name string, spec map[string]interface{}) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "platform.kn-next.dev/v1alpha1",
		"kind":       "KnextPlatform",
		"metadata":   map[string]interface{}{"name": name},
	}}
	if spec != nil {
		u.Object["spec"] = spec
	}
	return u
}

func deletePlatformIfPresent(ctx context.Context, name string) {
	_ = k8sClient.Delete(ctx, rawPlatform(name, nil))
	Eventually(func() bool {
		err := k8sClient.Get(ctx, types.NamespacedName{Name: name}, rawPlatform(name, nil))
		return err != nil
	}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
}

var _ = Describe("KnextPlatform CRD admission (ADR-0064 P0-1)", func() {
	ctx := context.Background()

	It("accepts the empty platform, named default", func() {
		DeferCleanup(func() { deletePlatformIfPresent(ctx, "default") })
		Expect(k8sClient.Create(ctx, rawPlatform("default", map[string]interface{}{}))).To(Succeed())
		got := rawPlatform("default", nil)
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "default"}, got)).To(Succeed())
		// Nothing is defaulted into the stored object: an empty spec stays empty,
		// because a schema default would turn "unset" into "set".
		spec, _, _ := unstructured.NestedMap(got.Object, "spec")
		Expect(spec).To(BeEmpty(), "the CRD must not write defaults into spec")
	})

	It("accepts a fully populated platform", func() {
		DeferCleanup(func() { deletePlatformIfPresent(ctx, "default") })
		Expect(k8sClient.Create(ctx, rawPlatform("default", map[string]interface{}{
			"profile": "fastColdStart",
			"scaling": map[string]interface{}{"defaults": map[string]interface{}{
				"containerConcurrency": int64(40), "scaleDownDelay": "5m", "targetBurstCapacity": int64(-1),
				"panicWindowPercentage": int64(20), "panicThresholdPercentage": int64(300),
			}},
			"resources": map[string]interface{}{"defaults": map[string]interface{}{
				"cpuRequest": "500m", "cpuLimit": "2", "memoryRequest": "1Gi", "memoryLimit": "2Gi",
			}},
			"limits":   map[string]interface{}{"timeoutSeconds": int64(600)},
			"database": map[string]interface{}{"connectionBudget": int64(160)},
			"rollout":  map[string]interface{}{"maxAppsPerMinute": int64(5)},
		}))).To(Succeed())
	})

	It("is a singleton: any name but default is rejected by CEL", func() {
		err := k8sClient.Create(ctx, rawPlatform("staging", map[string]interface{}{}))
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("singleton"))
		Expect(err.Error()).To(ContainSubstring("default"))
	})

	It("is cluster-scoped", func() {
		mapping, err := k8sClient.RESTMapper().RESTMapping(
			schema.GroupKind{Group: "platform.kn-next.dev", Kind: "KnextPlatform"}, "v1alpha1")
		Expect(err).NotTo(HaveOccurred())
		Expect(mapping.Scope.Name()).To(Equal(apimeta.RESTScopeNameRoot),
			"a namespaced platform would let a namespace admin enable cluster-wide behaviour")
	})

	DescribeTable("rejects an invalid field and names it",
		func(spec map[string]interface{}, mention string) {
			DeferCleanup(func() { deletePlatformIfPresent(ctx, "default") })
			err := k8sClient.Create(ctx, rawPlatform("default", spec))
			Expect(err).To(HaveOccurred(), "the CRD schema must reject this")
			Expect(err.Error()).To(ContainSubstring(mention))
		},
		Entry("unknown profile", map[string]interface{}{"profile": "turbo"}, "profile"),
		Entry("garbage cpu quantity", map[string]interface{}{"resources": map[string]interface{}{"defaults": map[string]interface{}{"cpuLimit": "banana"}}}, "cpuLimit"),
		Entry("GB memory suffix", map[string]interface{}{"resources": map[string]interface{}{"defaults": map[string]interface{}{"memoryLimit": "1GB"}}}, "memoryLimit"),
		Entry("zero timeout", map[string]interface{}{"limits": map[string]interface{}{"timeoutSeconds": int64(0)}}, "timeoutSeconds"),
		Entry("timeout beyond an hour", map[string]interface{}{"limits": map[string]interface{}{"timeoutSeconds": int64(4000)}}, "timeoutSeconds"),
		Entry("zero connection budget", map[string]interface{}{"database": map[string]interface{}{"connectionBudget": int64(0)}}, "connectionBudget"),
		Entry("zero rollout rate", map[string]interface{}{"rollout": map[string]interface{}{"maxAppsPerMinute": int64(0)}}, "maxAppsPerMinute"),
		Entry("zero concurrency", map[string]interface{}{"scaling": map[string]interface{}{"defaults": map[string]interface{}{"containerConcurrency": int64(0)}}}, "containerConcurrency"),
		Entry("burst below -1", map[string]interface{}{"scaling": map[string]interface{}{"defaults": map[string]interface{}{"targetBurstCapacity": int64(-2)}}}, "targetBurstCapacity"),
		Entry("panic window 0", map[string]interface{}{"scaling": map[string]interface{}{"defaults": map[string]interface{}{"panicWindowPercentage": int64(0)}}}, "panicWindowPercentage"),
		Entry("panic window 101", map[string]interface{}{"scaling": map[string]interface{}{"defaults": map[string]interface{}{"panicWindowPercentage": int64(101)}}}, "panicWindowPercentage"),
		Entry("panic threshold 100", map[string]interface{}{"scaling": map[string]interface{}{"defaults": map[string]interface{}{"panicThresholdPercentage": int64(100)}}}, "panicThresholdPercentage"),
	)

	It("serves a status subresource the operator can write without touching spec", func() {
		DeferCleanup(func() { deletePlatformIfPresent(ctx, "default") })
		Expect(k8sClient.Create(ctx, rawPlatform("default", map[string]interface{}{"limits": map[string]interface{}{"timeoutSeconds": int64(600)}}))).To(Succeed())

		p := &platformv1alpha1.KnextPlatform{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "default"}, p)).To(Succeed())
		gen := p.Generation
		p.Status.ObservedGeneration = gen
		p.Status.Rollout = &platformv1alpha1.PlatformRolloutStatus{Pending: 1, Applied: 2, Held: 3}
		apimeta.SetStatusCondition(&p.Status.Conditions, metav1.Condition{Type: "Accepted", Status: metav1.ConditionTrue, Reason: "Accepted"})
		Expect(k8sClient.Status().Update(ctx, p)).To(Succeed())

		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "default"}, p)).To(Succeed())
		Expect(p.Status.Rollout).To(Equal(&platformv1alpha1.PlatformRolloutStatus{Pending: 1, Applied: 2, Held: 3}))
		Expect(p.Generation).To(Equal(gen), "a status write must not bump the spec generation")
	})
})

var _ = Describe("the platform merge against a real API server", func() {
	const (
		ns    = "default"
		image = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)
	ctx := context.Background()

	It("merges the platform, persists status.platform through the NextApp CRD schema, and tracks edits by generation", func() {
		DeferCleanup(func() { deletePlatformIfPresent(ctx, "default") })
		Expect(k8sClient.Create(ctx, rawPlatform("default", map[string]interface{}{
			"limits":    map[string]interface{}{"timeoutSeconds": int64(600)},
			"resources": map[string]interface{}{"defaults": map[string]interface{}{"cpuLimit": "2"}},
		}))).To(Succeed())

		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "platform-merge-app", Namespace: ns},
			Spec: appsv1alpha1.NextAppSpec{
				Image:     image,
				Resources: &appsv1alpha1.ResourcesSpec{MemoryLimit: "3Gi"},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		nn := types.NamespacedName{Name: app.Name, Namespace: ns}
		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				cleanup := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanup.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
					return apierrors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
				}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
			}
		})

		r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), PlatformCRDPresent: true}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		By("rendering the platform's values where the app left a field unset")
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		Expect(*ksvc.Spec.Template.Spec.TimeoutSeconds).To(BeEquivalentTo(600))
		limits := ksvc.Spec.Template.Spec.Containers[0].Resources.Limits
		Expect(limits.Cpu().String()).To(Equal("2"))
		Expect(limits.Memory().String()).To(Equal("3Gi"), "the app's own memoryLimit wins")

		By("recording the merge in status.platform, which the real CRD schema must accept")
		got := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, got)).To(Succeed())
		Expect(got.Status.Platform).NotTo(BeNil())
		Expect(got.Status.Platform.InheritedFields).To(ConsistOf("spec.resources.cpuLimit", "spec.timeoutSeconds"))
		Expect(got.Status.Platform.SpecHash).NotTo(BeEmpty())
		Expect(got.Status.Platform.EffectiveHash).NotTo(BeEmpty())
		firstGen := got.Status.Platform.ObservedGeneration
		Expect(firstGen).To(BeNumerically(">=", 1))
		cond := apimeta.FindStatusCondition(got.Status.Conditions, ConditionPlatformDefaultsApplied)
		Expect(cond).NotTo(BeNil())
		Expect(cond.Reason).To(Equal(ReasonInherited))

		By("a spec edit bumps the real generation and the next pass observes it")
		p := &platformv1alpha1.KnextPlatform{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "default"}, p)).To(Succeed())
		p.Spec.Limits.TimeoutSeconds = 900
		Expect(k8sClient.Update(ctx, p)).To(Succeed())
		Expect(p.Generation).To(BeNumerically(">", firstGen))
		// A single pass is enough: the platform's default rate (10/min) frees the
		// first slot immediately.
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		Expect(*ksvc.Spec.Template.Spec.TimeoutSeconds).To(BeEquivalentTo(900))
		Expect(k8sClient.Get(ctx, nn, got)).To(Succeed())
		Expect(got.Status.Platform.ObservedGeneration).To(Equal(p.Generation))
	})
})

// newStartupManager builds a manager the way cmd/main.go does — the scheme
// carries the platform types whether or not the CRD exists — against cfg.
func newStartupManager(cfg2 *rest.Config) (ctrl.Manager, *runtime.Scheme) {
	s := runtime.NewScheme()
	Expect(clientgoscheme.AddToScheme(s)).To(Succeed())
	Expect(appsv1alpha1.AddToScheme(s)).To(Succeed())
	Expect(platformv1alpha1.AddToScheme(s)).To(Succeed())
	Expect(servingv1.AddToScheme(s)).To(Succeed())
	Expect(servingv1beta1.AddToScheme(s)).To(Succeed())
	mgr, err := ctrl.NewManager(cfg2, ctrl.Options{
		Scheme:                 s,
		Metrics:                metricsserver.Options{BindAddress: "0"},
		HealthProbeBindAddress: "0",
		// Several managers register a controller named "nextapp" in this one test
		// process; production runs exactly one.
		//
		// CacheSyncTimeout is shortened so a controller that is wired to a kind the
		// cluster does not serve FAILS the manager within seconds. At the 2 minute
		// default that failure would land after any sensible assertion window, and
		// "the manager started" would pass for a manager that is about to crash-loop.
		Controller: config.Controller{
			SkipNameValidation: ptr.To(true),
			CacheSyncTimeout:   3 * time.Second,
		},
	})
	Expect(err).NotTo(HaveOccurred())
	return mgr, s
}

var _ = Describe("operator start-up without the KnextPlatform CRD (ADR-0064 P0-3b)", func() {
	It("starts, becomes ready and reconciles a NextApp, reporting NoPlatformCRD", func() {
		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)

		By("an API server that has the NextApp and Knative CRDs but NOT the KnextPlatform CRD")
		env := &envtest.Environment{
			CRDDirectoryPaths: []string{
				filepath.Join("..", "..", "config", "crd", "bases", "apps.kn-next.dev_nextapps.yaml"),
				filepath.Join("..", "..", "config", "testdata", "crds"),
			},
			ErrorIfCRDPathMissing: true,
		}
		if dir := getFirstFoundEnvTestBinaryDir(); dir != "" {
			env.BinaryAssetsDirectory = dir
		}
		cfg2, err := env.Start()
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(func() { _ = env.Stop() })

		mgr, scheme2 := newStartupManager(cfg2)
		Expect(platformv1alpha1.CRDInstalled(mgr.GetRESTMapper())).To(BeFalse(),
			"discovery must report the CRD absent — otherwise this spec is not testing the absent case")

		By("registering the controllers exactly as cmd/main.go does")
		Expect(SetupControllers(mgr, nil)).To(Succeed())

		managerExit := make(chan error, 1)
		go func() {
			defer GinkgoRecover()
			managerExit <- mgr.Start(ctx)
		}()
		Expect(mgr.GetCache().WaitForCacheSync(ctx)).To(BeTrue(), "the manager's caches must sync without the platform kind")

		By("reconciling a NextApp to completion")
		c, err := client.New(cfg2, client.Options{Scheme: scheme2})
		Expect(err).NotTo(HaveOccurred())
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "startup-no-crd", Namespace: "default"},
			Spec: appsv1alpha1.NextAppSpec{
				Image: "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
			},
		}
		Expect(c.Create(ctx, app)).To(Succeed())
		nn := client.ObjectKeyFromObject(app)

		Eventually(func(g Gomega) {
			g.Expect(c.Get(ctx, nn, &servingv1.Service{})).To(Succeed(), "the operator never created the Knative Service")
			got := &appsv1alpha1.NextApp{}
			g.Expect(c.Get(ctx, nn, got)).To(Succeed())
			cond := apimeta.FindStatusCondition(got.Status.Conditions, ConditionPlatformDefaultsApplied)
			g.Expect(cond).NotTo(BeNil())
			g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			g.Expect(cond.Reason).To(Equal(ReasonNoPlatformCRD))
			g.Expect(got.Status.Platform).To(BeNil())
		}, 30*time.Second, 200*time.Millisecond).Should(Succeed())

		By("the manager keeps running: no controller is waiting on a kind the cluster does not serve")
		// A controller registered for the missing kind cannot sync its cache; with
		// the shortened timeout that ends mgr.Start with an error inside this window.
		Consistently(managerExit, 8*time.Second, 250*time.Millisecond).ShouldNot(Receive(),
			"the manager exited: something is registered for a kind that is not installed, which would "+
				"crash-loop the operator on a cluster without the KnextPlatform CRD")
	})
})

var _ = Describe("operator with the KnextPlatform CRD: the watch drives the merge and the platform's own status", func() {
	It("propagates a platform edit to a NextApp and reports it on the platform", func() {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		mgr, scheme2 := newStartupManager(cfg)
		Expect(platformv1alpha1.CRDInstalled(mgr.GetRESTMapper())).To(BeTrue())
		Expect(SetupControllers(mgr, nil)).To(Succeed())
		go func() {
			defer GinkgoRecover()
			_ = mgr.Start(ctx)
		}()
		Expect(mgr.GetCache().WaitForCacheSync(ctx)).To(BeTrue())

		c, err := client.New(cfg, client.Options{Scheme: scheme2})
		Expect(err).NotTo(HaveOccurred())

		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "platform-watch-app", Namespace: "default"},
			Spec: appsv1alpha1.NextAppSpec{
				Image: "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
			},
		}
		Expect(c.Create(ctx, app)).To(Succeed())
		nn := client.ObjectKeyFromObject(app)
		DeferCleanup(func() {
			cancel() // stop the manager so its finalizer-less cleanup below is ours alone
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(context.Background(), nn, cur); err == nil {
				Expect(k8sClient.Delete(context.Background(), cur)).To(Succeed())
				cleanup := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanup.Reconcile(context.Background(), reconcile.Request{NamespacedName: nn})
					return apierrors.IsNotFound(k8sClient.Get(context.Background(), nn, &appsv1alpha1.NextApp{}))
				}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
			}
			deletePlatformIfPresent(context.Background(), "default")
		})

		By("the app first reconciles with no platform")
		Eventually(func(g Gomega) {
			got := &appsv1alpha1.NextApp{}
			g.Expect(c.Get(ctx, nn, got)).To(Succeed())
			cond := apimeta.FindStatusCondition(got.Status.Conditions, ConditionPlatformDefaultsApplied)
			g.Expect(cond).NotTo(BeNil())
			g.Expect(cond.Reason).To(Equal(ReasonNoPlatform))
		}, 30*time.Second, 200*time.Millisecond).Should(Succeed())

		By("creating the platform: the watch re-enqueues the app with no edit to the app")
		Expect(c.Create(ctx, rawPlatform("default", map[string]interface{}{
			"limits": map[string]interface{}{"timeoutSeconds": int64(600)},
		}))).To(Succeed())

		Eventually(func(g Gomega) {
			ksvc := &servingv1.Service{}
			g.Expect(c.Get(ctx, nn, ksvc)).To(Succeed())
			g.Expect(*ksvc.Spec.Template.Spec.TimeoutSeconds).To(BeEquivalentTo(600))
			got := &appsv1alpha1.NextApp{}
			g.Expect(c.Get(ctx, nn, got)).To(Succeed())
			g.Expect(got.Status.Platform).NotTo(BeNil())
			g.Expect(got.Status.Platform.InheritedFields).To(ConsistOf("spec.timeoutSeconds"))
		}, 30*time.Second, 200*time.Millisecond).Should(Succeed())

		By("the platform reports itself Accepted and fully propagated")
		Eventually(func(g Gomega) {
			p := &platformv1alpha1.KnextPlatform{}
			g.Expect(c.Get(ctx, types.NamespacedName{Name: "default"}, p)).To(Succeed())
			g.Expect(p.Status.ObservedGeneration).To(Equal(p.Generation))
			acc := apimeta.FindStatusCondition(p.Status.Conditions, PlatformConditionAccepted)
			g.Expect(acc).NotTo(BeNil())
			g.Expect(acc.Status).To(Equal(metav1.ConditionTrue))
			prop := apimeta.FindStatusCondition(p.Status.Conditions, PlatformConditionDefaultsPropagated)
			g.Expect(prop).NotTo(BeNil())
			g.Expect(prop.Status).To(Equal(metav1.ConditionTrue))
			g.Expect(p.Status.Rollout).NotTo(BeNil())
			g.Expect(p.Status.Rollout.Applied).To(BeNumerically(">=", 1))
			g.Expect(p.Status.Rollout.Pending).To(BeZero())
		}, 30*time.Second, 200*time.Millisecond).Should(Succeed())

		By("deleting the platform reverts the app to the built-in value")
		Expect(c.Delete(ctx, rawPlatform("default", nil))).To(Succeed())
		Eventually(func(g Gomega) {
			ksvc := &servingv1.Service{}
			g.Expect(c.Get(ctx, nn, ksvc)).To(Succeed())
			g.Expect(*ksvc.Spec.Template.Spec.TimeoutSeconds).To(BeEquivalentTo(300))
			got := &appsv1alpha1.NextApp{}
			g.Expect(c.Get(ctx, nn, got)).To(Succeed())
			g.Expect(got.Status.Platform).To(BeNil())
		}, 30*time.Second, 200*time.Millisecond).Should(Succeed())
	})
})
