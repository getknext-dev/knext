package wake

import (
	"context"
	"testing"
)

// fakeScaler records Scale calls so wake/sleep replica math is asserted without
// a cluster.
type fakeScaler struct{ calls []scaleCall }

type scaleCall struct {
	ns, dep  string
	replicas int32
}

func (f *fakeScaler) Scale(_ context.Context, ns, dep string, r int32) error {
	f.calls = append(f.calls, scaleCall{ns, dep, r})
	return nil
}

// ROEnv must remap the RO-pool GW_RO_* knobs onto a kubectl driver pointed at
// the read-only compute Deployment/Service — a second, independent routing lane.
func TestROEnvMapsToKubectlComputeRODeployment(t *testing.T) {
	base := Env{"GW_COMPUTE_MODE": "kubectl", "GW_K8S_NAMESPACE": "scale-zero-pg", "GW_RO_PORT": "55434"}
	d, err := MakeDriver(ROEnv(base))
	if err != nil {
		t.Fatalf("MakeDriver(ROEnv) err=%v", err)
	}
	if d.Mode() != "kubectl" {
		t.Fatalf("RO driver mode = %s, want kubectl", d.Mode())
	}
	got := d.Resolve("ignored")
	want := Target{Host: "compute-ro.scale-zero-pg.svc", Port: 55432, Key: "scale-zero-pg/compute-ro"}
	if got != want {
		t.Fatalf("RO resolve = %+v, want %+v", got, want)
	}
	if !d.CanSleep() {
		t.Fatalf("RO driver CanSleep = false, want true (idle scales the pool to 0)")
	}
}

// Wake scales the RO pool to GW_WAKE_REPLICAS (0->N), Sleep back to 0 — this is
// the whole RO lifecycle. HPA (if applied) manages N>wake between those bounds.
func TestKubeDriverWakeScalesToConfiguredReplicas(t *testing.T) {
	fs := &fakeScaler{}
	d, err := MakeDriverWithScaler(ROEnv(Env{
		"GW_COMPUTE_MODE": "kubectl", "GW_K8S_NAMESPACE": "db", "GW_RO_WAKE_REPLICAS": "3",
	}), fs)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	tgt := d.Resolve("x")
	if err := d.Wake(context.Background(), tgt); err != nil {
		t.Fatalf("Wake err=%v", err)
	}
	if err := d.Sleep(context.Background(), tgt); err != nil {
		t.Fatalf("Sleep err=%v", err)
	}
	if len(fs.calls) != 2 {
		t.Fatalf("scaler calls = %d, want 2 (wake+sleep)", len(fs.calls))
	}
	if got := fs.calls[0]; got != (scaleCall{"db", "compute-ro", 3}) {
		t.Fatalf("wake scale = %+v, want db/compute-ro=3", got)
	}
	if got := fs.calls[1]; got != (scaleCall{"db", "compute-ro", 0}) {
		t.Fatalf("sleep scale = %+v, want db/compute-ro=0", got)
	}
}

// The writer path must be unchanged: absent GW_WAKE_REPLICAS, a kubectl driver
// wakes to exactly 1 (single-writer).
func TestKubeDriverDefaultsWakeToOneReplica(t *testing.T) {
	fs := &fakeScaler{}
	d, err := MakeDriverWithScaler(Env{
		"GW_COMPUTE_MODE": "kubectl", "GW_K8S_NAMESPACE": "db", "GW_K8S_DEPLOYMENT": "compute",
	}, fs)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if err := d.Wake(context.Background(), d.Resolve("x")); err != nil {
		t.Fatalf("Wake err=%v", err)
	}
	if got := fs.calls[0]; got != (scaleCall{"db", "compute", 1}) {
		t.Fatalf("writer wake scale = %+v, want db/compute=1", got)
	}
}

// Primary and RO drivers must resolve to DISTINCT targets so the two DSNs never
// cross-route (writes to the writer, reads to the pool).
func TestPrimaryAndROResolveDistinctTargets(t *testing.T) {
	base := Env{"GW_COMPUTE_MODE": "kubectl", "GW_K8S_NAMESPACE": "scale-zero-pg", "GW_K8S_DEPLOYMENT": "compute"}
	primary, _ := MakeDriver(base)
	ro, _ := MakeDriver(ROEnv(base))
	p, r := primary.Resolve("db"), ro.Resolve("db")
	if p.Host == r.Host || p.Key == r.Key {
		t.Fatalf("primary %+v and RO %+v must differ", p, r)
	}
}

// A dedicated GW_RO_IDLE_MS overrides the shared GW_IDLE_MS so the RO pool can
// hold longer (or shorter) than the writer.
func TestROEnvIdleOverride(t *testing.T) {
	got := ROEnv(Env{"GW_IDLE_MS": "300000", "GW_RO_IDLE_MS": "600000"})
	if got["GW_IDLE_MS"] != "600000" {
		t.Fatalf("ROEnv GW_IDLE_MS = %q, want 600000 (RO override)", got["GW_IDLE_MS"])
	}
}
