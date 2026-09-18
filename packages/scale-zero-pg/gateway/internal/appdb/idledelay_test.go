package appdb

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Per-app idleDelay (#779, ADR-0002): the operator VALIDATES the spec (nil/0 ⇒
// fleet default, reject negative, reject > 6h), then stamps the validated window in
// integer millis on the compute Deployment's metadata.annotations — NEVER the pod
// template (the compute uses Recreate; a template edit would churn it).

func dur(d time.Duration) *metav1.Duration { return &metav1.Duration{Duration: d} }

func TestValidateIdleDelay(t *testing.T) {
	cases := []struct {
		name    string
		in      *metav1.Duration
		wantErr bool
	}{
		{"nil ⇒ fleet default", nil, false},
		{"0s ⇒ fleet default", dur(0), false},
		{"5m ok", dur(5 * time.Minute), false},
		{"6h boundary ok", dur(6 * time.Hour), false},
		{"negative rejected", dur(-1 * time.Second), true},
		{"over 6h rejected", dur(6*time.Hour + time.Second), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateIdleDelay(tc.in)
			if tc.wantErr != (err != nil) {
				t.Fatalf("validateIdleDelay(%v) err=%v, wantErr=%v", tc.in, err, tc.wantErr)
			}
		})
	}
}

// A negative idleDelay is a terminal validation failure: Phase Failed, an
// InvalidIdleDelay condition + Warning event, and the compute is NEVER applied (a
// malformed value must not reach the gateway timer).
func TestReconcile_RejectsNegativeIdleDelay(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{
		Name: "shop", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "shop", IdleDelay: dur(-5 * time.Second)},
	}

	if rq := mustReconcile(t, h, cr); rq {
		t.Fatalf("a validation failure must be terminal (no requeue)")
	}
	if cr.Status.Phase != PhaseFailed {
		t.Fatalf("phase = %q, want Failed", cr.Status.Phase)
	}
	if len(h.cl.applied) != 0 {
		t.Fatalf("compute applied despite invalid idleDelay: %v", h.cl.applied)
	}
	if !hasEvent(h, "InvalidIdleDelay") {
		t.Fatalf("no InvalidIdleDelay event: %v", h.cl.events)
	}
}

func TestReconcile_RejectsTooLongIdleDelay(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{
		Name: "shop", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "shop", IdleDelay: dur(7 * time.Hour)},
	}

	mustReconcile(t, h, cr)

	if cr.Status.Phase != PhaseFailed {
		t.Fatalf("phase = %q, want Failed (> 6h must be rejected)", cr.Status.Phase)
	}
	if len(h.cl.applied) != 0 {
		t.Fatalf("compute applied despite > 6h idleDelay: %v", h.cl.applied)
	}
}

// RenderDeployment stamps the idle-delay millis on Deployment.metadata.annotations
// and NEVER on spec.template.metadata.annotations (the Recreate-churn guard).
func TestRenderDeployment_IdleDelayOnMetadataNotPodTemplate(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderDeployment(ComputeSpec{App: "shop", TenantID: "t", TimelineID: "tl", IdleDelayMs: 300000})

	if got := dep.Annotations[IdleDelayAnnotation]; got != "300000" {
		t.Fatalf("deployment metadata annotation = %q, want 300000", got)
	}
	if _, ok := dep.Spec.Template.Annotations[IdleDelayAnnotation]; ok {
		t.Fatalf("idle-delay annotation leaked onto the POD TEMPLATE — a Recreate churn every idleDelay edit")
	}

	// 0 ⇒ no override: no annotation stamped at all.
	depNone := c.RenderDeployment(ComputeSpec{App: "shop", TenantID: "t", TimelineID: "tl", IdleDelayMs: 0})
	if _, ok := depNone.Annotations[IdleDelayAnnotation]; ok {
		t.Fatalf("idle-delay annotation stamped for IdleDelayMs=0 (should be fleet default)")
	}
}

// Reconcile threads the validated per-app window (millis) into ApplyCompute.
func TestReconcile_StampsIdleDelayMillis(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{
		Name: "shop", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "shop", IdleDelay: dur(5 * time.Minute)},
	}
	mustReconcile(t, h, cr)
	if len(h.cl.applied) == 0 {
		t.Fatal("compute not applied")
	}
	last := h.cl.applied[len(h.cl.applied)-1]
	if last.IdleDelayMs != 300000 {
		t.Fatalf("ComputeSpec.IdleDelayMs = %d, want 300000 (5m)", last.IdleDelayMs)
	}

	// nil idleDelay ⇒ 0 (fleet default).
	h2 := newHarness()
	cr2 := &AppDatabase{Name: "shop2", Namespace: "scale-zero-pg", Generation: 1, Spec: AppDatabaseSpec{AppName: "shop2"}}
	mustReconcile(t, h2, cr2)
	last2 := h2.cl.applied[len(h2.cl.applied)-1]
	if last2.IdleDelayMs != 0 {
		t.Fatalf("ComputeSpec.IdleDelayMs = %d, want 0 for nil idleDelay", last2.IdleDelayMs)
	}
}

// ApplyCompute against a real K8sCluster (fake clientset): the idle-delay
// annotation is set on the live Deployment's metadata on update, cleared when the
// window is withdrawn, and a co-located (operator/GitOps) annotation survives both.
func TestApplyCompute_ReconcilesIdleDelayAnnotation(t *testing.T) {
	k := newTestCluster()
	ctx := context.Background()

	// Create with a per-app window.
	if err := k.ApplyCompute(ctx, ComputeSpec{App: "shop", TenantID: "t", TimelineID: "tl", Quotas: DefaultQuotas, IdleDelayMs: 300000}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	dep, _ := k.cs.AppsV1().Deployments("scale-zero-pg").Get(ctx, "compute-shop", metav1.GetOptions{})
	if dep.Annotations[IdleDelayAnnotation] != "300000" {
		t.Fatalf("annotation on create = %q, want 300000", dep.Annotations[IdleDelayAnnotation])
	}
	// Simulate a co-located annotation added out-of-band.
	dep.Annotations["example.com/owner"] = "keepme"
	if _, err := k.cs.AppsV1().Deployments("scale-zero-pg").Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("seed annotation: %v", err)
	}

	// Update to a new window: the value changes, the co-located annotation survives.
	if err := k.ApplyCompute(ctx, ComputeSpec{App: "shop", TenantID: "t", TimelineID: "tl", Quotas: DefaultQuotas, IdleDelayMs: 60000}); err != nil {
		t.Fatalf("apply update: %v", err)
	}
	dep, _ = k.cs.AppsV1().Deployments("scale-zero-pg").Get(ctx, "compute-shop", metav1.GetOptions{})
	if dep.Annotations[IdleDelayAnnotation] != "60000" {
		t.Fatalf("annotation on update = %q, want 60000", dep.Annotations[IdleDelayAnnotation])
	}
	if dep.Annotations["example.com/owner"] != "keepme" {
		t.Fatalf("co-located annotation clobbered: %v", dep.Annotations)
	}

	// Withdraw (idleDelay ⇒ nil ⇒ IdleDelayMs 0): the key is cleared, others kept.
	if err := k.ApplyCompute(ctx, ComputeSpec{App: "shop", TenantID: "t", TimelineID: "tl", Quotas: DefaultQuotas, IdleDelayMs: 0}); err != nil {
		t.Fatalf("apply withdraw: %v", err)
	}
	dep, _ = k.cs.AppsV1().Deployments("scale-zero-pg").Get(ctx, "compute-shop", metav1.GetOptions{})
	if _, ok := dep.Annotations[IdleDelayAnnotation]; ok {
		t.Fatalf("idle-delay annotation not cleared on withdrawal: %v", dep.Annotations)
	}
	if dep.Annotations["example.com/owner"] != "keepme" {
		t.Fatalf("co-located annotation clobbered on withdrawal: %v", dep.Annotations)
	}
}
