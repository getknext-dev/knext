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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// These specs cover ADR-0019: the first-class BYO Postgres binding —
// spec.database.secretRef / roSecretRef mapping to DATABASE_URL / DATABASE_URL_RO
// as typed sugar over the proven spec.secrets.envMap path.
//
// Collision enforcement is split (true ratcheting, ADR-0019):
//   - the WEBHOOK rejects a DATABASE_URL(_RO) collision on CREATE and on any
//     UPDATE that ADDS one (tested in internal/webhook/v1alpha1);
//   - the RECONCILER tolerates STORED collision CRs (objects that predate the
//     rules — the webhook is not in this suite, exactly simulating them) and
//     resolves them LOUDLY: spec.database wins + a Warning event. Never
//     Degraded/InvalidSpec — bricking running apps on operator upgrade is the
//     harm ratcheting exists to prevent.
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

var _ = Describe("Database binding — NextApp.spec.database.secretRef (ADR-0019)", func() {
	ctx := context.Background()
	const image = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

	newBindingReconciler := func() (*NextAppReconciler, *record.FakeRecorder) {
		rec := record.NewFakeRecorder(64)
		return &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: rec,
		}, rec
	}

	ref := func(name string) *appsv1alpha1.DatabaseSecretRef {
		return &appsv1alpha1.DatabaseSecretRef{Name: name}
	}

	It("binds an existing Secret as DATABASE_URL with the default key (no provisioning, no event noise)", func() {
		nn := types.NamespacedName{Name: "bound", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    image,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r, rec := newBindingReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		// The env is wired via the SAME SecretKeyRef machinery as envMap.
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		env := ksvc.Spec.Template.Spec.Containers[0].Env
		Expect(envHasSecretRef(env, "DATABASE_URL", "shop-db", "DATABASE_URL")).To(BeTrue(),
			"secretRef.key must default to DATABASE_URL")

		// BYO provisions NOTHING: no db-cleanup finalizer.
		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(controllerutil.ContainsFinalizer(fetched, DatabaseCleanupFinalizer)).To(BeFalse())

		// Status surface: bound Secret recorded + DatabaseReady=True/Bound.
		Expect(fetched.Status.DatabaseSecretName).To(Equal("shop-db"))
		Expect(conditionStatus(fetched, ConditionDatabaseReady)).To(Equal(metav1.ConditionTrue))

		// A clean binding must be quiet: no EnvVarIgnored / override Warnings.
		Expect(drainEvents(rec)).NotTo(ContainElement(ContainSubstring(ReasonEnvVarIgnored)))
	})

	It("binds the RO variant: roSecretRef -> DATABASE_URL_RO (default key DATABASE_URL_RO)", func() {
		nn := types.NamespacedName{Name: "bound-ro", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: image,
				Database: &appsv1alpha1.DatabaseSpec{
					SecretRef: &appsv1alpha1.DatabaseSecretRef{Name: "shop-db", Key: "uri"},
					// Same Secret carrying both keys — the pggw pairing.
					ROSecretRef: ref("shop-db"),
				},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r, _ := newBindingReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		env := ksvc.Spec.Template.Spec.Containers[0].Env
		Expect(envHasSecretRef(env, "DATABASE_URL", "shop-db", "uri")).To(BeTrue(),
			"an explicit secretRef.key must be honored")
		Expect(envHasSecretRef(env, "DATABASE_URL_RO", "shop-db", "DATABASE_URL_RO")).To(BeTrue(),
			"roSecretRef.key must default to DATABASE_URL_RO")
	})

	It("wires the SecretKeyRef even when the Secret does not exist (envMap semantics — no gate)", func() {
		// Parity with spec.secrets.envMap: the operator does not gate the deploy
		// on the referenced Secret existing; kubelet surfaces the missing Secret
		// (CreateContainerConfigError) until it appears. This is deliberately
		// DIFFERENT from the managed mode's hard-gate, where the operator owns
		// the Secret's lifecycle.
		nn := types.NamespacedName{Name: "bound-absent", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    image,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("does-not-exist-yet")},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r, _ := newBindingReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed(), "the ksvc must be created — no hard-gate in BYO mode")
		env := ksvc.Spec.Template.Spec.Containers[0].Env
		Expect(envHasSecretRef(env, "DATABASE_URL", "does-not-exist-yet", "DATABASE_URL")).To(BeTrue())
	})

	It("clears the database status surface when spec.database is removed (mode removal)", func() {
		nn := types.NamespacedName{Name: "bound-then-removed", Namespace: "default"}
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    image,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		defer deleteAndFinalize(ctx, nn)

		r, _ := newBindingReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(fetched.Status.DatabaseSecretName).To(Equal("shop-db"))
		Expect(conditionStatus(fetched, ConditionDatabaseReady)).To(Equal(metav1.ConditionTrue))

		By("removing spec.database and reconciling again")
		fetched.Spec.Database = nil
		Expect(k8sClient.Update(ctx, fetched)).To(Succeed())
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(fetched.Status.DatabaseSecretName).To(BeEmpty(),
			"status.databaseSecretName must be cleared when the binding is removed — status must not lie")
		Expect(apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionDatabaseReady)).To(BeNil(),
			"the DatabaseReady condition must be removed when spec.database is gone")
	})

	Describe("stored collision CRs (ratcheted — predate the webhook rules)", func() {
		// The webhook is NOT running in this suite, so k8sClient.Create can store
		// CRs the webhook would reject on create — exactly the shape of objects
		// persisted before the collision rules existed (validation ratcheting).
		// The reconciler must resolve them LOUDLY, never brick them.

		It("BYO: reconciles, binding wins over the stale envMap entry, Warning event emitted", func() {
			nn := types.NamespacedName{Name: "ratchet-byo", Namespace: "default"}
			app := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
				Spec: appsv1alpha1.NextAppSpec{
					Image:    image,
					Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
					Secrets: &appsv1alpha1.SecretsSpec{
						EnvMap: map[string]appsv1alpha1.EnvMapEntry{
							"DATABASE_URL": {SecretName: "stale", SecretKey: "url"},
						},
					},
				},
			}
			Expect(k8sClient.Create(ctx, app)).To(Succeed(),
				"a stored collision CR must be creatable without the webhook (ratchet simulation)")
			defer deleteAndFinalize(ctx, nn)

			r, rec := newBindingReconciler()
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
			Expect(err).NotTo(HaveOccurred(), "a stored collision CR must reconcile, not fail closed")

			// Binding wins deterministically.
			ksvc := &servingv1.Service{}
			Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed(), "the app must still deploy")
			env := ksvc.Spec.Template.Spec.Containers[0].Env
			Expect(envHasSecretRef(env, "DATABASE_URL", "shop-db", "DATABASE_URL")).To(BeTrue(),
				"spec.database.secretRef must win over the stale envMap entry")
			Expect(envHasSecretRef(env, "DATABASE_URL", "stale", "url")).To(BeFalse())

			// ...and LOUDLY: a Warning names the ignored envMap entry.
			Expect(drainEvents(rec)).To(ContainElement(SatisfyAll(
				ContainSubstring("Warning"),
				ContainSubstring(ReasonEnvVarIgnored),
				ContainSubstring("DATABASE_URL"),
			)))

			// Never Degraded/InvalidSpec — that would brick a running app.
			// (Degraded=True with the ksvc's own not-ready reason is normal in
			// envtest, where nothing actually serves the placeholder image.)
			fetched := &appsv1alpha1.NextApp{}
			Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
			degraded := apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionDegraded)
			if degraded != nil {
				Expect(degraded.Reason).NotTo(Equal("InvalidSpec"),
					"a stored collision CR must never be failed closed as InvalidSpec")
			}
		})

	})

	Describe("admission validation (CRD CEL — intra-field rules)", func() {
		mk := func(name string, spec appsv1alpha1.NextAppSpec) error {
			spec.Image = image
			app := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
				Spec:       spec,
			}
			err := k8sClient.Create(ctx, app)
			if err == nil {
				// Clean up accidentally-accepted objects so specs stay independent.
				deleteAndFinalize(ctx, types.NamespacedName{Name: name, Namespace: "default"})
			}
			return err
		}

		It("REJECTS roSecretRef without secretRef", func() {
			err := mk("ro-alone", appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{ROSecretRef: ref("shop-db")},
			})
			Expect(err).To(HaveOccurred())
		})

		It("REJECTS a non-DNS-1123 secret name", func() {
			err := mk("bad-name", appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("Not_A_Valid_Name")},
			})
			Expect(err).To(HaveOccurred())
		})

		It("ACCEPTS secretRef alongside envMap entries for OTHER env vars", func() {
			err := mk("no-collide", appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
				Secrets: &appsv1alpha1.SecretsSpec{
					EnvMap: map[string]appsv1alpha1.EnvMapEntry{
						"STRIPE_KEY": {SecretName: "stripe", SecretKey: "key"},
					},
				},
			})
			Expect(err).NotTo(HaveOccurred())
		})
	})
})
