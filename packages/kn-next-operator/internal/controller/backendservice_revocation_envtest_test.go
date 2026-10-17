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

	"github.com/prometheus/client_golang/prometheus/testutil"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// Revocation must survive an unreadable Secret. Holding a running function on
// an unknown answer is only safe if the hold cannot be used to keep a REVOKED
// Secret: the function's own spec is the owner's to edit, so the owner decides
// whether a read "errors". These specs close that door: the running Knative
// Service's own Secret references are re-checked on every pass, a name the
// client cannot even send is a definitive refusal, and a persistent
// Forbidden is not held forever.
// The mutation prover scripts/mutation-prove-2498-transient-secret.mjs proves
// them.

// specOverrideClient serves the BackendService with its spec rewritten, so a
// spec the CRD would refuse at admission still reaches the reconciler (an
// object created before the schema tightened, or one the schema cannot see).
type specOverrideClient struct {
	client.Client
	mutate func(*appsv1alpha1.BackendService)
}

func (c specOverrideClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	err := c.Client.Get(ctx, key, obj, opts...)
	if bs, ok := obj.(*appsv1alpha1.BackendService); ok && err == nil && c.mutate != nil {
		c.mutate(bs)
	}
	return err
}

// webhookLikeClient rejects every write of a Knative Service the way Knative's
// admission webhook rejects a reserved mount path: Reconcile's render fails and
// returns early, so anything that only runs AFTER render never runs.
type webhookLikeClient struct{ specOverrideClient }

func rejectedByWebhook() error {
	return apierrors.NewInvalid(schema.GroupKind{Group: "serving.knative.dev", Kind: "Service"}, "pricing",
		nil)
}

func (c webhookLikeClient) Create(ctx context.Context, obj client.Object, opts ...client.CreateOption) error {
	if _, ok := obj.(*servingv1.Service); ok {
		return rejectedByWebhook()
	}
	return c.Client.Create(ctx, obj, opts...)
}

func (c webhookLikeClient) Update(ctx context.Context, obj client.Object, opts ...client.UpdateOption) error {
	if _, ok := obj.(*servingv1.Service); ok {
		return rejectedByWebhook()
	}
	return c.Client.Update(ctx, obj, opts...)
}

func (c webhookLikeClient) Patch(ctx context.Context, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
	if _, ok := obj.(*servingv1.Service); ok {
		return rejectedByWebhook()
	}
	return c.Client.Patch(ctx, obj, patch, opts...)
}

var _ = Describe("BackendService reconciler: an unreadable Secret never keeps a revoked one running", func() {
	ctx := context.Background()

	setup := func(secrets ...string) (ns string) {
		ns = bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		for _, s := range secrets {
			Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
				Name: s, Namespace: ns, Labels: map[string]string{ZoneLabel: "orders"},
			}})).To(Succeed())
		}
		return ns
	}
	envFrom := func(name string) func(*appsv1alpha1.BackendService) {
		return func(bs *appsv1alpha1.BackendService) { bs.Spec.EnvFrom = specEnvFromSecret(name).EnvFrom }
	}
	reconcileFn := func(r *BackendServiceReconciler, ns string) error {
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
		return err
	}
	revoke := func(ns, secret string) {
		sec := &corev1.Secret{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: secret}, sec)).To(Succeed())
		sec.Labels[ZoneLabel] = "billing"
		Expect(k8sClient.Update(ctx, sec)).To(Succeed())
	}
	sovereignty := func(ns string) *metav1.Condition {
		return functionCondition(getFunction(ctx, ns, "pricing"), ConditionSovereigntyCompliant)
	}

	It("tears down a running function whose Secret was revoked, even when the NEW spec's Secret cannot be read", func() {
		ns := setup("stripe", "flaky")
		createFunction(ctx, ns, "pricing", "orders", envFrom("stripe"))
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())

		By("the owner revokes nothing themselves: the platform relabels stripe for another zone")
		revoke(ns, "stripe")
		By("the owner swaps the spec to a Secret whose read fails")
		bs := getFunction(ctx, ns, "pricing")
		bs.Spec.EnvFrom = specEnvFromSecret("flaky").EnvFrom
		Expect(k8sClient.Update(ctx, bs)).To(Succeed())

		r := newBSReconciler()
		r.APIReader = &secretMetaFailer{Reader: k8sClient, err: transientErrors["a 503"], only: "flaky"}
		Expect(reconcileFn(r, ns)).To(Succeed(), "a definitive refusal is a status, not an error")

		expectNothingRendered(ctx, ns, "pricing")
		c := sovereignty(ns)
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Message).To(ContainSubstring(`"stripe"`), "the running Knative Service's own reference is named")
	})

	It("tears down for the exact repro: a revoked Secret, then a Secret ref with an empty name", func() {
		ns := setup("stripe")
		createFunction(ctx, ns, "pricing", "orders", envFrom("stripe"))
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		revoke(ns, "stripe")

		r := newBSReconciler()
		r.Client = specOverrideClient{Client: k8sClient, mutate: func(bs *appsv1alpha1.BackendService) {
			bs.Spec.EnvFrom = specEnvFromSecret("").EnvFrom
		}}
		Expect(reconcileFn(r, ns)).To(Succeed())

		expectNothingRendered(ctx, ns, "pricing")
		Expect(sovereignty(ns).Status).To(Equal(metav1.ConditionFalse))
	})

	for _, name := range []string{"", "..", "a/b", "UPPER", ".leading", "-leading", "has space", strings.Repeat("a", 254)} {
		It("refuses the invalid Secret name "+strings.ReplaceAll(`"`+name+`"`, strings.Repeat("a", 254), "a*254")+" as a violation, never holds it as unverified", func() {
			ns := setup()
			createFunction(ctx, ns, "pricing", "orders")
			reconcileFunction(ctx, ns, "pricing") // adds the finalizer and renders
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
			r := newBSReconciler()
			r.Client = specOverrideClient{Client: k8sClient, mutate: func(bs *appsv1alpha1.BackendService) {
				bs.Spec.EnvFrom = specEnvFromSecret(name).EnvFrom
			}}
			Expect(reconcileFn(r, ns)).To(Succeed(), "an invalid name is a definitive answer, not a transient error")

			expectNothingRendered(ctx, ns, "pricing")
			c := sovereignty(ns)
			Expect(c.Status).To(Equal(metav1.ConditionFalse))
			Expect(c.Reason).To(Equal(ReasonSecretNotAllowed))
			Expect(c.Message).To(ContainSubstring("not a valid Secret name"))
		})
	}

	It("tears down a running function whose Secret was revoked even when the new spec cannot be rolled out", func() {
		ns := setup("stripe")
		createFunction(ctx, ns, "pricing", "orders", envFrom("stripe"))
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		revoke(ns, "stripe")

		By("the owner drops stripe and adds a volume Knative refuses (a reserved mount path); the ksvc update is rejected as the webhook does")
		r := newBSReconciler()
		r.Client = webhookLikeClient{specOverrideClient{Client: k8sClient, mutate: func(bs *appsv1alpha1.BackendService) {
			bs.Spec.EnvFrom = nil
			bs.Spec.Volumes = []appsv1alpha1.FunctionVolume{{Name: "scratch", MountPath: "/dev", EmptyDir: &corev1.EmptyDirVolumeSource{}}}
		}}}
		_ = reconcileFn(r, ns)

		expectNothingRendered(ctx, ns, "pricing")
		c := sovereignty(ns)
		Expect(c.Status).To(Equal(metav1.ConditionFalse), "what is RUNNING is checked whatever the new spec says")
		Expect(c.Message).To(ContainSubstring(`"stripe"`))
	})

	Context("the CRD refuses a mount path Knative serving reserves", func() {
		mount := func(ns, path string) error {
			bs := &appsv1alpha1.BackendService{
				ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: ns},
				Spec: appsv1alpha1.BackendServiceSpec{Volumes: []appsv1alpha1.FunctionVolume{
					{Name: "scratch", MountPath: path, EmptyDir: &corev1.EmptyDirVolumeSource{}}}},
			}
			bs.Spec.Zone, bs.Spec.Image, bs.Spec.ProtoVersion = "orders", bsImage, "1.0.0"
			err := k8sClient.Create(ctx, bs)
			if err == nil {
				DeferCleanup(deleteFunctionAndFinalize, ctx, client.ObjectKeyFromObject(bs))
			}
			return err
		}
		for _, path := range []string{"/", "/dev", "/dev/log", "/dev/", "//dev", "/dev//log", "/a/../dev", "/./dev", "/dev/."} {
			It("rejects "+path, func() {
				err := mount(setup(), path)
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "got %v", err)
				Expect(err.Error()).To(Or(ContainSubstring("reserved by Knative"), ContainSubstring("clean absolute path")))
			})
		}
		for _, path := range []string{"/creds", "/dev/shm", "/data.v2/x", "/var/lib/app"} {
			It("admits "+path, func() {
				Expect(mount(setup(), path)).To(Succeed())
			})
		}
	})

	Context("the CRD refuses a Secret reference that names no Secret", func() {
		sources := map[string]func(string) appsv1alpha1.BackendServiceSpec{
			"secretKeyRef":    specSecretKeyRef,
			"envFrom":         specEnvFromSecret,
			"a Secret volume": specSecretVolume,
			"a projected one": specProjectedSecret,
		}
		for source, spec := range sources {
			for _, name := range []string{"", strings.Repeat("a", 254)} {
				It("rejects "+source+" naming "+strings.ReplaceAll(`"`+name+`"`, strings.Repeat("a", 254), "a*254"), func() {
					ns := setup()
					bs := &appsv1alpha1.BackendService{
						ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: ns},
						Spec:       spec(name),
					}
					bs.Spec.Zone, bs.Spec.Image, bs.Spec.ProtoVersion = "orders", bsImage, "1.0.0"
					err := k8sClient.Create(ctx, bs)
					Expect(apierrors.IsInvalid(err)).To(BeTrue(), "the schema must refuse it at admission, got %v", err)
					Expect(err.Error()).To(ContainSubstring("must name a Secret"))
				})
			}
		}

		// A Go client omits an empty name from the JSON, so `has()` alone would
		// catch that. A manifest that spells `name: ""` out must be refused too.
		rawSpecs := map[string]map[string]any{
			"secretKeyRef": {"env": []any{map[string]any{"name": "DSN", "valueFrom": map[string]any{
				"secretKeyRef": map[string]any{"name": "", "key": "k"}}}}},
			"envFrom": {"envFrom": []any{map[string]any{"secretRef": map[string]any{"name": ""}}}},
			"a Secret volume": {"volumes": []any{map[string]any{"name": "creds", "mountPath": "/creds",
				"secret": map[string]any{"secretName": ""}}}},
			"a projected one": {"volumes": []any{map[string]any{"name": "bundle", "mountPath": "/bundle",
				"projected": map[string]any{"sources": []any{map[string]any{"secret": map[string]any{"name": ""}}}}}}},
		}
		for source, extra := range rawSpecs {
			It("rejects "+source+" with an explicitly empty name", func() {
				ns := setup()
				spec := map[string]any{"zone": "orders", "image": bsImage, "protoVersion": "1.0.0"}
				for k, v := range extra {
					spec[k] = v
				}
				u := &unstructured.Unstructured{Object: map[string]any{
					"apiVersion": appsv1alpha1.GroupVersion.String(),
					"kind":       "BackendService",
					"metadata":   map[string]any{"name": "pricing", "namespace": ns},
					"spec":       spec,
				}}
				err := k8sClient.Create(ctx, u)
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "the schema must refuse an explicit empty name, got %v", err)
				Expect(err.Error()).To(ContainSubstring("must name a Secret"))
			})
		}

		// The apiserver's static cost budget does not allow a regular expression
		// over these unbounded core-type strings, so the schema bounds the name
		// (non-empty, at most 253) and the reconciler holds the full DNS rule.
		for source, spec := range sources {
			for _, name := range []string{"..", "a/b", "UPPER", ".leading", "has space"} {
				It("admits "+source+" naming "+`"`+name+`"`+", and the reconciler refuses it", func() {
					ns := setup()
					bs := &appsv1alpha1.BackendService{
						ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: ns},
						Spec:       spec(name),
					}
					bs.Spec.Zone, bs.Spec.Image, bs.Spec.ProtoVersion = "orders", bsImage, "1.0.0"
					Expect(k8sClient.Create(ctx, bs)).To(Succeed())
					DeferCleanup(deleteFunctionAndFinalize, ctx, client.ObjectKeyFromObject(bs))
					reconcileFunction(ctx, ns, "pricing")
					expectNothingRendered(ctx, ns, "pricing")
					c := sovereignty(ns)
					Expect(c.Status).To(Equal(metav1.ConditionFalse))
					Expect(c.Message).To(ContainSubstring("not a valid Secret name"))
				})
			}
		}

		It("still admits a valid DNS-subdomain Secret name, dots included", func() {
			ns := setup()
			bs := &appsv1alpha1.BackendService{
				ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: ns},
				Spec:       specEnvFromSecret("my-secret.v2"),
			}
			bs.Spec.Zone, bs.Spec.Image, bs.Spec.ProtoVersion = "orders", bsImage, "1.0.0"
			Expect(k8sClient.Create(ctx, bs)).To(Succeed())
			DeferCleanup(deleteFunctionAndFinalize, ctx, client.ObjectKeyFromObject(bs))
		})
	})

	Context("a persistent Forbidden", func() {
		forbidden := apierrors.NewForbidden(schema.GroupResource{Resource: "secrets"}, "stripe", errors.New("simulated"))

		// The hold is counted from the first DENIAL, which the operator records
		// in status.secretsDeniedSince. Backdating it stands in for elapsed time.
		deniedSince := func(ns string) *metav1.Time { return getFunction(ctx, ns, "pricing").Status.SecretsDeniedSince }
		backdateDenial := func(ns string, age time.Duration) {
			bs := getFunction(ctx, ns, "pricing")
			Expect(bs.Status.SecretsDeniedSince).NotTo(BeNil(), "the first denied pass must have recorded it")
			t := metav1.NewTime(time.Now().Add(-age))
			bs.Status.SecretsDeniedSince = &t
			Expect(k8sClient.Status().Update(ctx, bs)).To(Succeed())
		}
		run := func(ns string, err error) error {
			r := newBSReconciler()
			r.APIReader = &secretMetaFailer{Reader: k8sClient, err: err}
			return reconcileFn(r, ns)
		}
		running := func() string {
			ns := setup("stripe")
			createFunction(ctx, ns, "pricing", "orders", envFrom("stripe"))
			reconcileFunction(ctx, ns, "pricing")
			return ns
		}

		It("is held at first, so a short RBAC blip never costs a running function", func() {
			ns := running()
			Expect(run(ns, forbidden)).NotTo(Succeed())
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
			backdateDenial(ns, 2*time.Minute)
			Expect(run(ns, forbidden)).NotTo(Succeed())
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue(), "2 minutes is inside the hold")
		})

		It("is treated as definitive once the hold has run out: the function is refused and torn down", func() {
			ns := running()
			Expect(run(ns, forbidden)).NotTo(Succeed())
			backdateDenial(ns, 2*time.Hour)

			Expect(run(ns, forbidden)).To(Succeed(), "after the hold it is a definitive refusal, not an error")
			expectNothingRendered(ctx, ns, "pricing")
			c := sovereignty(ns)
			Expect(c.Status).To(Equal(metav1.ConditionFalse))
			Expect(c.Message).To(ContainSubstring("denied"))
		})

		It("never turns a TRANSIENT error into a teardown, however long it lasts, and never starts the clock", func() {
			ns := running()
			for i := 0; i < 3; i++ {
				Expect(run(ns, transientErrors["a 503"])).NotTo(Succeed())
				Expect(deniedSince(ns)).To(BeNil(), "a 503 is not a denial")
				Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
			}
		})

		It("counts the hold from the first 403, not from the 503s that came before", func() {
			ns := running()
			Expect(run(ns, transientErrors["a 503"])).NotTo(Succeed())
			Expect(run(ns, forbidden)).NotTo(Succeed())
			Expect(deniedSince(ns)).NotTo(BeNil())
			Expect(time.Since(deniedSince(ns).Time)).To(BeNumerically("<", time.Minute))

			By("9 minutes into the denial it is still held")
			backdateDenial(ns, 9*time.Minute)
			Expect(run(ns, forbidden)).NotTo(Succeed())
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
			By("11 minutes in it is refused")
			backdateDenial(ns, 11*time.Minute)
			Expect(run(ns, forbidden)).To(Succeed())
			expectNothingRendered(ctx, ns, "pricing")
		})

		It("stays refused while the denial lasts: no flapping back to Unknown, one refusal counted, one event", func() {
			ns := running()
			Expect(run(ns, forbidden)).NotTo(Succeed())
			backdateDenial(ns, 2*time.Hour)

			r := newBSReconciler()
			r.APIReader = &secretMetaFailer{Reader: k8sClient, err: forbidden}
			recorder := r.Recorder.(*record.FakeRecorder)
			before := testutil.ToFloat64(backendServiceRefusalsTotal.WithLabelValues(ReasonSovereigntyViolation))
			for i := 0; i < 4; i++ {
				Expect(reconcileFn(r, ns)).To(Succeed())
				c := sovereignty(ns)
				Expect(c.Status).To(Equal(metav1.ConditionFalse), "pass %d must still be refused", i)
				Expect(c.Reason).To(Equal(ReasonSecretNotAllowed), "pass %d must not flap back to Unknown", i)
				expectNothingRendered(ctx, ns, "pricing")
			}
			Expect(testutil.ToFloat64(backendServiceRefusalsTotal.WithLabelValues(ReasonSovereigntyViolation))-before).To(Equal(1.0),
				"the transition into the refusal is counted once, not on every pass")
			warnings := 0
			for len(recorder.Events) > 0 {
				if strings.Contains(<-recorder.Events, ReasonSovereigntyViolation) {
					warnings++
				}
			}
			Expect(warnings).To(Equal(1), "one Warning event, not one per pass")
		})

		It("clears the recorded denial as soon as no read is denied, and renders again", func() {
			ns := running()
			Expect(run(ns, forbidden)).NotTo(Succeed())
			Expect(deniedSince(ns)).NotTo(BeNil())
			Expect(run(ns, nil)).To(Succeed())
			Expect(deniedSince(ns)).To(BeNil())
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
		})
	})

	Context("a spec change that cannot be verified", func() {
		It("does not report the new generation as observed or Ready", func() {
			ns := setup("stripe")
			createFunction(ctx, ns, "pricing", "orders", envFrom("stripe"))
			reconcileFunction(ctx, ns, "pricing")
			markFunctionServed(ctx, ns, "pricing", "pricing-00001", "1.0.0")
			reconcileFunction(ctx, ns, "pricing")
			settled := getFunction(ctx, ns, "pricing")
			Expect(functionCondition(settled, ConditionReady).Status).To(Equal(metav1.ConditionTrue))

			By("the spec changes (a new generation), and the read of its Secret fails")
			bs := getFunction(ctx, ns, "pricing")
			bs.Spec.Env = append(bs.Spec.Env, corev1.EnvVar{Name: "FEATURE", Value: "on"})
			Expect(k8sClient.Update(ctx, bs)).To(Succeed())
			Expect(getFunction(ctx, ns, "pricing").Generation).To(BeNumerically(">", settled.Generation))

			r := newBSReconciler()
			r.APIReader = &secretMetaFailer{Reader: k8sClient, err: transientErrors["a 503"]}
			Expect(reconcileFn(r, ns)).NotTo(Succeed())

			after := getFunction(ctx, ns, "pricing")
			Expect(after.Status.ObservedGeneration).To(Equal(settled.Status.ObservedGeneration),
				"the new spec was not rolled out, so its generation is not observed")
			ready := functionCondition(after, ConditionReady)
			Expect(ready.Status).To(Equal(metav1.ConditionFalse), "kubectl wait and GitOps must not see the new generation as deployed")
			Expect(ready.Reason).To(Equal(ReasonSecretsUnverified))
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue(), "and the running function is still left alone")

			By("once the Secret reads again, the new generation rolls out and is observed")
			reconcileFunction(ctx, ns, "pricing")
			Expect(getFunction(ctx, ns, "pricing").Status.ObservedGeneration).To(Equal(after.Generation))
		})
	})
})
