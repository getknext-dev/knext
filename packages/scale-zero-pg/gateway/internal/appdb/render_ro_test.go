package appdb

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
)

// The per-app RO Deployment (compute-ro-<app>) is the tenant-isolated read replica
// (#127). This locks the manifest contract so it never drifts from the proven
// deploy/26-compute-ro.yaml + compute-app.template.yaml patterns.
func TestRenderRODeploymentContract(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderRODeployment(ROComputeSpec{
		App: "shop", TenantID: "tenant-x", TimelineID: "timeline-y", MaxReplicas: 4,
	})

	if dep.Name != "compute-ro-shop" {
		t.Fatalf("name = %q, want compute-ro-shop", dep.Name)
	}
	// Read-only computes are NOT single-writer: RollingUpdate, never Recreate.
	if dep.Spec.Strategy.Type != appsv1.RollingUpdateDeploymentStrategyType {
		t.Errorf("strategy = %q, want RollingUpdate (RO pool is not single-writer)", dep.Spec.Strategy.Type)
	}
	// At rest 0 replicas — the apps-gateway RO lane scales it 0<->N.
	if dep.Spec.Replicas == nil || *dep.Spec.Replicas != 0 {
		t.Errorf("replicas = %v, want 0 (gateway-managed)", dep.Spec.Replicas)
	}
	ctr := dep.Spec.Template.Spec.Containers[0]
	// entrypoint-ro.sh (the read-only compute_ctl spec injection).
	if got := ctr.Command; len(got) < 2 || got[1] != "/compute-files/entrypoint-ro.sh" {
		t.Errorf("command = %v, want entrypoint-ro.sh", got)
	}
	// RO_MODE=Replica (tip-following hot standby).
	foundRO := false
	for _, e := range ctr.Env {
		if e.Name == "RO_MODE" && e.Value == "Replica" {
			foundRO = true
		}
	}
	if !foundRO {
		t.Errorf("RO_MODE=Replica env not set: %v", ctr.Env)
	}
	// Reuses the app's OWN per-app ConfigMap (compute-config-<app>) — the isolation
	// seam: the RO compute attaches to the app's own tenant+timeline.
	if got := ctr.EnvFrom[0].ConfigMapRef.Name; got != "compute-config-shop" {
		t.Errorf("envFrom configmap = %q, want compute-config-shop (per-app timeline)", got)
	}
	// ephemeral-storage sized for a loaded replica (#121): 2Gi req / 4Gi limit.
	req := ctr.Resources.Requests.StorageEphemeral()
	lim := ctr.Resources.Limits.StorageEphemeral()
	if req == nil || req.String() != "2Gi" {
		t.Errorf("ephemeral request = %v, want 2Gi (#121 no-evict)", req)
	}
	if lim == nil || lim.String() != "4Gi" {
		t.Errorf("ephemeral limit = %v, want 4Gi (#121 no-evict)", lim)
	}
	// wait-timeline + resolve-lsn initContainers.
	if len(dep.Spec.Template.Spec.InitContainers) != 2 {
		t.Errorf("want 2 initContainers (wait-timeline, resolve-lsn), got %d", len(dep.Spec.Template.Spec.InitContainers))
	}
}

// The per-app HPA is opt-in: rendered only when MaxReplicas>0 (posture B), nil
// otherwise (posture A: gateway-managed 0<->N).
func TestRenderROHPAOptIn(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")

	if hpa := c.RenderROHPA(ROComputeSpec{App: "a", MaxReplicas: 0}); hpa != nil {
		t.Errorf("MaxReplicas=0 must render NO HPA (posture A), got %v", hpa.Name)
	}
	hpa := c.RenderROHPA(ROComputeSpec{App: "a", MinReplicas: 2, MaxReplicas: 5})
	if hpa == nil {
		t.Fatalf("MaxReplicas>0 must render an HPA")
	}
	if hpa.Name != "compute-ro-a" || hpa.Spec.ScaleTargetRef.Name != "compute-ro-a" {
		t.Errorf("HPA must target compute-ro-a, got %q -> %q", hpa.Name, hpa.Spec.ScaleTargetRef.Name)
	}
	if hpa.Spec.MinReplicas == nil || *hpa.Spec.MinReplicas != 2 || hpa.Spec.MaxReplicas != 5 {
		t.Errorf("HPA bounds = [%v,%d], want [2,5]", hpa.Spec.MinReplicas, hpa.Spec.MaxReplicas)
	}
	// An HPA cannot floor at 0 — minReplicas is clamped to >=1.
	hpa0 := c.RenderROHPA(ROComputeSpec{App: "b", MinReplicas: 0, MaxReplicas: 3})
	if hpa0.Spec.MinReplicas == nil || *hpa0.Spec.MinReplicas != 1 {
		t.Errorf("HPA minReplicas must clamp to >=1, got %v", hpa0.Spec.MinReplicas)
	}
}
