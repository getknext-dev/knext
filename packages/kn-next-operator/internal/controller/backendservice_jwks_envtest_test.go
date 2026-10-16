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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// A function mounts its zone's JWKS ConfigMap only when the zone's NextApp
// controls it. Each It here is one state of the ConfigMap at the zone's
// reserved name; each is mutation-proved (scripts/mutation-prove-2052-backendservice.mjs).

// jwksSpecConfigMap creates the ConfigMap at the zone's JWKS name with the given
// ownerReferences (none = a squatter that owns nothing).
func jwksSpecConfigMap(ctx context.Context, ns, zone string, refs ...metav1.OwnerReference) *corev1.ConfigMap {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name: ZoneJWKSConfigMapName(zone), Namespace: ns, OwnerReferences: refs,
		},
		Data: map[string]string{ZoneJWKSFileName: `{"keys":[]}`},
	}
	Expect(k8sClient.Create(ctx, cm)).To(Succeed())
	DeferCleanup(func(ctx context.Context) {
		_ = k8sClient.Delete(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: cm.Name, Namespace: ns}})
	})
	return cm
}

func controllerRefTo(app *appsv1alpha1.NextApp) metav1.OwnerReference {
	return metav1.OwnerReference{
		APIVersion: appsv1alpha1.GroupVersion.String(), Kind: "NextApp", Name: app.Name, UID: app.UID,
		Controller: ptr.To(true), BlockOwnerDeletion: ptr.To(true),
	}
}

// functionJWKSVolume returns the rendered Knative Service's JWKS volume and
// mount (nil when absent).
func functionJWKSVolume(ctx context.Context, ns, name string) (*corev1.Volume, *corev1.VolumeMount) {
	ksvc := &servingv1.Service{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, ksvc)).To(Succeed())
	var vol *corev1.Volume
	for i := range ksvc.Spec.Template.Spec.Volumes {
		if ksvc.Spec.Template.Spec.Volumes[i].Name == FunctionJWKSVolumeName {
			vol = &ksvc.Spec.Template.Spec.Volumes[i]
		}
	}
	var mount *corev1.VolumeMount
	for i := range ksvc.Spec.Template.Spec.Containers[0].VolumeMounts {
		if ksvc.Spec.Template.Spec.Containers[0].VolumeMounts[i].Name == FunctionJWKSVolumeName {
			mount = &ksvc.Spec.Template.Spec.Containers[0].VolumeMounts[i]
		}
	}
	return vol, mount
}

func expectJWKSMounted(ctx context.Context, ns, zone, fn string) {
	vol, mount := functionJWKSVolume(ctx, ns, fn)
	ExpectWithOffset(1, vol).NotTo(BeNil(), "the zone's JWKS must be mounted")
	ExpectWithOffset(1, vol.ConfigMap).NotTo(BeNil())
	ExpectWithOffset(1, vol.ConfigMap.Name).To(Equal(ZoneJWKSConfigMapName(zone)))
	ExpectWithOffset(1, ptr.Deref(vol.ConfigMap.Optional, false)).To(BeTrue())
	ExpectWithOffset(1, mount).NotTo(BeNil())
	ExpectWithOffset(1, mount.MountPath).To(Equal(ZoneJWKSMountDir))
}

func expectJWKSNotMounted(ctx context.Context, ns, fn string) {
	vol, mount := functionJWKSVolume(ctx, ns, fn)
	ExpectWithOffset(1, vol).To(BeNil(), "an untrusted JWKS ConfigMap must not be mounted")
	ExpectWithOffset(1, mount).To(BeNil(), "an untrusted JWKS ConfigMap must not be mounted")
}

// cachedConfigMapTrap fails any ConfigMap read through the client it wraps. The
// operator's role has `get` on ConfigMaps and nothing else, so a read through
// the manager's cache would start an informer that needs list and watch: the
// JWKS read must go through the uncached APIReader.
type cachedConfigMapTrap struct{ client.Client }

func (c cachedConfigMapTrap) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	switch o := obj.(type) {
	case *corev1.ConfigMap:
		return errors.New("ConfigMap read through the cached client: it would start an informer (needs list/watch)")
	case *metav1.PartialObjectMetadata:
		if o.Kind == "ConfigMap" {
			return errors.New("ConfigMap metadata read through the cached client: it would start an informer (needs list/watch)")
		}
	}
	return c.Client.Get(ctx, key, obj, opts...)
}

// failingConfigMapReader is an APIReader whose ConfigMap reads fail with a
// non-NotFound error (an apiserver blip, or a missing RBAC grant).
type failingConfigMapReader struct{ client.Reader }

func (f failingConfigMapReader) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if o, ok := obj.(*metav1.PartialObjectMetadata); ok && o.Kind == "ConfigMap" {
		return errors.New("simulated apiserver failure")
	}
	return f.Reader.Get(ctx, key, obj, opts...)
}

var _ = Describe("BackendService reconciler: the zone's JWKS is mounted only when the zone controls it", func() {
	ctx := context.Background()

	setup := func() (ns string, zone *appsv1alpha1.NextApp) {
		ns = bsNamespace(ctx)
		zone = createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders")
		return ns, zone
	}

	It("mounts the JWKS of a ConfigMap the zone's NextApp controls", func() {
		ns, zone := setup()
		jwksSpecConfigMap(ctx, ns, "orders", controllerRefTo(zone))
		reconcileFunction(ctx, ns, "pricing")

		expectJWKSMounted(ctx, ns, "orders", "pricing")
		c := functionCondition(getFunction(ctx, ns, "pricing"), ConditionJWKSTrusted)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionTrue))
		Expect(c.Reason).To(Equal(ReasonJWKSControlled))
	})

	It("keeps the optional mount while the ConfigMap does not exist yet (the operator creates it)", func() {
		ns, _ := setup()
		reconcileFunction(ctx, ns, "pricing")

		expectJWKSMounted(ctx, ns, "orders", "pricing")
		bs := getFunction(ctx, ns, "pricing")
		c := functionCondition(bs, ConditionJWKSTrusted)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionUnknown))
		Expect(c.Reason).To(Equal(ReasonJWKSNotPublished))
		Expect(functionCondition(bs, ConditionReady).Reason).NotTo(Equal(ReasonJWKSUntrusted),
			"an absent JWKS is the normal first state, not a refusal")
	})

	untrusted := func(name string, owners func(zone *appsv1alpha1.NextApp, ns string) []metav1.OwnerReference, wantDetail string) {
		It(name, func() {
			ns, zone := setup()
			squatter := jwksSpecConfigMap(ctx, ns, "orders", owners(zone, ns)...)
			r := newBSReconciler()
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
			Expect(err).NotTo(HaveOccurred())

			By("the function renders (health works) but without any JWKS volume or mount")
			Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
			expectJWKSNotMounted(ctx, ns, "pricing")

			By("an honest condition names the ConfigMap and why it is not trusted")
			bs := getFunction(ctx, ns, "pricing")
			c := functionCondition(bs, ConditionJWKSTrusted)
			Expect(c).NotTo(BeNil())
			Expect(c.Status).To(Equal(metav1.ConditionFalse))
			Expect(c.Reason).To(Equal(ReasonJWKSUntrusted))
			Expect(c.Message).To(ContainSubstring(ZoneJWKSConfigMapName("orders")))
			Expect(c.Message).To(ContainSubstring(wantDetail))
			ready := functionCondition(bs, ConditionReady)
			Expect(ready.Status).To(Equal(metav1.ConditionFalse))
			Expect(ready.Reason).To(Equal(ReasonJWKSUntrusted))

			By("one Warning event, and none on the next pass")
			events := drainEvents(r.Recorder.(*record.FakeRecorder))
			var warnings []string
			for _, e := range events {
				if strings.Contains(e, ReasonJWKSUntrusted) {
					warnings = append(warnings, e)
				}
			}
			Expect(warnings).To(HaveLen(1))
			Expect(warnings[0]).To(HavePrefix("Warning "))
			_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
			Expect(err).NotTo(HaveOccurred())
			Expect(drainEvents(r.Recorder.(*record.FakeRecorder))).To(BeEmpty())

			By("the operator never touches the object it refuses to mount")
			after := &corev1.ConfigMap{}
			Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(squatter), after)).To(Succeed())
			Expect(after.ResourceVersion).To(Equal(squatter.ResourceVersion))
		})
	}

	untrusted("does not mount a squatted ConfigMap that nothing owns", func(*appsv1alpha1.NextApp, string) []metav1.OwnerReference {
		return nil
	}, "no controller ownerReference")

	untrusted("does not mount a ConfigMap controlled by some other object", func(_ *appsv1alpha1.NextApp, _ string) []metav1.OwnerReference {
		return []metav1.OwnerReference{{
			APIVersion: "v1", Kind: "ConfigMap", Name: "elsewhere", UID: "uid-elsewhere", Controller: ptr.To(true),
		}}
	}, `ConfigMap "elsewhere"`)

	untrusted("does not mount a ConfigMap controlled by another zone's NextApp", func(_ *appsv1alpha1.NextApp, ns string) []metav1.OwnerReference {
		other := createZone(ctx, ns, "billing")
		return []metav1.OwnerReference{controllerRefTo(other)}
	}, `NextApp "billing"`)

	untrusted("does not mount a ConfigMap controlled by a NextApp of the same name but another UID", func(zone *appsv1alpha1.NextApp, _ string) []metav1.OwnerReference {
		ref := controllerRefTo(zone)
		ref.UID = "uid-an-earlier-orders"
		return []metav1.OwnerReference{ref}
	}, "different UID")

	It("stops mounting a ConfigMap that a squatter replaced, and mounts again once it is gone", func() {
		ns, zone := setup()
		legit := jwksSpecConfigMap(ctx, ns, "orders", controllerRefTo(zone))
		reconcileFunction(ctx, ns, "pricing")
		expectJWKSMounted(ctx, ns, "orders", "pricing")

		By("the zone's ConfigMap is deleted and a squatter takes the name")
		Expect(k8sClient.Delete(ctx, legit)).To(Succeed())
		squatter := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: ZoneJWKSConfigMapName("orders"), Namespace: ns},
			Data:       map[string]string{ZoneJWKSFileName: `{"keys":[]}`},
		}
		Expect(k8sClient.Create(ctx, squatter)).To(Succeed())
		reconcileFunction(ctx, ns, "pricing")
		expectJWKSNotMounted(ctx, ns, "pricing")
		Expect(functionCondition(getFunction(ctx, ns, "pricing"), ConditionReady).Reason).To(Equal(ReasonJWKSUntrusted))

		By("the squatter is removed: the optional mount returns (the operator will publish)")
		Expect(k8sClient.Delete(ctx, squatter)).To(Succeed())
		reconcileFunction(ctx, ns, "pricing")
		expectJWKSMounted(ctx, ns, "orders", "pricing")
		bs := getFunction(ctx, ns, "pricing")
		Expect(functionCondition(bs, ConditionJWKSTrusted).Reason).To(Equal(ReasonJWKSNotPublished))
		Expect(functionCondition(bs, ConditionReady).Reason).NotTo(Equal(ReasonJWKSUntrusted))
	})

	It("reads the ConfigMap through the uncached reader, never the cache", func() {
		ns, zone := setup()
		jwksSpecConfigMap(ctx, ns, "orders", controllerRefTo(zone))
		r := newBSReconciler()
		r.Client = cachedConfigMapTrap{Client: k8sClient}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
		Expect(err).NotTo(HaveOccurred(), "the JWKS read must use APIReader: the role has no ConfigMap list/watch")
		expectJWKSMounted(ctx, ns, "orders", "pricing")
	})

	It("on a read failure returns the error and leaves what was rendered untouched (it learned nothing about ownership)", func() {
		ns, zone := setup()
		jwksSpecConfigMap(ctx, ns, "orders", controllerRefTo(zone))
		reconcileFunction(ctx, ns, "pricing")
		expectJWKSMounted(ctx, ns, "orders", "pricing")

		r := newBSReconciler()
		r.APIReader = failingConfigMapReader{Reader: k8sClient}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("simulated apiserver failure"))
		expectJWKSMounted(ctx, ns, "orders", "pricing")
	})

	It("does not read the ConfigMap, nor render, for a function that is refused", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders") // the zone does not list the function
		createFunction(ctx, ns, "pricing", "orders")
		jwksSpecConfigMap(ctx, ns, "orders")
		r := newBSReconciler()
		r.APIReader = failingConfigMapReader{Reader: k8sClient}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
		Expect(err).NotTo(HaveOccurred(), "a refused function renders nothing, so it has no use for the JWKS")
		expectNothingRendered(ctx, ns, "pricing")
		c := functionCondition(getFunction(ctx, ns, "pricing"), ConditionJWKSTrusted)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionUnknown))
		Expect(c.Reason).To(Equal(ReasonJWKSNotRendered))
	})
})
