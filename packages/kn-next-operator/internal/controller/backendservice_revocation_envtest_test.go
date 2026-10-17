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

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
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

		backdateUnverified := func(ns string, age time.Duration) {
			bs := getFunction(ctx, ns, "pricing")
			c := apimeta.FindStatusCondition(bs.Status.Conditions, ConditionSovereigntyCompliant)
			Expect(c).NotTo(BeNil())
			Expect(c.Reason).To(Equal(ReasonSecretsUnverified), "the first held pass must have reported it")
			c.LastTransitionTime = metav1.NewTime(time.Now().Add(-age))
			Expect(k8sClient.Status().Update(ctx, bs)).To(Succeed())
		}
		run := func(ns string, err error) error {
			r := newBSReconciler()
			r.APIReader = &secretMetaFailer{Reader: k8sClient, err: err}
			return reconcileFn(r, ns)
		}

		It("is held at first, so a short RBAC blip never costs a running function", func() {
			ns := setup("stripe")
			createFunction(ctx, ns, "pricing", "orders", envFrom("stripe"))
			reconcileFunction(ctx, ns, "pricing")
			Expect(run(ns, forbidden)).NotTo(Succeed())
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
			backdateUnverified(ns, 2*time.Minute)
			Expect(run(ns, forbidden)).NotTo(Succeed())
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue(), "2 minutes is inside the hold")
		})

		It("is treated as definitive once the hold has run out: the function is refused and torn down", func() {
			ns := setup("stripe")
			createFunction(ctx, ns, "pricing", "orders", envFrom("stripe"))
			reconcileFunction(ctx, ns, "pricing")
			Expect(run(ns, forbidden)).NotTo(Succeed())
			backdateUnverified(ns, 2*time.Hour)

			Expect(run(ns, forbidden)).To(Succeed(), "after the hold it is a definitive refusal, not an error")
			expectNothingRendered(ctx, ns, "pricing")
			c := sovereignty(ns)
			Expect(c.Status).To(Equal(metav1.ConditionFalse))
			Expect(c.Message).To(ContainSubstring("denied"))
		})

		It("never turns a TRANSIENT error into a teardown, however long it lasts", func() {
			ns := setup("stripe")
			createFunction(ctx, ns, "pricing", "orders", envFrom("stripe"))
			reconcileFunction(ctx, ns, "pricing")
			Expect(run(ns, transientErrors["a 503"])).NotTo(Succeed())
			backdateUnverified(ns, 24*time.Hour)

			Expect(run(ns, transientErrors["a 503"])).NotTo(Succeed())
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
