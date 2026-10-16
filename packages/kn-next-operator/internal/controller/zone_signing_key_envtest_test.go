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
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/go-logr/logr/funcr"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// The zone's signing key and JWKS through a real Reconcile against an
// apiserver (ADR-0004 Amendment 1 Decisions 9 and 11; the #2051 contract).
// Time is injected through the reconciler's Clock, so the propagation bound and
// the overlap are crossed exactly, never slept through.

type zoneClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *zoneClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *zoneClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newKeyedZoneReconciler(clock *zoneClock) *NextAppReconciler {
	r := newZoneReconciler()
	r.Clock = clock.Now
	r.APIReader = k8sClient
	return r
}

func reconcileWith(ctx context.Context, r *NextAppReconciler, ns, name string) (reconcile.Result, error) {
	return r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: name}})
}

func getSigningKey(ctx context.Context, ns, zone string) (*corev1.Secret, bool) {
	s := &corev1.Secret{}
	err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: ZoneSigningKeySecretName(zone)}, s)
	if apierrors.IsNotFound(err) {
		return nil, false
	}
	Expect(err).NotTo(HaveOccurred())
	return s, true
}

func getJWKS(ctx context.Context, ns, zone string) (*corev1.ConfigMap, bool) {
	cm := &corev1.ConfigMap{}
	err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: ZoneJWKSConfigMapName(zone)}, cm)
	if apierrors.IsNotFound(err) {
		return nil, false
	}
	Expect(err).NotTo(HaveOccurred())
	return cm, true
}

func jwksKids(cm *corev1.ConfigMap) []string {
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
		} `json:"keys"`
	}
	Expect(json.Unmarshal([]byte(cm.Data[ZoneJWKSFileName]), &set)).To(Succeed())
	var out []string
	for _, k := range set.Keys {
		out = append(out, k.Kid)
	}
	return out
}

func expectControlledByZone(obj metav1.Object, app *appsv1alpha1.NextApp) {
	ref := metav1.GetControllerOf(obj)
	Expect(ref).NotTo(BeNil(), "%s must carry a controller ownerReference to its zone", obj.GetName())
	Expect(ref.Kind).To(Equal("NextApp"))
	Expect(ref.Name).To(Equal(app.Name))
	Expect(ref.UID).To(Equal(app.UID))
}

func zoneApp(ctx context.Context, ns, name string) *appsv1alpha1.NextApp {
	app := &appsv1alpha1.NextApp{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, app)).To(Succeed())
	return app
}

func zoneKeyCondition(ctx context.Context, ns, name string) *metav1.Condition {
	return apimeta.FindStatusCondition(zoneApp(ctx, ns, name).Status.Conditions, ConditionZoneSigningKey)
}

func requestRotation(ctx context.Context, ns, name, nonce string) {
	app := zoneApp(ctx, ns, name)
	if app.Annotations == nil {
		app.Annotations = map[string]string{}
	}
	app.Annotations[RotateSigningKeyAnnotation] = nonce
	Expect(k8sClient.Update(ctx, app)).To(Succeed())
}

// boundZoneFixture creates a zone with one two-sided function binding.
func boundZoneFixture(ctx context.Context) (string, *appsv1alpha1.NextApp) {
	ns := bsNamespace(ctx)
	app := createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
	createFunction(ctx, ns, "pricing", "orders")
	return ns, zoneApp(ctx, ns, app.Name)
}

var _ = Describe("NextApp reconciler: the zone signing key and JWKS", func() {
	ctx := context.Background()
	t0 := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)

	It("creates the key Secret and the JWKS for a zone with a bound function, both owned by the zone, and mounts the key into the zone only", func() {
		ns, app := boundZoneFixture(ctx)
		r := newKeyedZoneReconciler(&zoneClock{now: t0})
		_, err := reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())

		sec, ok := getSigningKey(ctx, ns, "orders")
		Expect(ok).To(BeTrue(), "the signing-key Secret must exist")
		expectControlledByZone(sec, app)
		keys, err := readSigningKeySecret(sec)
		Expect(err).NotTo(HaveOccurred(), "the Secret must follow the contract (PKCS#8 current.key, matching current.kid)")
		Expect(keys.next).To(BeNil())
		Expect(keys.previous).To(BeNil())
		Expect(sec.Data).To(HaveKey(signingKeyCurrentKey))
		Expect(sec.Data).To(HaveKey(signingKeyCurrentKid))

		cm, ok := getJWKS(ctx, ns, "orders")
		Expect(ok).To(BeTrue(), "the JWKS ConfigMap must exist")
		expectControlledByZone(cm, app)
		want, err := buildZoneJWKS(keys.current.pub)
		Expect(err).NotTo(HaveOccurred())
		Expect(cm.Data[ZoneJWKSFileName]).To(Equal(string(want)), "the JWKS publishes exactly the Secret's public key")
		Expect(cm.Data[ZoneJWKSFileName]).NotTo(ContainSubstring(`"d"`))

		ksvc := zoneKsvc(ctx, ns, "orders")
		var found bool
		for _, v := range ksvc.Spec.Template.Spec.Volumes {
			if v.Secret != nil && v.Secret.SecretName == ZoneSigningKeySecretName("orders") {
				found = true
			}
		}
		Expect(found).To(BeTrue(), "the zone mounts its own key")
		Expect(zoneEnv(ksvc)).To(HaveKeyWithValue(ZoneIssuerEnv, "knext:zone:"+ns+"/orders"))
		for _, m := range ksvc.Spec.Template.Spec.Containers[0].VolumeMounts {
			if m.Name == ZoneSigningKeyVolumeName {
				Expect(m.SubPath).To(BeEmpty())
				Expect(m.ReadOnly).To(BeTrue())
			}
		}

		c := zoneKeyCondition(ctx, ns, "orders")
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionTrue))
		Expect(c.Reason).To(Equal(ReasonSigningKeyActive))
		Expect(c.Message).To(ContainSubstring(keys.current.kid))
	})

	It("creates nothing and mounts nothing for a zone whose binding is one-sided", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "billing") // names another zone: not bound
		r := newKeyedZoneReconciler(&zoneClock{now: t0})
		_, err := reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		_, ok := getSigningKey(ctx, ns, "orders")
		Expect(ok).To(BeFalse(), "no per-zone key until both halves agree")
		_, ok = getJWKS(ctx, ns, "orders")
		Expect(ok).To(BeFalse(), "no JWKS until both halves agree")
		ksvc := zoneKsvc(ctx, ns, "orders")
		Expect(ksvc.Spec.Template.Spec.Volumes).To(BeEmpty())
		Expect(zoneEnv(ksvc)).NotTo(HaveKey(ZoneIssuerEnv))
		Expect(zoneKeyCondition(ctx, ns, "orders")).To(BeNil())
	})

	It("is idempotent: re-reconciling writes neither object and rolls no revision", func() {
		ns, _ := boundZoneFixture(ctx)
		r := newKeyedZoneReconciler(&zoneClock{now: t0})
		_, err := reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, _ := getSigningKey(ctx, ns, "orders")
		cm, _ := getJWKS(ctx, ns, "orders")
		gen := zoneKsvc(ctx, ns, "orders").Generation
		for i := 0; i < 5; i++ {
			_, err := reconcileWith(ctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
		}
		sec2, _ := getSigningKey(ctx, ns, "orders")
		cm2, _ := getJWKS(ctx, ns, "orders")
		Expect(sec2.ResourceVersion).To(Equal(sec.ResourceVersion), "a converged Secret must not be rewritten")
		Expect(cm2.ResourceVersion).To(Equal(cm.ResourceVersion), "a converged JWKS must not be rewritten")
		Expect(zoneKsvc(ctx, ns, "orders").Generation).To(Equal(gen))
	})

	It("rotates in the contract order: publish, wait the propagation bound, switch, retire after the overlap", func() {
		ns, _ := boundZoneFixture(ctx)
		clock := &zoneClock{now: t0}
		r := newKeyedZoneReconciler(clock)
		_, err := reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, _ := getSigningKey(ctx, ns, "orders")
		before, _ := readSigningKeySecret(sec)
		oldKid := before.current.kid

		By("step 1: the request publishes the new key and keeps signing with the old one")
		requestRotation(ctx, ns, "orders", "r1")
		res, err := reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, _ = getSigningKey(ctx, ns, "orders")
		staged, err := readSigningKeySecret(sec)
		Expect(err).NotTo(HaveOccurred())
		Expect(staged.current.kid).To(Equal(oldKid), "signing must not switch at publish time")
		Expect(staged.next).NotTo(BeNil())
		newKid := staged.next.kid
		cm, _ := getJWKS(ctx, ns, "orders")
		Expect(jwksKids(cm)).To(ConsistOf(oldKid, newKid))
		Expect(res.RequeueAfter).To(BeNumerically(">", 0))
		Expect(res.RequeueAfter).To(BeNumerically("<=", DefaultZoneKeyPropagationBound+zoneKeyRequeueSlack))
		Expect(zoneKeyCondition(ctx, ns, "orders").Reason).To(Equal(ReasonSigningKeyRotationPropagating))

		By("step 2: 1 ns before the bound, signing still has not switched")
		clock.Advance(DefaultZoneKeyPropagationBound - time.Nanosecond)
		_, err = reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, _ = getSigningKey(ctx, ns, "orders")
		mid, _ := readSigningKeySecret(sec)
		Expect(mid.current.kid).To(Equal(oldKid), "switching before the propagation bound breaks warm verifiers")

		By("step 3: at the bound, current becomes the new key and previous the old one")
		clock.Advance(time.Nanosecond)
		_, err = reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, _ = getSigningKey(ctx, ns, "orders")
		switched, _ := readSigningKeySecret(sec)
		Expect(switched.current.kid).To(Equal(newKid))
		Expect(switched.previous).NotTo(BeNil())
		Expect(switched.previous.kid).To(Equal(oldKid))
		Expect(switched.next).To(BeNil())
		cm, _ = getJWKS(ctx, ns, "orders")
		Expect(jwksKids(cm)).To(ConsistOf(oldKid, newKid), "the old key stays published through the overlap")
		Expect(zoneKeyCondition(ctx, ns, "orders").Reason).To(Equal(ReasonSigningKeyRotationOverlap))

		By("step 4: the old key is retired from both objects only after the 1 h overlap")
		clock.Advance(ZoneKeyOverlap - time.Nanosecond)
		_, err = reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, _ = getSigningKey(ctx, ns, "orders")
		still, _ := readSigningKeySecret(sec)
		Expect(still.previous).NotTo(BeNil(), "retired before the overlap ended")
		clock.Advance(time.Nanosecond)
		_, err = reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, _ = getSigningKey(ctx, ns, "orders")
		done, _ := readSigningKeySecret(sec)
		Expect(done.previous).To(BeNil())
		Expect(done.current.kid).To(Equal(newKid))
		Expect(sec.Data).NotTo(HaveKey(signingKeyPreviousKey))
		cm, _ = getJWKS(ctx, ns, "orders")
		Expect(jwksKids(cm)).To(ConsistOf(newKid))
		Expect(zoneKeyCondition(ctx, ns, "orders").Reason).To(Equal(ReasonSigningKeyActive))

		By("the same nonce does not rotate again")
		_, err = reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, _ = getSigningKey(ctx, ns, "orders")
		after, _ := readSigningKeySecret(sec)
		Expect(after.next).To(BeNil())
		Expect(after.current.kid).To(Equal(newKid))
	})

	// Crash resume: each intermediate state the store can be left in by a crash
	// between two writes is constructed directly, then one reconcile must take
	// the correct next step and never an unsafe one.
	Describe("resumes after a crash at each step", func() {
		stage := func(ns string, mutate func(sec *corev1.Secret, cm *corev1.ConfigMap)) {
			sec, _ := getSigningKey(ctx, ns, "orders")
			cm, _ := getJWKS(ctx, ns, "orders")
			mutate(sec, cm)
			Expect(k8sClient.Update(ctx, sec)).To(Succeed())
			Expect(k8sClient.Update(ctx, cm)).To(Succeed())
		}
		converged := func(clock *zoneClock) (string, *NextAppReconciler, signingKeySet) {
			ns, _ := boundZoneFixture(ctx)
			r := newKeyedZoneReconciler(clock)
			_, err := reconcileWith(ctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
			sec, _ := getSigningKey(ctx, ns, "orders")
			keys, err := readSigningKeySecret(sec)
			Expect(err).NotTo(HaveOccurred())
			return ns, r, keys
		}

		It("crash after creating the Secret, before the JWKS: the JWKS is created from the Secret", func() {
			clock := &zoneClock{now: t0}
			ns, r, keys := converged(clock)
			cm, _ := getJWKS(ctx, ns, "orders")
			Expect(k8sClient.Delete(ctx, cm)).To(Succeed())
			_, err := reconcileWith(ctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
			cm, ok := getJWKS(ctx, ns, "orders")
			Expect(ok).To(BeTrue())
			Expect(jwksKids(cm)).To(ConsistOf(keys.current.kid))
		})

		It("crash after staging the new key, before publishing it: publishes, stamps, does NOT switch", func() {
			clock := &zoneClock{now: t0}
			ns, r, keys := converged(clock)
			nk, err := newZoneKey(rand.Reader)
			Expect(err).NotTo(HaveOccurred())
			stage(ns, func(sec *corev1.Secret, _ *corev1.ConfigMap) {
				keys.next = &nk
				keys.rotationNonce = "r1"
				keys.applyTo(sec)
			})
			requestRotation(ctx, ns, "orders", "r1")
			clock.Advance(10 * time.Minute) // long after the crash: still no switch without a fresh wait
			_, err = reconcileWith(ctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
			sec, _ := getSigningKey(ctx, ns, "orders")
			got, _ := readSigningKeySecret(sec)
			Expect(got.current.kid).To(Equal(keys.current.kid))
			Expect(got.nextPublishedAt).To(BeTemporally("==", clock.Now()), "the wait starts at the publish this pass made")
			cm, _ := getJWKS(ctx, ns, "orders")
			Expect(jwksKids(cm)).To(ConsistOf(keys.current.kid, nk.kid))
		})

		It("crash after publishing, before stamping the publish time: stamps now and waits a full bound", func() {
			clock := &zoneClock{now: t0}
			ns, r, keys := converged(clock)
			nk, _ := newZoneKey(rand.Reader)
			stage(ns, func(sec *corev1.Secret, cm *corev1.ConfigMap) {
				keys.next = &nk
				keys.rotationNonce = "r1"
				keys.applyTo(sec)
				jwks, _ := buildZoneJWKS(keys.current.pub, nk.pub)
				cm.Data[ZoneJWKSFileName] = string(jwks)
			})
			requestRotation(ctx, ns, "orders", "r1")
			clock.Advance(time.Hour)
			_, err := reconcileWith(ctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
			sec, _ := getSigningKey(ctx, ns, "orders")
			got, _ := readSigningKeySecret(sec)
			Expect(got.current.kid).To(Equal(keys.current.kid), "an unstamped publish never licenses a switch")
			Expect(got.nextPublishedAt).To(BeTemporally("==", clock.Now()))
		})

		It("crash during the wait (stamped): switches only once the bound has passed", func() {
			clock := &zoneClock{now: t0}
			ns, r, keys := converged(clock)
			nk, _ := newZoneKey(rand.Reader)
			stage(ns, func(sec *corev1.Secret, cm *corev1.ConfigMap) {
				keys.next = &nk
				keys.rotationNonce = "r1"
				keys.nextPublishedAt = clock.Now()
				keys.applyTo(sec)
				jwks, _ := buildZoneJWKS(keys.current.pub, nk.pub)
				cm.Data[ZoneJWKSFileName] = string(jwks)
			})
			requestRotation(ctx, ns, "orders", "r1")
			clock.Advance(DefaultZoneKeyPropagationBound - time.Second)
			_, err := reconcileWith(ctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
			sec, _ := getSigningKey(ctx, ns, "orders")
			got, _ := readSigningKeySecret(sec)
			Expect(got.current.kid).To(Equal(keys.current.kid))
			clock.Advance(time.Second)
			_, err = reconcileWith(ctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
			sec, _ = getSigningKey(ctx, ns, "orders")
			got, _ = readSigningKeySecret(sec)
			Expect(got.current.kid).To(Equal(nk.kid))
			Expect(got.previous.kid).To(Equal(keys.current.kid))
		})

		It("crash after switching, before stamping the switch (an older Secret): stamps now and keeps the old key a full overlap", func() {
			clock := &zoneClock{now: t0}
			ns, r, keys := converged(clock)
			nk, _ := newZoneKey(rand.Reader)
			stage(ns, func(sec *corev1.Secret, cm *corev1.ConfigMap) {
				old := *keys.current
				keys.current, keys.previous = &nk, &old
				keys.applyTo(sec)
				delete(sec.Annotations, annSigningKeySwitchedAt)
				jwks, _ := buildZoneJWKS(old.pub, nk.pub)
				cm.Data[ZoneJWKSFileName] = string(jwks)
			})
			clock.Advance(3 * time.Hour)
			_, err := reconcileWith(ctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
			sec, _ := getSigningKey(ctx, ns, "orders")
			got, _ := readSigningKeySecret(sec)
			Expect(got.previous).NotTo(BeNil(), "an unstamped switch never licenses a retire")
			Expect(got.switchedAt).To(BeTemporally("==", clock.Now()))
		})

		It("crash after retiring from the Secret, before the JWKS: the JWKS drops the old key", func() {
			clock := &zoneClock{now: t0}
			ns, r, keys := converged(clock)
			old, _ := newZoneKey(rand.Reader)
			stage(ns, func(_ *corev1.Secret, cm *corev1.ConfigMap) {
				jwks, _ := buildZoneJWKS(old.pub, keys.current.pub)
				cm.Data[ZoneJWKSFileName] = string(jwks)
			})
			_, err := reconcileWith(ctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
			cm, _ := getJWKS(ctx, ns, "orders")
			Expect(jwksKids(cm)).To(ConsistOf(keys.current.kid))
		})
	})

	It("leaves a Secret it does not control untouched, publishes nothing, and reports the conflict", func() {
		ns := bsNamespace(ctx)
		squatter := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: ZoneSigningKeySecretName("orders"), Namespace: ns},
			Data:       map[string][]byte{"current.key": []byte("not ours")},
		}
		Expect(k8sClient.Create(ctx, squatter)).To(Succeed())
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders")
		r := newKeyedZoneReconciler(&zoneClock{now: t0})
		res, err := reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, _ := getSigningKey(ctx, ns, "orders")
		Expect(sec.ResourceVersion).To(Equal(squatter.ResourceVersion), "a foreign Secret is never written")
		Expect(metav1.GetControllerOf(sec)).To(BeNil())
		_, ok := getJWKS(ctx, ns, "orders")
		Expect(ok).To(BeFalse(), "nothing is published from a Secret the operator does not control")
		c := zoneKeyCondition(ctx, ns, "orders")
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonSigningKeySecretConflict))
		Expect(res.RequeueAfter).To(BeNumerically(">", 0))
		Expect(res.RequeueAfter).To(BeNumerically("<=", zoneKeyProblemRecheck))
	})

	It("leaves a JWKS ConfigMap it does not control untouched and reports the conflict", func() {
		ns := bsNamespace(ctx)
		squatter := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: ZoneJWKSConfigMapName("orders"), Namespace: ns},
			Data:       map[string]string{ZoneJWKSFileName: `{"keys":[]}`},
		}
		Expect(k8sClient.Create(ctx, squatter)).To(Succeed())
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders")
		r := newKeyedZoneReconciler(&zoneClock{now: t0})
		_, err := reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		cm, _ := getJWKS(ctx, ns, "orders")
		Expect(cm.ResourceVersion).To(Equal(squatter.ResourceVersion))
		c := zoneKeyCondition(ctx, ns, "orders")
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonJWKSConfigMapConflict))
	})

	It("never mounts the zone's key into a function pod, even one that references it", func() {
		ns, _ := boundZoneFixture(ctx)
		r := newKeyedZoneReconciler(&zoneClock{now: t0})
		_, err := reconcileWith(ctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		sec, ok := getSigningKey(ctx, ns, "orders")
		Expect(ok).To(BeTrue())
		Expect(metav1.GetControllerOf(sec)).NotTo(BeNil(), "the key carries the zone's ownerReference, the very mark the allowlist accepts")

		By("the bound function's own pod carries the JWKS, never a key")
		reconcileFunction(ctx, ns, "pricing")
		fn := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, fn)).To(Succeed())
		for _, v := range fn.Spec.Template.Spec.Volumes {
			Expect(v.Secret).To(BeNil(), "a function pod mounts no zone Secret: %+v", v)
		}
		fnEnv := map[string]string{}
		for _, e := range fn.Spec.Template.Spec.Containers[0].Env {
			fnEnv[e.Name] = e.Value
		}
		Expect(fnEnv).To(HaveKeyWithValue(FunctionTokenIssuerEnv, "knext:zone:"+ns+"/orders"))
		Expect(fnEnv).To(HaveKeyWithValue(FunctionTokenAudienceEnv, "knext:fn:"+ns+"/pricing"))

		By("a function in the same zone that names the key is refused and renders nothing")
		createFunction(ctx, ns, "thief", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Volumes = []appsv1alpha1.FunctionVolume{{
				Name: "k", MountPath: "/keys",
				Secret: &corev1.SecretVolumeSource{SecretName: ZoneSigningKeySecretName("orders")},
			}}
		})
		app := zoneApp(ctx, ns, "orders")
		app.Spec.Backends = append(app.Spec.Backends, appsv1alpha1.BackendBinding{Name: "thief", Service: "thief"})
		Expect(k8sClient.Update(ctx, app)).To(Succeed())
		reconcileFunction(ctx, ns, "thief")
		expectNothingRendered(ctx, ns, "thief")
		c := functionCondition(getFunction(ctx, ns, "thief"), ConditionSovereigntyCompliant)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Message).To(ContainSubstring("signing key"))
	})

	It("rejects a function env name in the operator's KNEXT_TOKEN_ namespace at admission", func() {
		ns := bsNamespace(ctx)
		bs := &appsv1alpha1.BackendService{
			ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: ns},
			Spec: appsv1alpha1.BackendServiceSpec{
				Zone: "orders", Image: bsImage, ProtoVersion: "1.0.0",
				Env: []corev1.EnvVar{{Name: FunctionTokenAudienceEnv, Value: "knext:fn:" + ns + "/other"}},
			},
		}
		err := k8sClient.Create(ctx, bs)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("KNEXT_TOKEN_"))
	})

	It("never writes private key material into events, logs, status or a returned error", func() {
		ns, _ := boundZoneFixture(ctx)
		var logBuf bytes.Buffer
		var logMu sync.Mutex
		logger := funcr.New(func(prefix, args string) {
			logMu.Lock()
			defer logMu.Unlock()
			fmt.Fprintln(&logBuf, prefix, args)
		}, funcr.Options{Verbosity: 10})
		lctx := logf.IntoContext(ctx, logger)
		recorder := record.NewFakeRecorder(1024)
		clock := &zoneClock{now: t0}
		r := newKeyedZoneReconciler(clock)
		r.Recorder = recorder

		By("a full rotation on the happy path")
		_, err := reconcileWith(lctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		requestRotation(ctx, ns, "orders", "leak-check")
		for _, step := range []time.Duration{0, DefaultZoneKeyPropagationBound, ZoneKeyOverlap} {
			clock.Advance(step)
			_, err := reconcileWith(lctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
		}

		By("a write the apiserver refuses with an error that echoes the object (an echoing admission webhook)")
		echo := &echoingSecretClient{Client: k8sClient}
		r.Client = echo
		requestRotation(ctx, ns, "orders", "leak-check-2")
		_, err = reconcileWith(lctx, r, ns, "orders")
		Expect(err).To(HaveOccurred(), "the injected refusal must surface")
		Expect(echo.seen).NotTo(BeEmpty(), "the echoing client never saw a Secret write; the proof is vacuous")

		sec, _ := getSigningKey(ctx, ns, "orders")
		var markers []string
		for _, s := range append(echo.seen, sec) {
			keys, _ := readSigningKeySecretLenient(s)
			for _, k := range keys {
				markers = append(markers, keyLeakMarkers(*k)...)
			}
		}
		Expect(markers).NotTo(BeEmpty())
		markers = append(markers, "BEGIN PRIVATE KEY", base64.StdEncoding.EncodeToString([]byte("-----BEGIN PRIVATE KEY")))

		close(recorder.Events)
		var events []string
		for e := range recorder.Events {
			events = append(events, e)
		}
		Expect(events).NotTo(BeEmpty())
		statusJSON, _ := json.Marshal(zoneApp(ctx, ns, "orders").Status)
		logMu.Lock()
		logs := logBuf.String()
		logMu.Unlock()
		Expect(logs).NotTo(BeEmpty())
		for _, m := range markers {
			for _, e := range events {
				Expect(strings.Contains(e, m)).To(BeFalse(), "an event carries key material: %.40s", e)
			}
			Expect(strings.Contains(err.Error(), m)).To(BeFalse(), "the returned error carries key material")
			Expect(strings.Contains(logs, m)).To(BeFalse(), "the logs carry key material")
			Expect(strings.Contains(string(statusJSON), m)).To(BeFalse(), "the status carries key material")
		}
	})

	It("never leaks the retired key when a RetirePrevious write fails with an error echoing the OLD object", func() {
		ns, _ := boundZoneFixture(ctx)
		var logBuf bytes.Buffer
		var logMu sync.Mutex
		logger := funcr.New(func(prefix, args string) {
			logMu.Lock()
			defer logMu.Unlock()
			fmt.Fprintln(&logBuf, prefix, args)
		}, funcr.Options{Verbosity: 10})
		lctx := logf.IntoContext(ctx, logger)
		recorder := record.NewFakeRecorder(1024)
		clock := &zoneClock{now: t0}
		r := newKeyedZoneReconciler(clock)
		r.Recorder = recorder

		By("rotating up to the overlap, so the Secret holds a previous key")
		_, err := reconcileWith(lctx, r, ns, "orders")
		Expect(err).NotTo(HaveOccurred())
		requestRotation(ctx, ns, "orders", "old-echo")
		for _, step := range []time.Duration{0, DefaultZoneKeyPropagationBound} {
			clock.Advance(step)
			_, err := reconcileWith(lctx, r, ns, "orders")
			Expect(err).NotTo(HaveOccurred())
		}
		sec, _ := getSigningKey(ctx, ns, "orders")
		Expect(sec.Data).To(HaveKey(signingKeyPreviousKey), "setup: the zone must be in its overlap")

		By("the RetirePrevious write is refused by a webhook that echoes the stored oldObject (base64 data)")
		echo := &oldObjectEchoingSecretClient{Client: k8sClient}
		r.Client = echo
		clock.Advance(ZoneKeyOverlap)
		_, err = reconcileWith(lctx, r, ns, "orders")
		Expect(err).To(HaveOccurred(), "the injected refusal must surface")
		Expect(err.Error()).To(ContainSubstring(string(zkRetirePrevious)), "the refused write must be the retire")
		Expect(echo.old).NotTo(BeEmpty(), "the echoing client never saw a Secret write; the proof is vacuous")

		var markers []string
		for _, s := range echo.old {
			Expect(s.Data).To(HaveKey(signingKeyPreviousKey), "the echoed old object must carry the retired key")
			keys, _ := readSigningKeySecretLenient(s)
			Expect(keys).To(HaveLen(2))
			for _, k := range keys {
				markers = append(markers, keyLeakMarkers(*k)...)
			}
		}

		close(recorder.Events)
		var events []string
		for e := range recorder.Events {
			events = append(events, e)
		}
		statusJSON, _ := json.Marshal(zoneApp(ctx, ns, "orders").Status)
		logMu.Lock()
		logs := logBuf.String()
		logMu.Unlock()
		for _, m := range markers {
			for _, e := range events {
				Expect(strings.Contains(e, m)).To(BeFalse(), "an event carries key material: %.40s", e)
			}
			Expect(strings.Contains(err.Error(), m)).To(BeFalse(), "the returned error carries key material")
			Expect(strings.Contains(logs, m)).To(BeFalse(), "the logs carry key material")
			Expect(strings.Contains(string(statusJSON), m)).To(BeFalse(), "the status carries key material")
		}
	})
})

// oldObjectEchoingSecretClient fails every Secret update with an error that
// embeds the object as STORED (an admission webhook quoting oldObject), whose
// data marshals as base64, and records what it echoed.
type oldObjectEchoingSecretClient struct {
	client.Client
	old []*corev1.Secret
}

func (c *oldObjectEchoingSecretClient) Update(ctx context.Context, obj client.Object, opts ...client.UpdateOption) error {
	if _, ok := obj.(*corev1.Secret); !ok {
		return c.Client.Update(ctx, obj, opts...)
	}
	stored := &corev1.Secret{}
	if err := c.Client.Get(ctx, client.ObjectKeyFromObject(obj), stored); err != nil {
		return err
	}
	c.old = append(c.old, stored)
	raw, _ := json.Marshal(stored)
	return fmt.Errorf("admission webhook \"echo-old\" denied the request: oldObject=%s", raw)
}

// echoingSecretClient fails every Secret write with an error that embeds the
// whole object, the way an echoing admission webhook would, and records what it
// was asked to write.
type echoingSecretClient struct {
	client.Client
	seen []*corev1.Secret
}

func (c *echoingSecretClient) refuse(obj client.Object) error {
	s, ok := obj.(*corev1.Secret)
	if !ok {
		return nil
	}
	c.seen = append(c.seen, s.DeepCopy())
	raw, _ := json.Marshal(s)
	return fmt.Errorf("admission webhook \"echo\" denied the request: %s (current: %s)", raw, s.Data[signingKeyNextKey])
}

func (c *echoingSecretClient) Create(ctx context.Context, obj client.Object, opts ...client.CreateOption) error {
	if err := c.refuse(obj); err != nil {
		return err
	}
	return c.Client.Create(ctx, obj, opts...)
}

func (c *echoingSecretClient) Update(ctx context.Context, obj client.Object, opts ...client.UpdateOption) error {
	if err := c.refuse(obj); err != nil {
		return err
	}
	return c.Client.Update(ctx, obj, opts...)
}

// readSigningKeySecretLenient returns every parseable key slot, for leak
// markers; it never fails.
func readSigningKeySecretLenient(s *corev1.Secret) ([]*zoneKey, error) {
	var out []*zoneKey
	for _, slot := range [][2]string{
		{signingKeyCurrentKey, signingKeyCurrentKid},
		{signingKeyNextKey, signingKeyNextKid},
		{signingKeyPreviousKey, signingKeyPreviousKid},
	} {
		if k, err := parseZoneKey(s.Data[slot[0]], string(s.Data[slot[1]])); err == nil {
			kk := k
			out = append(out, &kk)
		}
	}
	return out, nil
}
