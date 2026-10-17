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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// A routine rotation (running on stripe-v1, the spec moved to stripe-v2, v1
// pruned) that coincides with ONE transient error must keep the healthy function
// and retry. The pruned old Secret is NotFound, which on the RUNNING template is
// routine rotation, never evidence of revocation: only positive evidence (the
// Secret was re-marked for another zone, is another zone's database Secret or a
// signing key, or the zone is gone) may tear a function down on that template's
// account.

// ksvcWriteFails fails every write of a Knative Service with err.
type ksvcWriteFails struct {
	client.Client
	err error
}

func (c ksvcWriteFails) Update(ctx context.Context, obj client.Object, opts ...client.UpdateOption) error {
	if _, ok := obj.(*servingv1.Service); ok {
		return c.err
	}
	return c.Client.Update(ctx, obj, opts...)
}

func (c ksvcWriteFails) Patch(ctx context.Context, obj client.Object, p client.Patch, opts ...client.PatchOption) error {
	if _, ok := obj.(*servingv1.Service); ok {
		return c.err
	}
	return c.Client.Patch(ctx, obj, p, opts...)
}

// configMap503 answers every ConfigMap metadata read (the zone's JWKS) with a 503.
type configMap503 struct{ client.Reader }

func (f configMap503) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if o, ok := obj.(*metav1.PartialObjectMetadata); ok && o.Kind == "ConfigMap" {
		return apierrors.NewServiceUnavailable("simulated")
	}
	return f.Reader.Get(ctx, key, obj, opts...)
}

var _ = Describe("BackendService reconciler: a rotation that coincides with an apiserver blip keeps the function", func() {
	ctx := context.Background()

	// prep: running on stripe-v1, then the spec moves to stripe-v2 and v1 is pruned.
	prep := func() (ns string, uid types.UID) {
		ns = bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		for _, s := range []string{"stripe-v1", "stripe-v2"} {
			Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
				Name: s, Namespace: ns, Labels: map[string]string{ZoneLabel: "orders"}}})).To(Succeed())
		}
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.EnvFrom = specEnvFromSecret("stripe-v1").EnvFrom
		})
		reconcileFunction(ctx, ns, "pricing")
		k := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, k)).To(Succeed())
		bs := getFunction(ctx, ns, "pricing")
		bs.Spec.EnvFrom = specEnvFromSecret("stripe-v2").EnvFrom
		Expect(k8sClient.Update(ctx, bs)).To(Succeed())
		Expect(k8sClient.Delete(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "stripe-v1", Namespace: ns}})).To(Succeed())
		return ns, k.UID
	}
	run := func(r *BackendServiceReconciler, ns string) error {
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
		return err
	}
	expectKept := func(ns string, uid types.UID) {
		k := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, k)).To(Succeed(),
			"a healthy function must not be torn down on one transient error")
		Expect(k.UID).To(Equal(uid))
		c := functionCondition(getFunction(ctx, ns, "pricing"), ConditionSovereigntyCompliant)
		Expect(c.Status).NotTo(Equal(metav1.ConditionFalse), "the pruned old Secret is not a violation")
	}

	It("keeps the function and requeues on a 503 reading the NEW Secret (rotation blip A)", func() {
		ns, uid := prep()
		r := newBSReconciler()
		r.APIReader = &secretMetaFailer{Reader: k8sClient, err: apierrors.NewServiceUnavailable("simulated"), only: "stripe-v2"}
		Expect(run(r, ns)).NotTo(Succeed(), "the unknown answer is returned, so the reconcile requeues with backoff")
		expectKept(ns, uid)

		By("the blip clears: the rotation completes in place")
		Expect(run(newBSReconciler(), ns)).To(Succeed())
		after := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, after)).To(Succeed())
		Expect(after.UID).To(Equal(uid))
		Expect(after.Spec.Template.Spec.Containers[0].EnvFrom[0].SecretRef.Name).To(Equal("stripe-v2"))
	})

	It("keeps the function and returns the error on a 503 updating the Knative Service (rotation blip B)", func() {
		ns, uid := prep()
		r := newBSReconciler()
		r.Client = ksvcWriteFails{k8sClient, apierrors.NewServiceUnavailable("simulated")}
		Expect(run(r, ns)).NotTo(Succeed())
		expectKept(ns, uid)
	})

	It("keeps the function on a 503 reading the zone's JWKS ConfigMap (rotation blip C)", func() {
		ns, uid := prep()
		r := newBSReconciler()
		r.APIReader = configMap503{k8sClient}
		Expect(run(r, ns)).NotTo(Succeed())
		expectKept(ns, uid)
	})

	It("keeps the function on a 409 Conflict updating the Knative Service, as when it races Knative's status write (rotation blip D)", func() {
		ns, uid := prep()
		r := newBSReconciler()
		r.Client = ksvcWriteFails{k8sClient, apierrors.NewConflict(schema.GroupResource{Group: "serving.knative.dev", Resource: "services"}, "pricing", errors.New("simulated"))}
		Expect(run(r, ns)).NotTo(Succeed())
		expectKept(ns, uid)
	})

	// Only a DEFINITIVE refusal of the spec (Invalid or BadRequest, as Knative's
	// webhook answers) may tear a function down on the running template's
	// account, and only when that template has positive evidence of revocation.
	// A transient error, a Conflict or a Forbidden is held: the function keeps
	// running and the reconcile retries.
	for name, refusal := range map[string]error{
		"a 503":       apierrors.NewServiceUnavailable("simulated"),
		"a 409":       apierrors.NewConflict(schema.GroupResource{Resource: "services"}, "pricing", errors.New("simulated")),
		"a Forbidden": apierrors.NewForbidden(schema.GroupResource{Resource: "services"}, "pricing", errors.New("simulated")),
	} {
		It("holds a REVOKED running Secret when the update fails with "+name+" (not a definitive refusal)", func() {
			ns := bsNamespace(ctx)
			createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
			Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
				Name: "stripe", Namespace: ns, Labels: map[string]string{ZoneLabel: "orders"}}})).To(Succeed())
			createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
				bs.Spec.EnvFrom = specEnvFromSecret("stripe").EnvFrom
			})
			reconcileFunction(ctx, ns, "pricing")
			sec := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "stripe"}, sec)).To(Succeed())
			sec.Labels[ZoneLabel] = "billing"
			Expect(k8sClient.Update(ctx, sec)).To(Succeed())
			bs := getFunction(ctx, ns, "pricing")
			bs.Spec.Env = append(bs.Spec.Env, corev1.EnvVar{Name: "FEATURE", Value: "on"})
			bs.Spec.EnvFrom = nil
			Expect(k8sClient.Update(ctx, bs)).To(Succeed())

			r := newBSReconciler()
			r.Client = ksvcWriteFails{k8sClient, refusal}
			Expect(run(r, ns)).NotTo(Succeed())
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue(), "only a definitive refusal tears down")
		})
	}
})
