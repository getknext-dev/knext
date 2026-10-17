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
	"fmt"
	"net"
	"os"
	"syscall"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// A transient apiserver error on a Secret's metadata GET is NOT an answer about
// the Secret's marks, so it must never be handled as a sovereignty violation:
// only a definitive answer (NotFound, or an object with the wrong owner or
// labels) refuses a function and takes its Knative Service down. The same
// reconciler's JWKS read already behaves this way
// (backendservice_jwks_envtest_test.go, "on a read failure returns the error and
// leaves what was rendered untouched"). The mutation prover
// scripts/mutation-prove-2498-transient-secret.mjs proves these rows.

// secretMetaFailer is an APIReader whose Secret metadata reads fail with err
// (when set) and otherwise pass through.
type secretMetaFailer struct {
	client.Reader
	err error
	// only, when set, limits the failure to the Secret with that name.
	only string
}

func (f *secretMetaFailer) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if o, ok := obj.(*metav1.PartialObjectMetadata); ok && o.Kind == "Secret" && f.err != nil && (f.only == "" || f.only == key.Name) {
		return f.err
	}
	return f.Reader.Get(ctx, key, obj, opts...)
}

// transientErrors are the non-definitive answers an apiserver read can give.
var transientErrors = map[string]error{
	"a timeout": apierrors.NewTimeoutError("simulated", 1),
	"a 429":     apierrors.NewTooManyRequests("simulated", 1),
	"a 500":     apierrors.NewInternalError(errors.New("simulated")),
	"a 503":     apierrors.NewServiceUnavailable("simulated"),
	"a missing grant, inside the hold window": apierrors.NewForbidden(schema.GroupResource{Resource: "secrets"}, "stripe", errors.New("simulated")),
	"a refused connection":                    &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)},
	"a context deadline":                      fmt.Errorf("get secret: %w", context.DeadlineExceeded),
}

var _ = Describe("BackendService reconciler: a transient Secret read error never tears a function down", func() {
	ctx := context.Background()

	// setup: a zone, a Secret marked for it, and a function that references it.
	setup := func() (ns string) {
		ns = bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
			Name: "stripe", Namespace: ns, Labels: map[string]string{ZoneLabel: "orders"},
		}})).To(Succeed())
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.EnvFrom = specEnvFromSecret("stripe").EnvFrom
		})
		return ns
	}
	reconcileWith := func(ns string, readErr error) error {
		r := newBSReconciler()
		r.APIReader = &secretMetaFailer{Reader: k8sClient, err: readErr}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
		return err
	}
	getKsvc := func(ns string) *servingv1.Service {
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, ksvc)).To(Succeed())
		return ksvc
	}
	getNP := func(ns string) *networkingv1.NetworkPolicy {
		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: FunctionNetworkPolicyName("pricing")}, np)).To(Succeed())
		return np
	}

	for name, injected := range transientErrors {
		It("keeps a running, accepted function on "+name+", returns the error, and does not flip the status to a violation", func() {
			ns := setup()
			reconcileFunction(ctx, ns, "pricing")
			ksvc, np := getKsvc(ns), getNP(ns)
			before := getFunction(ctx, ns, "pricing")
			Expect(functionCondition(before, ConditionSovereigntyCompliant).Status).To(Equal(metav1.ConditionTrue))

			err := reconcileWith(ns, injected)

			Expect(err).To(HaveOccurred(), "an unknown answer must requeue with backoff")
			Expect(err.Error()).To(ContainSubstring("stripe"), "the error names the Secret it could not read")
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue(), "the running function's Knative Service must survive")
			Expect(getKsvc(ns).UID).To(Equal(ksvc.UID), "it must be the same object, not a re-created one")
			Expect(getKsvc(ns).ResourceVersion).To(Equal(ksvc.ResourceVersion), "and untouched")
			Expect(getNP(ns).UID).To(Equal(np.UID), "the NetworkPolicy must survive too")

			after := getFunction(ctx, ns, "pricing")
			c := functionCondition(after, ConditionSovereigntyCompliant)
			Expect(c.Status).To(Equal(metav1.ConditionUnknown), "an unknown answer is not a violation (False) nor a pass (True)")
			Expect(c.Reason).To(Equal(ReasonSecretsUnverified))
			Expect(c.Message).To(ContainSubstring(`"stripe"`))
			Expect(functionCondition(after, ConditionReady).Reason).NotTo(Equal(ReasonSovereigntyViolation))
			Expect(functionCondition(after, ConditionReady).Reason).NotTo(Equal(ReasonSecretNotAllowed))
			Expect(after.Status.URL).To(Equal(before.Status.URL))

			By("the apiserver recovers: the next pass converges on the same Knative Service")
			Expect(reconcileWith(ns, nil)).To(Succeed())
			Expect(getKsvc(ns).UID).To(Equal(ksvc.UID))
		})
	}

	It("renders nothing for a function that was never rendered (fail closed on new access) and returns the error", func() {
		ns := setup()
		err := reconcileWith(ns, transientErrors["a timeout"])
		Expect(err).To(HaveOccurred())
		expectNothingRendered(ctx, ns, "pricing")
		bs := getFunction(ctx, ns, "pricing")
		Expect(functionCondition(bs, ConditionSovereigntyCompliant).Reason).To(Equal(ReasonSecretsUnverified))
		Expect(functionCondition(bs, ConditionReady).Status).To(Equal(metav1.ConditionFalse))
		Expect(functionCondition(bs, ConditionReady).Reason).To(Equal(ReasonSecretsUnverified), "never a SovereigntyViolation")

		By("once the apiserver answers, it renders")
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
	})

	It("still removes a running function on a DEFINITIVE answer: the Secret is gone (NotFound)", func() {
		ns := setup()
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())

		Expect(k8sClient.Delete(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "stripe", Namespace: ns}})).To(Succeed())
		Expect(reconcileWith(ns, nil)).To(Succeed(), "a definitive refusal is a status, not an error")
		expectNothingRendered(ctx, ns, "pricing")
		Expect(functionCondition(getFunction(ctx, ns, "pricing"), ConditionSovereigntyCompliant).Status).To(Equal(metav1.ConditionFalse))
	})

	It("still removes a running function on a DEFINITIVE answer: the Secret is now marked for another zone", func() {
		ns := setup()
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())

		sec := &corev1.Secret{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "stripe"}, sec)).To(Succeed())
		sec.Labels[ZoneLabel] = "billing"
		Expect(k8sClient.Update(ctx, sec)).To(Succeed())
		Expect(reconcileWith(ns, nil)).To(Succeed())
		expectNothingRendered(ctx, ns, "pricing")
		Expect(functionCondition(getFunction(ctx, ns, "pricing"), ConditionSovereigntyCompliant).Reason).To(Equal(ReasonSecretNotAllowed))
	})

	It("lets a definitive violation win over an unknown one in the same function", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createZone(ctx, ns, "billing")
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.EnvFrom = specEnvFromSecret("stripe").EnvFrom // unreadable: unknown
			bs.Spec.Env = specSecretKeyRef("billing-db").Env      // another zone's database Secret: definitive
		})
		Expect(reconcileWith(ns, transientErrors["a 503"])).To(Succeed())
		expectNothingRendered(ctx, ns, "pricing")
		Expect(functionCondition(getFunction(ctx, ns, "pricing"), ConditionSovereigntyCompliant).Reason).To(Equal(ReasonSecretNotAllowed))
	})
})
