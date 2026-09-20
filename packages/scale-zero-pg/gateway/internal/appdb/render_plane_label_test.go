package appdb

import "testing"

// [T3 #1097] On pageserver failover the pswatcher bounces every compute that
// resolves through the flipped Service by the STABLE plane label plane=compute
// (not the per-app name app=compute-<app>). That bounce is only correct if EVERY
// operator-rendered compute carries plane=compute on its pod template — otherwise
// a per-app compute keeps talking to the dead pageserver. This guard proves the
// render path (RenderDeployment = per-app writer, RenderRODeployment = per-app RO)
// stamps plane=compute on BOTH the object and the pod template. Mutation-prove:
// drop "plane" from labelsFor/roLabelsFor and this goes red.
func TestRenderComputesCarryPlaneLabel(t *testing.T) {
	c := DefaultRenderConfig("scale-zero-pg")

	writer := c.RenderDeployment(ComputeSpec{App: "shop", TenantID: "t", TimelineID: "tl"})
	assertPlaneCompute(t, "per-app writer (RenderDeployment) object", writer.Labels)
	assertPlaneCompute(t, "per-app writer (RenderDeployment) pod template", writer.Spec.Template.Labels)
	// ...and the writer must NOT carry role=ro: that label is what the writer-only
	// consumers (backup slot floor, repl-slot monitor, writer autoscaler) exclude on,
	// so a writer wearing it drops out of its own WAL/slot protection silently.
	if role := writer.Spec.Template.Labels["role"]; role == "ro" {
		t.Errorf("per-app writer pod template carries role=%q — role: ro is the READER marker; a writer wearing it is excluded from the backup slot floor and the replication-slot monitor", role)
	}

	ro := c.RenderRODeployment(ROComputeSpec{App: "shop", TenantID: "t", TimelineID: "tl", MaxReplicas: 2})
	assertPlaneCompute(t, "per-app RO (RenderRODeployment) object", ro.Labels)
	assertPlaneCompute(t, "per-app RO (RenderRODeployment) pod template", ro.Spec.Template.Labels)
	// The RO compute is a reader: it must ALSO carry role=ro so the writer-only
	// consumers (writer-autoscaler, slot-janitor, backup) can exclude it via
	// plane=compute,role!=ro while the failover bounce (plane=compute) still hits it.
	if ro.Spec.Template.Labels["role"] != "ro" {
		t.Errorf("per-app RO pod template role = %q, want ro (writer-only consumers exclude it via role!=ro)", ro.Spec.Template.Labels["role"])
	}
}

func assertPlaneCompute(t *testing.T, what string, labels map[string]string) {
	t.Helper()
	if labels["plane"] != "compute" {
		t.Errorf("%s: plane label = %q, want compute — the failover bounce selector plane=compute would miss this compute", what, labels["plane"])
	}
}
