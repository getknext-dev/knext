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
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// These specs exercise the unified-config delegation end-to-end against a real
// apiserver (envtest) with the scale-zero-pg AppDatabase CRD fixture installed:
// create → AppDatabase provisioned + hard-gate; Ready → mirror + inject; delete →
// cross-ns AppDatabase teardown. The AppDatabase operator is NOT present, so the
// tests drive its status transitions by hand (as scale-zero-pg would).

const testDBNamespace = "scale-zero-pg"

func getAppDatabase(ctx context.Context, name string) (*unstructured.Unstructured, error) {
	u := newAppDatabase(name, testDBNamespace)
	err := k8sClient.Get(ctx, types.NamespacedName{Name: name, Namespace: testDBNamespace}, u)
	return u, err
}

// markAppDatabaseReady simulates the scale-zero-pg appdb operator: sets
// status.phase=Ready and mints the app-db-<app> DSN Secret in scale-zero-pg.
func markAppDatabaseReady(ctx context.Context, appName string, withRO bool) {
	u, err := getAppDatabase(ctx, appName)
	Expect(err).NotTo(HaveOccurred())
	Expect(unstructured.SetNestedField(u.Object, "Ready", "status", "phase")).To(Succeed())
	Expect(unstructured.SetNestedField(u.Object, true, "status", "computeReady")).To(Succeed())
	Expect(k8sClient.Status().Update(ctx, u)).To(Succeed())

	data := map[string][]byte{
		"DATABASE_URL": []byte(fmt.Sprintf("postgres://app_%s:pw@pggw-apps.scale-zero-pg.svc:55432/%s?sslmode=disable", appName, appName)),
		"PGUSER":       []byte("app_" + appName),
		"PGPASSWORD":   []byte("pw"),
		"APP_ROLE_MD5": []byte("md5abc"),
	}
	if withRO {
		data["DATABASE_URL_RO"] = []byte(fmt.Sprintf("postgres://app_%s:pw@pggw-apps.scale-zero-pg.svc:55434/%s?sslmode=disable", appName, appName))
	}
	src := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "app-db-" + appName, Namespace: testDBNamespace}}
	_, err = controllerutil.CreateOrUpdate(ctx, k8sClient, src, func() error {
		src.Data = data
		return nil
	})
	Expect(err).NotTo(HaveOccurred())
}

var _ = Describe("Unified config — NextApp.spec.database", func() {
	ctx := context.Background()
	const image = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

	BeforeEach(func() {
		ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: testDBNamespace}}
		err := k8sClient.Create(ctx, ns)
		if err != nil && !errors.IsAlreadyExists(err) {
			Expect(err).NotTo(HaveOccurred())
		}
	})

	newReconciler := func() *NextAppReconciler {
		return &NextAppReconciler{
			Client:            k8sClient,
			Scheme:            k8sClient.Scheme(),
			DatabaseNamespace: testDBNamespace,
		}
	}

	It("hard-gates the app until the AppDatabase is Ready, then mirrors + injects the DSN", func() {
		nn := types.NamespacedName{Name: "shop", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    image,
				Database: &appsv1alpha1.DatabaseSpec{Enabled: true, Tier: "cold", ReadReplicas: true},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		appName := deriveAppName(nn.Namespace, nn.Name)

		By("first reconcile: AppDatabase is created and the app is HARD-GATED (no ksvc)")
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		adb, err := getAppDatabase(ctx, appName)
		Expect(err).NotTo(HaveOccurred(), "AppDatabase must be created in scale-zero-pg ns")
		gotAppName, _, _ := unstructured.NestedString(adb.Object, "spec", "appName")
		Expect(gotAppName).To(Equal(appName))
		Expect(adb.GetAnnotations()).To(HaveKeyWithValue(nextAppRefAnnotation, "default/shop"))
		roEnabled, _, _ := unstructured.NestedBool(adb.Object, "spec", "roPool", "enabled")
		Expect(roEnabled).To(BeTrue(), "readReplicas must request the RO pool")

		// Hard-gate: NO Knative Service yet, DatabaseReady=False.
		ksvc := &servingv1.Service{}
		err = k8sClient.Get(ctx, nn, ksvc)
		Expect(errors.IsNotFound(err)).To(BeTrue(), "ksvc must NOT be created while the DB is provisioning")

		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(fetched.Status.DatabaseAppName).To(Equal(appName), "derived appName must be recorded on status")
		Expect(conditionStatus(fetched, ConditionDatabaseReady)).To(Equal(metav1.ConditionFalse))
		Expect(controllerutil.ContainsFinalizer(fetched, DatabaseCleanupFinalizer)).To(BeTrue())

		By("the AppDatabase goes Ready (as the scale-zero-pg operator would)")
		markAppDatabaseReady(ctx, appName, true)

		By("second reconcile: DSN is mirrored into the app ns and injected into the ksvc env")
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		// Mirrored Secret exists in the app ns, ownerRef'd to the NextApp.
		mirror := &corev1.Secret{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "shop-db", Namespace: "default"}, mirror)).To(Succeed())
		Expect(mirror.Data).To(HaveKey("DATABASE_URL"))
		Expect(mirror.Data).To(HaveKey("DATABASE_URL_RO"))
		Expect(mirror.OwnerReferences).NotTo(BeEmpty(), "mirror must be ownerRef'd to the NextApp for same-ns GC")
		Expect(mirror.OwnerReferences[0].Name).To(Equal("shop"))

		// ksvc now exists with DATABASE_URL(+_RO) wired via SecretKeyRef.
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		env := ksvc.Spec.Template.Spec.Containers[0].Env
		Expect(envHasSecretRef(env, "DATABASE_URL", "shop-db", "DATABASE_URL")).To(BeTrue())
		Expect(envHasSecretRef(env, "DATABASE_URL_RO", "shop-db", "DATABASE_URL_RO")).To(BeTrue())
		// Rotation-roll annotation stamped on the pod template.
		Expect(ksvc.Spec.Template.Annotations).To(HaveKey(databaseSecretHashAnnotation))

		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(conditionStatus(fetched, ConditionDatabaseReady)).To(Equal(metav1.ConditionTrue))
		Expect(fetched.Status.DatabaseSecretName).To(Equal("shop-db"))
	})

	It("keeps two same-named NextApps in different namespaces on DISTINCT databases (isolation)", func() {
		nsA := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "tenant-a"}}
		nsB := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "tenant-b"}}
		for _, ns := range []*corev1.Namespace{nsA, nsB} {
			if err := k8sClient.Create(ctx, ns); err != nil && !errors.IsAlreadyExists(err) {
				Expect(err).NotTo(HaveOccurred())
			}
		}
		mk := func(ns string) types.NamespacedName {
			nn := types.NamespacedName{Name: "shop", Namespace: ns}
			app := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
				Spec:       appsv1alpha1.NextAppSpec{Image: image, Database: &appsv1alpha1.DatabaseSpec{Enabled: true}},
			}
			Expect(k8sClient.Create(ctx, app)).To(Succeed())
			return nn
		}
		nnA, nnB := mk("tenant-a"), mk("tenant-b")
		defer deleteAndFinalize(ctx, nnA)
		defer deleteAndFinalize(ctx, nnB)

		r := newReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nnA})
		Expect(err).NotTo(HaveOccurred())
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nnB})
		Expect(err).NotTo(HaveOccurred())

		_, errA := getAppDatabase(ctx, "tenant-a-shop")
		_, errB := getAppDatabase(ctx, "tenant-b-shop")
		Expect(errA).NotTo(HaveOccurred())
		Expect(errB).NotTo(HaveOccurred())
		// The identically-named apps did NOT collide on one shared DB.
		Expect(deriveAppName("tenant-a", "shop")).NotTo(Equal(deriveAppName("tenant-b", "shop")))
	})

	It("deletes the AppDatabase on NextApp delete via the db-cleanup finalizer", func() {
		nn := types.NamespacedName{Name: "ephemeral", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec:       appsv1alpha1.NextAppSpec{Image: image, Database: &appsv1alpha1.DatabaseSpec{Enabled: true}},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		r := newReconciler()
		appName := deriveAppName(nn.Namespace, nn.Name)

		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		_, err = getAppDatabase(ctx, appName)
		Expect(err).NotTo(HaveOccurred(), "AppDatabase should exist before delete")

		By("deleting the NextApp — the finalizer must delete the cross-ns AppDatabase")
		cur := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, cur)).To(Succeed())
		Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		_, err = getAppDatabase(ctx, appName)
		Expect(errors.IsNotFound(err)).To(BeTrue(), "AppDatabase must be deleted when the NextApp is torn down")

		Eventually(func() bool {
			_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			return errors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
		}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
	})

	It("RETAINS the AppDatabase when keepOnDelete is set", func() {
		nn := types.NamespacedName{Name: "keeper", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    image,
				Database: &appsv1alpha1.DatabaseSpec{Enabled: true, KeepOnDelete: true},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		r := newReconciler()
		appName := deriveAppName(nn.Namespace, nn.Name)

		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		cur := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, cur)).To(Succeed())
		Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		// The AppDatabase must SURVIVE (retained for PITR). Clean it up manually.
		adb, err := getAppDatabase(ctx, appName)
		Expect(err).NotTo(HaveOccurred(), "AppDatabase must be retained when keepOnDelete=true")
		Expect(k8sClient.Delete(ctx, adb)).To(Succeed())
	})

	It("preserves the BYO-database escape hatch: enabled=false provisions nothing", func() {
		nn := types.NamespacedName{Name: "byo", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: image,
				// No spec.database (BYO). An explicit manual envMap keeps working.
				Secrets: &appsv1alpha1.SecretsSpec{
					EnvMap: map[string]appsv1alpha1.EnvMapEntry{
						"DATABASE_URL": {SecretName: "my-own-secret", SecretKey: "url"},
					},
				},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r := newReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		// No AppDatabase provisioned.
		_, err = getAppDatabase(ctx, deriveAppName(nn.Namespace, nn.Name))
		Expect(errors.IsNotFound(err)).To(BeTrue(), "enabled=false must provision no database")

		// No db-cleanup finalizer, and the manual envMap is untouched (ksvc created).
		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(controllerutil.ContainsFinalizer(fetched, DatabaseCleanupFinalizer)).To(BeFalse())
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		Expect(envHasSecretRef(ksvc.Spec.Template.Spec.Containers[0].Env, "DATABASE_URL", "my-own-secret", "url")).To(BeTrue())
	})
})

// conditionStatus returns the status of the named condition, or "" if absent.
func conditionStatus(app *appsv1alpha1.NextApp, condType string) metav1.ConditionStatus {
	for _, c := range app.Status.Conditions {
		if c.Type == condType {
			return c.Status
		}
	}
	return ""
}

// envHasSecretRef reports whether env contains name → secretKeyRef(secretName, key).
func envHasSecretRef(env []corev1.EnvVar, name, secretName, key string) bool {
	for _, e := range env {
		if e.Name != name || e.ValueFrom == nil || e.ValueFrom.SecretKeyRef == nil {
			continue
		}
		if e.ValueFrom.SecretKeyRef.Name == secretName && e.ValueFrom.SecretKeyRef.Key == key {
			return true
		}
	}
	return false
}
