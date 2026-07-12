package appdb

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ---- owner-reference construction (issue #122) -----------------------------

// The reconciler builds a controller ownerReference to the AppDatabase and
// attaches it to every child it creates, so k8s garbage-collects the children
// natively on CR deletion (defense-in-depth over the finalizer path).
func TestOwnerRefBuiltFromCR(t *testing.T) {
	cr := &AppDatabase{Name: "shop", Namespace: "scale-zero-pg", UID: "uid-1234"}
	ref := cr.ownerRef()
	if ref == nil {
		t.Fatalf("ownerRef() nil for a CR with a UID")
	}
	if ref.APIVersion != Group+"/"+Version {
		t.Errorf("apiVersion = %q, want %q", ref.APIVersion, Group+"/"+Version)
	}
	if ref.Kind != Kind {
		t.Errorf("kind = %q, want %q", ref.Kind, Kind)
	}
	if ref.Name != "shop" {
		t.Errorf("name = %q, want shop", ref.Name)
	}
	if string(ref.UID) != "uid-1234" {
		t.Errorf("uid = %q, want uid-1234", ref.UID)
	}
	if ref.Controller == nil || !*ref.Controller {
		t.Errorf("controller must be true, got %v", ref.Controller)
	}
	// blockOwnerDeletion must be false: setting it true would require the operator
	// SA to hold update on appdatabases/finalizers (OwnerReferencesPermissionEnforcement).
	if ref.BlockOwnerDeletion == nil || *ref.BlockOwnerDeletion {
		t.Errorf("blockOwnerDeletion must be false, got %v", ref.BlockOwnerDeletion)
	}
}

// A CR with no UID (hand-built object, or not yet persisted) yields NO ownerRef:
// an ownerReference with an empty UID is a dangling owner that the GC controller
// would treat as garbage and DELETE the child. Omitting it is the safe default.
func TestOwnerRefNilWhenNoUID(t *testing.T) {
	cr := &AppDatabase{Name: "shop", Namespace: "scale-zero-pg"} // UID == ""
	if ref := cr.ownerRef(); ref != nil {
		t.Errorf("ownerRef() must be nil when UID is empty, got %+v", ref)
	}
}

// On the create path the operator stamps the ownerRef onto the compute (ComputeSpec)
// and onto the per-app Secret (EnsureSecretOwnerRef).
func TestReconcileStampsOwnerRefOnChildren(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "shop", Namespace: "scale-zero-pg", UID: "uid-shop", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "shop", ROPool: ROPool{Enabled: true, MaxReplicas: 3}}}

	mustReconcile(t, h, cr)

	// Writer compute carries the controller ownerRef.
	if len(h.cl.applied) == 0 {
		t.Fatalf("compute not applied")
	}
	wo := h.cl.applied[len(h.cl.applied)-1].OwnerRef
	if wo == nil || string(wo.UID) != "uid-shop" || wo.Controller == nil || !*wo.Controller {
		t.Errorf("writer compute ownerRef wrong: %+v", wo)
	}
	// RO compute carries it too.
	ro := h.cl.roApplied["shop"].OwnerRef
	if ro == nil || string(ro.UID) != "uid-shop" {
		t.Errorf("ro compute ownerRef wrong: %+v", ro)
	}
	// Secret back-fill requested with the ownerRef.
	so := h.cl.secretOwner["shop"]
	if so == nil || string(so.UID) != "uid-shop" {
		t.Errorf("secret ownerRef not back-filled: %+v", so)
	}
}

// Back-fill: an ALREADY-provisioned app (secret + branch exist) still gets its
// Secret's ownerRef ensured on the next reconcile — existing live apps converge.
func TestReconcileBackfillsOwnerRefOnExistingApp(t *testing.T) {
	h := newHarness()
	h.cl.secrets["live"] = true
	h.ps.timelines["cafe0000000000000000000000000009"] = true
	cr := &AppDatabase{Name: "live", Namespace: "scale-zero-pg", UID: "uid-live", Generation: 2,
		Finalizers: []string{Finalizer},
		Spec:       AppDatabaseSpec{AppName: "live"},
		Status:     AppDatabaseStatus{TimelineID: "cafe0000000000000000000000000009", Phase: PhaseReady}}

	mustReconcile(t, h, cr)

	// Secret was NOT re-created (idempotent) but its ownerRef WAS ensured.
	if len(h.cl.createdSecret) != 0 {
		t.Errorf("secret must not be re-created: %v", h.cl.createdSecret)
	}
	if so := h.cl.secretOwner["live"]; so == nil || string(so.UID) != "uid-live" {
		t.Errorf("ownerRef not back-filled onto existing secret: %+v", so)
	}
	if wo := h.cl.applied[len(h.cl.applied)-1].OwnerRef; wo == nil {
		t.Errorf("compute drift-heal must also carry the ownerRef")
	}
}

// A CR with no UID must NOT stamp an ownerRef anywhere (dangling-owner guard).
func TestReconcileNoOwnerRefWhenNoUID(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "nouid", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "nouid"}} // UID == ""

	mustReconcile(t, h, cr)

	if wo := h.cl.applied[len(h.cl.applied)-1].OwnerRef; wo != nil {
		t.Errorf("compute must not carry an ownerRef when CR has no UID: %+v", wo)
	}
	if so := h.cl.secretOwner["nouid"]; so != nil {
		t.Errorf("secret must not carry an ownerRef when CR has no UID: %+v", so)
	}
}

var _ = metav1.OwnerReference{}
