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
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"knative.dev/pkg/apis"
	duckv1 "knative.dev/pkg/apis/duck/v1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// BackendService reconciler, end to end against a real apiserver (ADR-0004
// Amendments 1 and 2). One It per rule; every sovereignty rejection has its own
// It per Secret source, and each is mutation-proved
// (scripts/mutation-prove-2052-backendservice.mjs).

const bsImage = "registry.example.com/fn:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

var bsNSCounter atomic.Int64

// bsNamespace creates a fresh namespace so specs cannot see each other's zones
// and functions (envtest never deletes a namespace, so names are unique).
func bsNamespace(ctx context.Context) string {
	ns := fmt.Sprintf("bsvc-%d-%d", time.Now().UnixNano()%100000, bsNSCounter.Add(1))
	Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
	return ns
}

func newBSReconciler() *BackendServiceReconciler {
	return &BackendServiceReconciler{
		Client:    k8sClient,
		Scheme:    k8sClient.Scheme(),
		APIReader: k8sClient,
		Recorder:  record.NewFakeRecorder(256),
	}
}

func newZoneReconciler() *NextAppReconciler {
	return &NextAppReconciler{
		Client:                   k8sClient,
		Scheme:                   k8sClient.Scheme(),
		Recorder:                 record.NewFakeRecorder(256),
		BackendServiceCRDPresent: true,
	}
}

func createZone(ctx context.Context, ns, name string, backends ...appsv1alpha1.BackendBinding) *appsv1alpha1.NextApp {
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: appsv1alpha1.NextAppSpec{
			Image:    validImageForBS(),
			Backends: backends,
			Database: &appsv1alpha1.DatabaseSpec{SecretRef: &appsv1alpha1.DatabaseSecretRef{Name: name + "-db"}},
		},
	}
	Expect(k8sClient.Create(ctx, app)).To(Succeed())
	// Leave nothing behind: a manager-driven spec elsewhere in the suite
	// reconciles every NextApp in the cluster, so leftovers slow it down.
	DeferCleanup(deleteAndFinalize, ctx, client.ObjectKeyFromObject(app))
	return app
}

// deleteFunctionAndFinalize deletes a BackendService and runs its finalizer.
func deleteFunctionAndFinalize(ctx context.Context, nn types.NamespacedName) {
	cur := &appsv1alpha1.BackendService{}
	if err := k8sClient.Get(ctx, nn, cur); err != nil {
		return
	}
	Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
	Eventually(func() bool {
		_, _ = newBSReconciler().Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		return apierrors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.BackendService{}))
	}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
}

func validImageForBS() string {
	return "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
}

func createFunction(ctx context.Context, ns, name, zone string, mut ...func(*appsv1alpha1.BackendService)) *appsv1alpha1.BackendService {
	bs := &appsv1alpha1.BackendService{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: appsv1alpha1.BackendServiceSpec{
			Zone:         zone,
			Image:        bsImage,
			ProtoVersion: "1.0.0",
		},
	}
	for _, m := range mut {
		m(bs)
	}
	Expect(k8sClient.Create(ctx, bs)).To(Succeed())
	DeferCleanup(deleteFunctionAndFinalize, ctx, client.ObjectKeyFromObject(bs))
	return bs
}

func reconcileFunction(ctx context.Context, ns, name string) {
	_, err := newBSReconciler().Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: name}})
	Expect(err).NotTo(HaveOccurred())
}

func getFunction(ctx context.Context, ns, name string) *appsv1alpha1.BackendService {
	bs := &appsv1alpha1.BackendService{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, bs)).To(Succeed())
	return bs
}

func functionKsvcExists(ctx context.Context, ns, name string) bool {
	err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &servingv1.Service{})
	if apierrors.IsNotFound(err) {
		return false
	}
	Expect(err).NotTo(HaveOccurred())
	return true
}

func functionCondition(bs *appsv1alpha1.BackendService, t string) *metav1.Condition {
	return apimeta.FindStatusCondition(bs.Status.Conditions, t)
}

func expectNothingRendered(ctx context.Context, ns, name string) {
	Expect(functionKsvcExists(ctx, ns, name)).To(BeFalse(), "a refused function must render no Knative Service")
	err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: FunctionNetworkPolicyName(name)}, &networkingv1.NetworkPolicy{})
	Expect(apierrors.IsNotFound(err)).To(BeTrue(), "a refused function must render no NetworkPolicy")
}

var _ = Describe("BackendService reconciler: zone resolution and the two-sided binding", func() {
	ctx := context.Background()

	It("refuses a function whose zone does not exist: Bound=False/ZoneNotFound, nothing rendered", func() {
		ns := bsNamespace(ctx)
		createFunction(ctx, ns, "pricing", "missing-zone")
		reconcileFunction(ctx, ns, "pricing")

		bs := getFunction(ctx, ns, "pricing")
		c := functionCondition(bs, ConditionFunctionBound)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonZoneNotFound))
		Expect(c.Message).To(ContainSubstring(`"missing-zone"`))
		Expect(metav1.GetControllerOf(bs)).To(BeNil())
		expectNothingRendered(ctx, ns, "pricing")
		Expect(functionCondition(bs, ConditionReady).Status).To(Equal(metav1.ConditionFalse))
	})

	It("sets the controller ownerReference itself, with blockOwnerDeletion, from spec.zone", func() {
		ns := bsNamespace(ctx)
		zone := createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders")
		reconcileFunction(ctx, ns, "pricing")

		ref := metav1.GetControllerOf(getFunction(ctx, ns, "pricing"))
		Expect(ref).NotTo(BeNil())
		Expect(ref.Kind).To(Equal("NextApp"))
		Expect(ref.Name).To(Equal("orders"))
		Expect(ref.UID).To(Equal(zone.UID))
		Expect(ptr.Deref(ref.BlockOwnerDeletion, false)).To(BeTrue())
	})

	It("refuses a one-sided binding from the function side: the zone does not list it, nothing rendered or mounted", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders") // no spec.backends: the zone has not consented
		createFunction(ctx, ns, "pricing", "orders")
		reconcileFunction(ctx, ns, "pricing")

		bs := getFunction(ctx, ns, "pricing")
		c := functionCondition(bs, ConditionFunctionBound)
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonZoneNotListed))
		Expect(c.Message).To(ContainSubstring("spec.backends"))
		expectNothingRendered(ctx, ns, "pricing")
		Expect(bs.Status.URL).To(BeEmpty())
	})

	It("never overwrites a conflicting controller ownerReference", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		other := createZone(ctx, ns, "billing")
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.OwnerReferences = []metav1.OwnerReference{{
				APIVersion: appsv1alpha1.GroupVersion.String(), Kind: "NextApp", Name: other.Name, UID: other.UID,
				Controller: ptr.To(true),
			}}
		})
		reconcileFunction(ctx, ns, "pricing")

		bs := getFunction(ctx, ns, "pricing")
		Expect(metav1.GetControllerOf(bs).Name).To(Equal("billing"), "the operator must not overwrite it")
		Expect(functionCondition(bs, ConditionFunctionBound).Reason).To(Equal(ReasonConflictingOwner))
		expectNothingRendered(ctx, ns, "pricing")
	})

	It("renders a cluster-local h2c Knative Service, an operator-owned ServiceAccount and the function NetworkPolicy for a two-sided binding", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Port = 9000
		})
		reconcileFunction(ctx, ns, "pricing")

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, ksvc)).To(Succeed())
		Expect(ksvc.Labels["networking.knative.dev/visibility"]).To(Equal("cluster-local"))
		Expect(ksvc.Labels[ZoneLabel]).To(Equal("orders"))
		Expect(metav1.GetControllerOf(ksvc).Kind).To(Equal("BackendService"))
		Expect(ksvc.Spec.Template.Annotations[ProtoVersionAnnotation]).To(Equal("1.0.0"))

		spec := ksvc.Spec.Template.Spec
		Expect(spec.Containers).To(HaveLen(1))
		Expect(spec.Containers[0].Ports).To(ConsistOf(corev1.ContainerPort{Name: "h2c", ContainerPort: 9000}))

		By("the pod runs as the operator-owned ServiceAccount, automount off, with no Role or RoleBinding")
		Expect(spec.ServiceAccountName).To(Equal(FunctionServiceAccountName("pricing")))
		sa := &corev1.ServiceAccount{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: FunctionServiceAccountName("pricing")}, sa)).To(Succeed())
		Expect(ptr.Deref(sa.AutomountServiceAccountToken, true)).To(BeFalse())
		Expect(metav1.GetControllerOf(sa).Kind).To(Equal("BackendService"))
		Expect(ptr.Deref(spec.AutomountServiceAccountToken, true)).To(BeFalse())

		By("the owning zone's JWKS is mounted as an optional directory volume, never a subPath")
		var jwks *corev1.Volume
		for i := range spec.Volumes {
			if spec.Volumes[i].Name == FunctionJWKSVolumeName {
				jwks = &spec.Volumes[i]
			}
		}
		Expect(jwks).NotTo(BeNil())
		Expect(jwks.ConfigMap).NotTo(BeNil())
		Expect(jwks.ConfigMap.Name).To(Equal(ZoneJWKSConfigMapName("orders")))
		Expect(ptr.Deref(jwks.ConfigMap.Optional, false)).To(BeTrue())
		var mount *corev1.VolumeMount
		for i := range spec.Containers[0].VolumeMounts {
			if spec.Containers[0].VolumeMounts[i].Name == FunctionJWKSVolumeName {
				mount = &spec.Containers[0].VolumeMounts[i]
			}
		}
		Expect(mount).NotTo(BeNil())
		Expect(mount.MountPath).To(Equal(ZoneJWKSMountDir))
		Expect(mount.SubPath).To(BeEmpty())
		Expect(mount.ReadOnly).To(BeTrue())

		By("the NetworkPolicy admits only pod-scoped activator, Kourier gateway, and autoscaler peers, not the user port")
		np := &networkingv1.NetworkPolicy{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: FunctionNetworkPolicyName("pricing")}, np)).To(Succeed())
		Expect(np.Spec.PodSelector.MatchLabels).To(HaveKeyWithValue("serving.knative.dev/service", "pricing"))
		Expect(np.Spec.Ingress).To(HaveLen(2))
		Expect(np.Spec.Ingress[0].From).To(ConsistOf(append([]networkingv1.NetworkPolicyPeer{activatorPeer()}, kourierGatewayPeers()...)))
		Expect(np.Spec.Ingress[1].From).To(ConsistOf(autoscalerPeer()))
		for _, rule := range np.Spec.Ingress {
			for _, p := range rule.Ports {
				Expect(p.Port.IntValue()).NotTo(Equal(9000), "the user port stays out of the allowlist")
			}
		}

		bs := getFunction(ctx, ns, "pricing")
		Expect(functionCondition(bs, ConditionFunctionBound).Status).To(Equal(metav1.ConditionTrue))
		Expect(functionCondition(bs, ConditionSovereigntyCompliant).Status).To(Equal(metav1.ConditionTrue))
		Expect(bs.Status.URL).To(Equal("http://pricing." + ns + ".svc.cluster.local"))
		Expect(bs.Status.ServiceAccountName).To(Equal(FunctionServiceAccountName("pricing")))
		Expect(bs.Finalizers).To(ContainElement(BackendServiceFinalizer))
	})

	It("ignores a stray serviceAccountName: the apiserver prunes it and the pod uses the operator-owned ServiceAccount", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		u := &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": appsv1alpha1.GroupVersion.String(),
			"kind":       "BackendService",
			"metadata":   map[string]interface{}{"name": "pricing", "namespace": ns},
			"spec": map[string]interface{}{
				"zone":               "orders",
				"image":              bsImage,
				"serviceAccountName": "secret-reader",
			},
		}}
		Expect(k8sClient.Create(ctx, u)).To(Succeed())
		DeferCleanup(deleteFunctionAndFinalize, ctx, types.NamespacedName{Namespace: ns, Name: "pricing"})
		reconcileFunction(ctx, ns, "pricing")

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, ksvc)).To(Succeed())
		Expect(ksvc.Spec.Template.Spec.ServiceAccountName).To(Equal(FunctionServiceAccountName("pricing")))
		Expect(ksvc.Spec.Template.Spec.ServiceAccountName).NotTo(Equal("secret-reader"))
	})

	It("revokes: removing the zone's backends[] entry deletes the function's Knative Service", func() {
		ns := bsNamespace(ctx)
		zone := createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders")
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())

		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(zone), zone)).To(Succeed())
		zone.Spec.Backends = nil
		Expect(k8sClient.Update(ctx, zone)).To(Succeed())
		reconcileFunction(ctx, ns, "pricing")

		expectNothingRendered(ctx, ns, "pricing")
		bs := getFunction(ctx, ns, "pricing")
		Expect(functionCondition(bs, ConditionFunctionBound).Reason).To(Equal(ReasonZoneNotListed))
		Expect(bs.Status.URL).To(BeEmpty())
		Expect(bs.Status.ServedProtoVersion).To(BeEmpty())
	})

	It("rejects an image that is not pinned by digest", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Image = "registry.example.com/fn:latest"
		})
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionCondition(getFunction(ctx, ns, "pricing"), ConditionReady).Reason).To(Equal(ReasonInvalidImage))
		expectNothingRendered(ctx, ns, "pricing")
	})

	It("keeps a bound function's retention longer than its zone's", func() {
		ns := bsNamespace(ctx)
		zone := createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		zone.Spec.Scaling = &appsv1alpha1.ScalingSpec{MaxScale: 3, ScaleDownDelay: "2m"}
		Expect(k8sClient.Update(ctx, zone)).To(Succeed())
		_, err := newZoneReconciler().Reconcile(ctx, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(zone)})
		Expect(err).NotTo(HaveOccurred())

		createFunction(ctx, ns, "pricing", "orders")
		reconcileFunction(ctx, ns, "pricing")
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, ksvc)).To(Succeed())
		got, err := time.ParseDuration(ksvc.Spec.Template.Annotations[retentionAnnotation])
		Expect(err).NotTo(HaveOccurred())
		Expect(got).To(BeNumerically(">", 2*time.Minute))
	})
})

var _ = Describe("BackendService reconciler: the credential allowlist (one It per Secret source)", func() {
	ctx := context.Background()

	refuse := func(name string, mut func(*appsv1alpha1.BackendService, string), wantSource string) {
		It(name, func() {
			ns := bsNamespace(ctx)
			createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
			// The other zone's database Secret: the most dangerous foreign credential.
			createZone(ctx, ns, "billing")
			createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) { mut(bs, "billing-db") })
			reconcileFunction(ctx, ns, "pricing")

			bs := getFunction(ctx, ns, "pricing")
			c := functionCondition(bs, ConditionSovereigntyCompliant)
			Expect(c).NotTo(BeNil())
			Expect(c.Status).To(Equal(metav1.ConditionFalse))
			Expect(c.Reason).To(Equal(ReasonSecretNotAllowed))
			Expect(c.Message).To(ContainSubstring(wantSource))
			Expect(c.Message).To(ContainSubstring(`"billing-db"`))
			Expect(functionCondition(bs, ConditionReady).Reason).To(Equal(ReasonSovereigntyViolation))
			expectNothingRendered(ctx, ns, "pricing")
		})
	}

	refuse("refuses another zone's database Secret through secretKeyRef", func(bs *appsv1alpha1.BackendService, s string) {
		bs.Spec.Env = specSecretKeyRef(s).Env
	}, "env[DSN].valueFrom.secretKeyRef")
	refuse("refuses another zone's database Secret through envFrom", func(bs *appsv1alpha1.BackendService, s string) {
		bs.Spec.EnvFrom = specEnvFromSecret(s).EnvFrom
	}, "envFrom[0].secretRef")
	refuse("refuses another zone's database Secret through a Secret volume", func(bs *appsv1alpha1.BackendService, s string) {
		bs.Spec.Volumes = specSecretVolume(s).Volumes
	}, "volumes[creds].secret")
	refuse("refuses another zone's database Secret through a projected volume", func(bs *appsv1alpha1.BackendService, s string) {
		bs.Spec.Volumes = specProjectedSecret(s).Volumes
	}, "volumes[bundle].projected.sources[1].secret")

	It("refuses an unmarked Secret (it is neither the zone's database Secret nor marked for the zone)", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "stripe", Namespace: ns}})).To(Succeed())
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.EnvFrom = specEnvFromSecret("stripe").EnvFrom
		})
		reconcileFunction(ctx, ns, "pricing")
		c := functionCondition(getFunction(ctx, ns, "pricing"), ConditionSovereigntyCompliant)
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Message).To(ContainSubstring("not marked for zone"))
		expectNothingRendered(ctx, ns, "pricing")
	})

	It("allows the zone's own database Secret and a Secret labelled for the zone (read through the uncached reader)", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
			Name: "stripe", Namespace: ns, Labels: map[string]string{ZoneLabel: "orders"},
		}})).To(Succeed())
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Env = specSecretKeyRef("orders-db").Env
			bs.Spec.EnvFrom = specEnvFromSecret("stripe").EnvFrom
		})
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionCondition(getFunction(ctx, ns, "pricing"), ConditionSovereigntyCompliant).Status).To(Equal(metav1.ConditionTrue))
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())
	})

	It("deny wins: another zone's database Secret labelled for this zone is still refused", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createZone(ctx, ns, "billing")
		Expect(k8sClient.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
			Name: "billing-db", Namespace: ns, Labels: map[string]string{ZoneLabel: "orders"},
		}})).To(Succeed())
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Volumes = specSecretVolume("billing-db").Volumes
		})
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionCondition(getFunction(ctx, ns, "pricing"), ConditionSovereigntyCompliant).Status).To(Equal(metav1.ConditionFalse))
		expectNothingRendered(ctx, ns, "pricing")
	})

	It("fails closed: a violation added to a rendered function deletes its Knative Service", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createZone(ctx, ns, "billing")
		createFunction(ctx, ns, "pricing", "orders")
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())

		bs := getFunction(ctx, ns, "pricing")
		bs.Spec.EnvFrom = specEnvFromSecret("billing-db").EnvFrom
		Expect(k8sClient.Update(ctx, bs)).To(Succeed())
		reconcileFunction(ctx, ns, "pricing")
		expectNothingRendered(ctx, ns, "pricing")
	})

	It("refuses another zone's JWKS ConfigMap: a function cannot mount a foreign JWKS", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createZone(ctx, ns, "billing")
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Volumes = []appsv1alpha1.FunctionVolume{{
				Name: "keys", MountPath: "/keys",
				ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: ZoneJWKSConfigMapName("billing")}},
			}}
		})
		reconcileFunction(ctx, ns, "pricing")
		c := functionCondition(getFunction(ctx, ns, "pricing"), ConditionSovereigntyCompliant)
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Message).To(ContainSubstring("another zone's JWKS"))
		expectNothingRendered(ctx, ns, "pricing")
	})

	It("rejects a volume mounted under /var/run/knext at admission (reserved for the operator's JWKS mount)", func() {
		ns := bsNamespace(ctx)
		bs := &appsv1alpha1.BackendService{
			ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: ns},
			Spec: appsv1alpha1.BackendServiceSpec{Zone: "orders", Image: bsImage, Volumes: []appsv1alpha1.FunctionVolume{{
				Name: "shadow", MountPath: ZoneJWKSMountDir, EmptyDir: &corev1.EmptyDirVolumeSource{},
			}}},
		}
		err := k8sClient.Create(ctx, bs)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("/var/run/knext is reserved"))
	})

	It("rejects a change of spec.zone at admission (immutable)", func() {
		ns := bsNamespace(ctx)
		bs := createFunction(ctx, ns, "pricing", "orders")
		bs.Spec.Zone = "billing"
		err := k8sClient.Update(ctx, bs)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("spec.zone is immutable"))
	})

	It("reports a foreign database host as a lint WARNING and still renders the function", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createZone(ctx, ns, "billing")
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) {
			bs.Spec.Env = []corev1.EnvVar{{Name: "LEGACY_DSN", Value: "postgres://u@" + cnpgHost("billing-db", "rw", ":5432/app")}}
		})
		reconcileFunction(ctx, ns, "pricing")

		bs := getFunction(ctx, ns, "pricing")
		c := functionCondition(bs, ConditionDatabaseHostLint)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonForeignDatabaseHost))
		Expect(strings.ToLower(c.Message)).To(ContainSubstring("lint"))
		Expect(c.Message).To(ContainSubstring("credential allowlist"))
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue(), "a lint never rejects")
	})
})

var _ = Describe("BackendService reconciler: served proto version and deletion", func() {
	ctx := context.Background()

	It("reports the version stamped on the latest READY revision, not the spec's", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders", func(bs *appsv1alpha1.BackendService) { bs.Spec.ProtoVersion = "1.1.0" })
		reconcileFunction(ctx, ns, "pricing")
		Expect(getFunction(ctx, ns, "pricing").Status.ServedProtoVersion).To(BeEmpty(), "nothing is served before a revision is Ready")

		By("a Ready revision stamped 1.0.0 (the previous rollout) serves while 1.1.0 rolls")
		markFunctionServed(ctx, ns, "pricing", "pricing-00001", "1.0.0")
		reconcileFunction(ctx, ns, "pricing")
		bs := getFunction(ctx, ns, "pricing")
		Expect(bs.Status.ServedProtoVersion).To(Equal("1.0.0"))
		Expect(bs.Status.ObservedRevision).To(Equal("pricing-00001"))
		Expect(functionCondition(bs, ConditionReady).Status).To(Equal(metav1.ConditionTrue))
	})

	It("runs the finalizer on delete: the Knative Service goes, the object is released", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, "orders", appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", "orders")
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeTrue())

		Expect(k8sClient.Delete(ctx, getFunction(ctx, ns, "pricing"))).To(Succeed())
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionKsvcExists(ctx, ns, "pricing")).To(BeFalse())
		err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "pricing"}, &appsv1alpha1.BackendService{})
		Expect(apierrors.IsNotFound(err)).To(BeTrue(), "the finalizer must release the object")
	})
})

// markFunctionServed simulates Knative: a Revision carrying the stamp, and the
// function's Knative Service reporting it as latest-ready with Ready=True.
func markFunctionServed(ctx context.Context, ns, ksvcName, revision, version string) {
	rev := &servingv1.Revision{ObjectMeta: metav1.ObjectMeta{
		Name: revision, Namespace: ns,
		Labels:      map[string]string{"serving.knative.dev/service": ksvcName},
		Annotations: map[string]string{ProtoVersionAnnotation: version},
	}}
	Expect(k8sClient.Create(ctx, rev)).To(Succeed())
	ksvc := &servingv1.Service{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: ksvcName}, ksvc)).To(Succeed())
	ksvc.Status.LatestReadyRevisionName = revision
	ksvc.Status.LatestCreatedRevisionName = revision
	ksvc.Status.ObservedGeneration = ksvc.Generation
	ksvc.Status.Conditions = duckv1.Conditions{{
		Type: apis.ConditionReady, Status: corev1.ConditionTrue,
		LastTransitionTime: apis.VolatileTime{Inner: metav1.Now()},
	}}
	Expect(k8sClient.Status().Update(ctx, ksvc)).To(Succeed())
}
