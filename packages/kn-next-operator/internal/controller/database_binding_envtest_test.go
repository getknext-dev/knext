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
	"k8s.io/apimachinery/pkg/api/errors"
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
// as typed sugar over the proven spec.secrets.envMap path, plus the admission
// validation matrix (CEL, enforced by the envtest apiserver).
var _ = Describe("Database binding — NextApp.spec.database.secretRef (ADR-0019)", func() {
	ctx := context.Background()
	const image = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

	newBindingReconciler := func() *NextAppReconciler {
		return &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: record.NewFakeRecorder(64),
		}
	}

	ref := func(name string) *appsv1alpha1.DatabaseSecretRef {
		return &appsv1alpha1.DatabaseSecretRef{Name: name}
	}

	It("binds an existing Secret as DATABASE_URL with the default key (no provisioning)", func() {
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

		r := newBindingReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		// The env is wired via the SAME SecretKeyRef machinery as envMap.
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		env := ksvc.Spec.Template.Spec.Containers[0].Env
		Expect(envHasSecretRef(env, "DATABASE_URL", "shop-db", "DATABASE_URL")).To(BeTrue(),
			"secretRef.key must default to DATABASE_URL")

		// BYO provisions NOTHING: no AppDatabase, no db-cleanup finalizer.
		_, err = getAppDatabase(ctx, deriveAppName(nn.Namespace, nn.Name))
		Expect(errors.IsNotFound(err)).To(BeTrue(), "secretRef must not provision an AppDatabase")

		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(controllerutil.ContainsFinalizer(fetched, DatabaseCleanupFinalizer)).To(BeFalse())

		// Status surface: bound Secret recorded + DatabaseReady=True/Bound.
		Expect(fetched.Status.DatabaseSecretName).To(Equal("shop-db"))
		Expect(conditionStatus(fetched, ConditionDatabaseReady)).To(Equal(metav1.ConditionTrue))
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

		r := newBindingReconciler()
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

		r := newBindingReconciler()
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed(), "the ksvc must be created — no hard-gate in BYO mode")
		env := ksvc.Spec.Template.Spec.Containers[0].Env
		Expect(envHasSecretRef(env, "DATABASE_URL", "does-not-exist-yet", "DATABASE_URL")).To(BeTrue())
	})

	Describe("admission validation matrix (CEL)", func() {
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

		It("REJECTS spec.database.secretRef + spec.secrets.envMap[DATABASE_URL] — no silent precedence", func() {
			err := mk("collide-byo", appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
				Secrets: &appsv1alpha1.SecretsSpec{
					EnvMap: map[string]appsv1alpha1.EnvMapEntry{
						"DATABASE_URL": {SecretName: "other", SecretKey: "url"},
					},
				},
			})
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("DATABASE_URL"))
		})

		It("REJECTS the managed mode + envMap[DATABASE_URL] too (tightens ADR-0018's silent override)", func() {
			err := mk("collide-managed", appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{Enabled: true},
				Secrets: &appsv1alpha1.SecretsSpec{
					EnvMap: map[string]appsv1alpha1.EnvMapEntry{
						"DATABASE_URL": {SecretName: "other", SecretKey: "url"},
					},
				},
			})
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("DATABASE_URL"))
		})

		It("REJECTS roSecretRef + envMap[DATABASE_URL_RO]", func() {
			err := mk("collide-ro", appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db"), ROSecretRef: ref("shop-db")},
				Secrets: &appsv1alpha1.SecretsSpec{
					EnvMap: map[string]appsv1alpha1.EnvMapEntry{
						"DATABASE_URL_RO": {SecretName: "other", SecretKey: "ro"},
					},
				},
			})
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("DATABASE_URL_RO"))
		})

		It("REJECTS enabled: true together with secretRef (managed vs BYO — one mode per app)", func() {
			err := mk("both-modes", appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{Enabled: true, SecretRef: ref("shop-db")},
			})
			Expect(err).To(HaveOccurred())
		})

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

		It("REJECTS provisioning knobs together with secretRef (never silently ignored)", func() {
			err := mk("knobs", appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db"), Tier: "warm"},
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
