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
	"k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// These specs cover the ADR-0019 addendum: what happens to a MANAGED
// (ADR-0018, delegated) AppDatabase when spec.database is switched to BYO
// (secretRef) or removed entirely.
//
// The load-bearing semantics decision (data safety): a spec EDIT must never
// destroy data. The AppDatabase fronts the user's Neon timeline, and the new
// BYO spec cannot even carry keepOnDelete (admission rule 7 rejects
// provisioning knobs alongside secretRef), so there is no author signal at
// switch time that could authorize deletion. The operator therefore RETAINS
// the AppDatabase and flags the orphan LOUDLY — Warning event + a
// DatabaseOrphaned=True condition — until the user deletes it manually,
// switches back to managed mode (idempotent rebind to the SAME AppDatabase),
// or deletes the NextApp (the retained status.databaseAppName lets the
// db-cleanup finalizer reclaim it, as before).
//
// The condition type / event reason are asserted as string literals (not the
// exported constants) so these specs fail on ASSERTIONS, not compilation,
// before the implementation lands.
var _ = Describe("Database mode switch — managed → BYO/none (ADR-0019 addendum)", func() {
	ctx := context.Background()
	const image = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	const orphanCondition = "DatabaseOrphaned"
	const orphanReason = "DatabaseOrphaned"

	BeforeEach(func() {
		ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: testDBNamespace}}
		if err := k8sClient.Create(ctx, ns); err != nil && !errors.IsAlreadyExists(err) {
			Expect(err).NotTo(HaveOccurred())
		}
	})

	newSwitchReconciler := func() (*NextAppReconciler, *record.FakeRecorder) {
		rec := record.NewFakeRecorder(64)
		return &NextAppReconciler{
			Client:            k8sClient,
			Scheme:            k8sClient.Scheme(),
			Recorder:          rec,
			DatabaseNamespace: testDBNamespace,
		}, rec
	}

	// provisionManagedReady creates a managed-mode NextApp and drives it to
	// DatabaseReady=True (AppDatabase Ready + DSN mirrored), returning the
	// derived appName.
	provisionManagedReady := func(r *NextAppReconciler, nn types.NamespacedName) string {
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: nn.Name, Namespace: nn.Namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    image,
				Database: &appsv1alpha1.DatabaseSpec{Enabled: true},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		appName := deriveAppName(nn.Namespace, nn.Name)

		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		markAppDatabaseReady(ctx, appName, false)
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(conditionStatus(fetched, ConditionDatabaseReady)).To(Equal(metav1.ConditionTrue))
		return appName
	}

	switchTo := func(nn types.NamespacedName, db *appsv1alpha1.DatabaseSpec) {
		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		fetched.Spec.Database = db
		Expect(k8sClient.Update(ctx, fetched)).To(Succeed())
	}

	It("managed→BYO: retains the AppDatabase (data safety), flags DatabaseOrphaned loudly, and binds the BYO Secret", func() {
		nn := types.NamespacedName{Name: "switch-byo", Namespace: "default"}
		r, rec := newSwitchReconciler()
		appName := provisionManagedReady(r, nn)
		defer deleteAndFinalize(ctx, nn)
		drainEvents(rec)

		By("switching spec.database from enabled: true to secretRef (BYO)")
		switchTo(nn, &appsv1alpha1.DatabaseSpec{
			SecretRef: &appsv1alpha1.DatabaseSecretRef{Name: "my-own-db"},
		})
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		By("the AppDatabase must SURVIVE the switch — a spec edit never deletes data")
		adb, err := getAppDatabase(ctx, appName)
		Expect(err).NotTo(HaveOccurred(), "the managed AppDatabase must NOT be deleted on a mode switch")
		Expect(adb.GetDeletionTimestamp().IsZero()).To(BeTrue(),
			"the AppDatabase must not even be marked for deletion")

		By("the orphan is flagged loudly: Warning event + DatabaseOrphaned=True condition")
		Expect(drainEvents(rec)).To(ContainElement(SatisfyAll(
			ContainSubstring("Warning"),
			ContainSubstring(orphanReason),
			ContainSubstring(appName),
		)), "a Warning event must name the orphaned database")

		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		orphan := apimeta.FindStatusCondition(fetched.Status.Conditions, orphanCondition)
		Expect(orphan).NotTo(BeNil(), "a DatabaseOrphaned condition must be set")
		Expect(orphan.Status).To(Equal(metav1.ConditionTrue))
		Expect(orphan.Message).To(ContainSubstring(appName),
			"the condition must name the orphaned AppDatabase so the user can act on it")

		By("the BYO binding itself works: DatabaseReady=True/Bound on the new Secret")
		Expect(fetched.Status.DatabaseSecretName).To(Equal("my-own-db"))
		ready := apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionDatabaseReady)
		Expect(ready).NotTo(BeNil())
		Expect(ready.Status).To(Equal(metav1.ConditionTrue))
		Expect(ready.Reason).To(Equal("Bound"))

		By("status.databaseAppName is retained for delete-time reclaim")
		Expect(fetched.Status.DatabaseAppName).To(Equal(appName))

		By("the Warning is transition-scoped — a steady-state reconcile does not repeat it")
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		Expect(drainEvents(rec)).NotTo(ContainElement(ContainSubstring(orphanReason)),
			"the orphan Warning must fire on the transition, not on every reconcile")
	})

	It("managed→none (spec.database removed): same retain-and-flag semantics", func() {
		nn := types.NamespacedName{Name: "switch-none", Namespace: "default"}
		r, rec := newSwitchReconciler()
		appName := provisionManagedReady(r, nn)
		defer deleteAndFinalize(ctx, nn)
		drainEvents(rec)

		switchTo(nn, nil)
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		_, err = getAppDatabase(ctx, appName)
		Expect(err).NotTo(HaveOccurred(), "the AppDatabase must survive spec.database removal")

		Expect(drainEvents(rec)).To(ContainElement(SatisfyAll(
			ContainSubstring("Warning"),
			ContainSubstring(orphanReason),
		)))

		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(conditionStatus(fetched, orphanCondition)).To(Equal(metav1.ConditionTrue))
		// Mode removal semantics from ADR-0019 are unchanged: no DatabaseReady
		// claim, Secret name cleared, appName retained for delete-time reclaim.
		Expect(apimeta.FindStatusCondition(fetched.Status.Conditions, ConditionDatabaseReady)).To(BeNil())
		Expect(fetched.Status.DatabaseSecretName).To(BeEmpty())
		Expect(fetched.Status.DatabaseAppName).To(Equal(appName))
	})

	It("BYO→managed switch-back REUSES the same AppDatabase (idempotent rebind) and clears the orphan flag", func() {
		nn := types.NamespacedName{Name: "switch-back", Namespace: "default"}
		r, _ := newSwitchReconciler()
		appName := provisionManagedReady(r, nn)
		defer deleteAndFinalize(ctx, nn)

		adbBefore, err := getAppDatabase(ctx, appName)
		Expect(err).NotTo(HaveOccurred())
		uidBefore := adbBefore.GetUID()

		By("switching to BYO — the orphan flag appears")
		switchTo(nn, &appsv1alpha1.DatabaseSpec{
			SecretRef: &appsv1alpha1.DatabaseSecretRef{Name: "my-own-db"},
		})
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(conditionStatus(fetched, orphanCondition)).To(Equal(metav1.ConditionTrue),
			"precondition: the switch must have flagged the orphan")

		By("switching back to managed — the SAME AppDatabase is rebound, no duplicate")
		switchTo(nn, &appsv1alpha1.DatabaseSpec{Enabled: true})
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		adbAfter, err := getAppDatabase(ctx, appName)
		Expect(err).NotTo(HaveOccurred())
		Expect(adbAfter.GetUID()).To(Equal(uidBefore),
			"re-enabling must rebind the retained AppDatabase, not provision a duplicate")

		By("the orphan flag clears and the managed binding is Ready again")
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(apimeta.FindStatusCondition(fetched.Status.Conditions, orphanCondition)).To(BeNil(),
			"a rebound database is not orphaned — the condition must be removed")
		Expect(conditionStatus(fetched, ConditionDatabaseReady)).To(Equal(metav1.ConditionTrue))
		Expect(fetched.Status.DatabaseAppName).To(Equal(appName))
		Expect(fetched.Status.DatabaseSecretName).To(Equal(nn.Name + "-db"))
	})

	It("clears the orphan flag (and databaseAppName) once the user manually deletes the AppDatabase", func() {
		nn := types.NamespacedName{Name: "switch-reclaimed", Namespace: "default"}
		r, rec := newSwitchReconciler()
		appName := provisionManagedReady(r, nn)
		defer deleteAndFinalize(ctx, nn)

		switchTo(nn, &appsv1alpha1.DatabaseSpec{
			SecretRef: &appsv1alpha1.DatabaseSecretRef{Name: "my-own-db"},
		})
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		fetched := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(conditionStatus(fetched, orphanCondition)).To(Equal(metav1.ConditionTrue))

		By("the user deletes the orphaned AppDatabase manually")
		adb, err := getAppDatabase(ctx, appName)
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Delete(ctx, adb)).To(Succeed())
		drainEvents(rec)

		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		Expect(k8sClient.Get(ctx, nn, fetched)).To(Succeed())
		Expect(apimeta.FindStatusCondition(fetched.Status.Conditions, orphanCondition)).To(BeNil(),
			"once the AppDatabase is gone there is no orphan — the condition must clear")
		Expect(fetched.Status.DatabaseAppName).To(BeEmpty(),
			"databaseAppName must clear once nothing is left to reclaim")
		Expect(drainEvents(rec)).NotTo(ContainElement(ContainSubstring(orphanReason)))
	})

	It("NextApp deletion after a switch still reclaims the orphaned AppDatabase via the db-cleanup finalizer", func() {
		nn := types.NamespacedName{Name: "switch-then-delete", Namespace: "default"}
		r, _ := newSwitchReconciler()
		appName := provisionManagedReady(r, nn)

		switchTo(nn, &appsv1alpha1.DatabaseSpec{
			SecretRef: &appsv1alpha1.DatabaseSecretRef{Name: "my-own-db"},
		})
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		_, err = getAppDatabase(ctx, appName)
		Expect(err).NotTo(HaveOccurred(), "precondition: the AppDatabase is orphaned but alive")

		By("deleting the NextApp — the retained databaseAppName drives the reclaim")
		cur := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, cur)).To(Succeed())
		Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		_, err = getAppDatabase(ctx, appName)
		Expect(errors.IsNotFound(err)).To(BeTrue(),
			"the delete-time finalizer must still reclaim the orphaned AppDatabase")
		deleteAndFinalize(ctx, nn)
	})
})
