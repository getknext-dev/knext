package appdb

import (
	"context"
	"log"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// These tests exercise the REAL K8sCluster against a fake clientset, proving the
// operator stamps a controller ownerReference onto the actual API objects it
// creates — so k8s garbage-collects them natively on AppDatabase deletion (#122).

func testOwner() *metav1.OwnerReference {
	controller := true
	block := false
	return &metav1.OwnerReference{
		APIVersion:         Group + "/" + Version,
		Kind:               Kind,
		Name:               "shop",
		UID:                "uid-shop",
		Controller:         &controller,
		BlockOwnerDeletion: &block,
	}
}

func hasControllerRef(refs []metav1.OwnerReference, uid string) bool {
	for _, r := range refs {
		if string(r.UID) == uid && r.Controller != nil && *r.Controller &&
			r.Kind == Kind && r.APIVersion == Group+"/"+Version {
			return true
		}
	}
	return false
}

func newTestCluster() *K8sCluster {
	cs := fake.NewSimpleClientset()
	return NewK8sCluster(cs, nil, "scale-zero-pg", DefaultRenderConfig("scale-zero-pg"), "apps-wal-reclaim-pending", log.Default())
}

func TestApplyComputeSetsOwnerRefs(t *testing.T) {
	k := newTestCluster()
	ctx := context.Background()
	spec := ComputeSpec{App: "shop", TenantID: "t1", TimelineID: "tl1", Replicas: 0, Quotas: DefaultQuotas, OwnerRef: testOwner()}
	if err := k.ApplyCompute(ctx, spec); err != nil {
		t.Fatalf("ApplyCompute: %v", err)
	}

	cm, err := k.cs.CoreV1().ConfigMaps("scale-zero-pg").Get(ctx, "compute-config-shop", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get cm: %v", err)
	}
	if !hasControllerRef(cm.OwnerReferences, "uid-shop") {
		t.Errorf("configmap missing controller ownerRef: %+v", cm.OwnerReferences)
	}
	svc, _ := k.cs.CoreV1().Services("scale-zero-pg").Get(ctx, "compute-shop", metav1.GetOptions{})
	if !hasControllerRef(svc.OwnerReferences, "uid-shop") {
		t.Errorf("service missing controller ownerRef: %+v", svc.OwnerReferences)
	}
	dep, _ := k.cs.AppsV1().Deployments("scale-zero-pg").Get(ctx, "compute-shop", metav1.GetOptions{})
	if !hasControllerRef(dep.OwnerReferences, "uid-shop") {
		t.Errorf("deployment missing controller ownerRef: %+v", dep.OwnerReferences)
	}
}

// Idempotent back-fill: a child created WITHOUT an ownerRef (e.g. by an older
// operator or provision-app.sh) gains it on the next ApplyCompute.
func TestApplyComputeBackfillsOwnerRefOnExisting(t *testing.T) {
	k := newTestCluster()
	ctx := context.Background()
	// First apply with NO owner (simulate a pre-existing child).
	if err := k.ApplyCompute(ctx, ComputeSpec{App: "shop", TenantID: "t1", TimelineID: "tl1", Quotas: DefaultQuotas}); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	dep, _ := k.cs.AppsV1().Deployments("scale-zero-pg").Get(ctx, "compute-shop", metav1.GetOptions{})
	if len(dep.OwnerReferences) != 0 {
		t.Fatalf("precondition: expected no ownerRef, got %+v", dep.OwnerReferences)
	}
	// Second apply WITH an owner — back-fills.
	if err := k.ApplyCompute(ctx, ComputeSpec{App: "shop", TenantID: "t1", TimelineID: "tl1", Quotas: DefaultQuotas, OwnerRef: testOwner()}); err != nil {
		t.Fatalf("second apply: %v", err)
	}
	dep, _ = k.cs.AppsV1().Deployments("scale-zero-pg").Get(ctx, "compute-shop", metav1.GetOptions{})
	if !hasControllerRef(dep.OwnerReferences, "uid-shop") {
		t.Errorf("deployment ownerRef not back-filled: %+v", dep.OwnerReferences)
	}
}

func TestApplyROComputeSetsOwnerRefs(t *testing.T) {
	k := newTestCluster()
	ctx := context.Background()
	spec := ROComputeSpec{App: "shop", TenantID: "t1", TimelineID: "tl1", MaxReplicas: 3, OwnerRef: testOwner()}
	if err := k.ApplyROCompute(ctx, spec); err != nil {
		t.Fatalf("ApplyROCompute: %v", err)
	}
	svc, _ := k.cs.CoreV1().Services("scale-zero-pg").Get(ctx, "compute-ro-shop", metav1.GetOptions{})
	if !hasControllerRef(svc.OwnerReferences, "uid-shop") {
		t.Errorf("ro service missing controller ownerRef: %+v", svc.OwnerReferences)
	}
	dep, _ := k.cs.AppsV1().Deployments("scale-zero-pg").Get(ctx, "compute-ro-shop", metav1.GetOptions{})
	if !hasControllerRef(dep.OwnerReferences, "uid-shop") {
		t.Errorf("ro deployment missing controller ownerRef: %+v", dep.OwnerReferences)
	}
	hpa, err := k.cs.AutoscalingV2().HorizontalPodAutoscalers("scale-zero-pg").Get(ctx, "compute-ro-shop", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get hpa: %v", err)
	}
	if !hasControllerRef(hpa.OwnerReferences, "uid-shop") {
		t.Errorf("ro hpa missing controller ownerRef: %+v", hpa.OwnerReferences)
	}
}

func TestCreateSecretSetsOwnerRefAndEnsureBackfills(t *testing.T) {
	k := newTestCluster()
	ctx := context.Background()
	// CreateSecret stamps the ownerRef on the fresh secret.
	if err := k.CreateSecret(ctx, "shop", "app_shop", "pw", "verif", "postgres://dsn", testOwner()); err != nil {
		t.Fatalf("CreateSecret: %v", err)
	}
	sec, _ := k.cs.CoreV1().Secrets("scale-zero-pg").Get(ctx, "app-db-shop", metav1.GetOptions{})
	if !hasControllerRef(sec.OwnerReferences, "uid-shop") {
		t.Errorf("secret missing ownerRef on create: %+v", sec.OwnerReferences)
	}

	// Back-fill path: a secret created without an ownerRef gains it via EnsureSecretOwnerRef.
	if err := k.CreateSecret(ctx, "old", "app_old", "pw", "verif", "postgres://dsn", nil); err != nil {
		t.Fatalf("CreateSecret old: %v", err)
	}
	old, _ := k.cs.CoreV1().Secrets("scale-zero-pg").Get(ctx, "app-db-old", metav1.GetOptions{})
	if len(old.OwnerReferences) != 0 {
		t.Fatalf("precondition: old secret should have no ownerRef, got %+v", old.OwnerReferences)
	}
	owner := testOwner()
	owner.Name, owner.UID = "old", "uid-old"
	if err := k.EnsureSecretOwnerRef(ctx, "old", owner); err != nil {
		t.Fatalf("EnsureSecretOwnerRef: %v", err)
	}
	old, _ = k.cs.CoreV1().Secrets("scale-zero-pg").Get(ctx, "app-db-old", metav1.GetOptions{})
	if !hasControllerRef(old.OwnerReferences, "uid-old") {
		t.Errorf("EnsureSecretOwnerRef did not back-fill: %+v", old.OwnerReferences)
	}
}

// A nil owner must never mutate a child (dangling-owner guard) — EnsureSecretOwnerRef
// is a no-op, and it does not error when the secret is absent.
func TestEnsureSecretOwnerRefNilAndMissingAreNoops(t *testing.T) {
	k := newTestCluster()
	ctx := context.Background()
	if err := k.EnsureSecretOwnerRef(ctx, "absent", testOwner()); err != nil {
		t.Errorf("missing secret must be a no-op, got %v", err)
	}
	if err := k.CreateSecret(ctx, "shop", "app_shop", "pw", "verif", "dsn", testOwner()); err != nil {
		t.Fatalf("CreateSecret: %v", err)
	}
	if err := k.EnsureSecretOwnerRef(ctx, "shop", nil); err != nil {
		t.Errorf("nil owner must be a no-op, got %v", err)
	}
	sec, _ := k.cs.CoreV1().Secrets("scale-zero-pg").Get(ctx, "app-db-shop", metav1.GetOptions{})
	if !hasControllerRef(sec.OwnerReferences, "uid-shop") {
		t.Errorf("existing ownerRef must be preserved: %+v", sec.OwnerReferences)
	}
}
