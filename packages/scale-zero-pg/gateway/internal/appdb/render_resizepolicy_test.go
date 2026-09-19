package appdb

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

// resizePolicyOf returns the compute container's resizePolicy as a map keyed by the
// resource name, so an assertion can check both entries regardless of declaration order.
func resizePolicyOf(t *testing.T, ps corev1.PodSpec) map[corev1.ResourceName]corev1.ResourceResizeRestartPolicy {
	t.Helper()
	out := map[corev1.ResourceName]corev1.ResourceResizeRestartPolicy{}
	for _, rp := range computeContainer(t, ps).ResizePolicy {
		out[rp.ResourceName] = rp.RestartPolicy
	}
	return out
}

// TestRenderDeploymentEmitsResizePolicy is the #1108 fix guard: the per-app WRITER's
// compute container must declare the cpu+memory NotRequired resizePolicy the template
// carries (deploy/compute-app.template.yaml), so the writer-autoscaler grows/shrinks a
// per-app writer's CPU+memory IN PLACE (no restart) instead of restarting it — mirroring
// the template exactly. Mutation-proof: remove either entry from RenderDeployment and
// this reds.
func TestRenderDeploymentEmitsResizePolicy(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	dep := c.RenderDeployment(ComputeSpec{App: "parity", TenantID: "tenant", TimelineID: "timeline"})
	rp := resizePolicyOf(t, dep.Spec.Template.Spec)

	if got := rp[corev1.ResourceCPU]; got != corev1.NotRequired {
		t.Errorf("compute container cpu resizePolicy = %q, want %q (in-place vertical resize, no restart)", got, corev1.NotRequired)
	}
	if got := rp[corev1.ResourceMemory]; got != corev1.NotRequired {
		t.Errorf("compute container memory resizePolicy = %q, want %q (in-place vertical resize, no restart)", got, corev1.NotRequired)
	}
	if len(rp) != 2 {
		t.Errorf("compute container resizePolicy has %d entries, want exactly 2 (cpu, memory): %v", len(rp), rp)
	}
}

// TestRenderRODeploymentHasNoResizePolicy locks the RO decision for #1108: the per-app
// READ REPLICA does NOT carry resizePolicy. deploy/26-compute-ro.yaml (the only RO
// manifest) declares none, and RO computes are a RollingUpdate pool scaled horizontally
// by the apps-gateway RO lane / HPA (0<->N), not single-writer Recreate pods that resize
// vertically in place. Adding resizePolicy to the reader would be render<->template drift
// in the other direction. If the RO base manifest ever gains resizePolicy, revisit this.
func TestRenderRODeploymentHasNoResizePolicy(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")
	ro := c.RenderRODeployment(ROComputeSpec{App: "parity", TenantID: "tenant", TimelineID: "timeline"})
	if got := computeContainer(t, ro.Spec.Template.Spec).ResizePolicy; len(got) != 0 {
		t.Errorf("RO compute container should carry no resizePolicy (base manifest declares none; horizontally pool-scaled), got %v", got)
	}
}
