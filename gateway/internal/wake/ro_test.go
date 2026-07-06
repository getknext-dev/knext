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
	// Default RO target must be port 55433 (where compute serves), NOT 55432
	// (issue #79): pointing the RO lane at 55432 silently dials the wrong port.
	want := Target{Host: "compute-ro.scale-zero-pg.svc", Port: 55433, Key: "scale-zero-pg/compute-ro"}
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

// ---- per-app RO lane on the apps-gateway (issue #127) -----------------------
//
// The apps-gateway is TEMPLATE mode. Its RO lane must ALSO be template mode so
// database=<app> reads route to THAT app's OWN read-only compute
// (compute-ro-<app>), never a single shared pool. ROEnv (kubectl, one fixed
// compute-ro) is the PRIMARY gateway's RO lane and is the cross-tenant trap here.

// appsBase mirrors the live apps-gateway env (deploy/81) closely enough to build
// a template driver with per-app authz.
func appsBase() Env {
	return Env{
		"GW_COMPUTE_MODE":            "template",
		"GW_K8S_NAMESPACE":           "scale-zero-pg",
		"GW_K8S_DEPLOYMENT_TEMPLATE": "compute-{system}",
		"GW_TARGET_TEMPLATE":         "compute-{system}.scale-zero-pg.svc:55433",
		"GW_APP_ROLE_PREFIX":         "app_",
		"GW_RESERVED_SYSTEMS":        "tmpl,warm,ro",
		"GW_RO_PORT":                 "55434",
	}
}

// ROTemplateEnv must stay in TEMPLATE mode and repoint the deployment/target
// templates at the per-app RO compute (compute-ro-{system}), so each app's reads
// land on its own RO compute.
func TestROTemplateEnvStaysTemplateMode(t *testing.T) {
	d, err := MakeDriver(ROTemplateEnv(appsBase()))
	if err != nil {
		t.Fatalf("MakeDriver(ROTemplateEnv) err=%v", err)
	}
	if d.Mode() != "template" {
		t.Fatalf("RO driver mode = %s, want template (per-app isolation)", d.Mode())
	}
}

// THE ISOLATION GUARANTEE (#127): app A's RO connection resolves to compute-ro-A;
// app B's to compute-ro-B. They NEVER share a target, and NEITHER is the shared
// primary pool "compute-ro".
func TestROTemplateEnvResolvesPerAppAndNeverCrosses(t *testing.T) {
	d, err := MakeDriver(ROTemplateEnv(appsBase()))
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	a := d.Resolve("appa")
	b := d.Resolve("appb")
	if a.Host != "compute-ro-appa.scale-zero-pg.svc" || a.Port != 55433 {
		t.Fatalf("appa RO resolve = %+v, want compute-ro-appa:55433", a)
	}
	if b.Host != "compute-ro-appb.scale-zero-pg.svc" {
		t.Fatalf("appb RO resolve = %+v, want compute-ro-appb host", b)
	}
	if a.Host == b.Host || a.Key == b.Key {
		t.Fatalf("app A %+v and app B %+v must NOT share an RO target (cross-tenant!)", a, b)
	}
	// Never the single shared primary pool.
	if a.Host == "compute-ro.scale-zero-pg.svc" || b.Host == "compute-ro.scale-zero-pg.svc" {
		t.Fatalf("per-app RO must never resolve to the shared primary compute-ro pool")
	}
}

// The RO lane keeps the SAME (user,database) tenant authz as the writer: app B's
// role can never read app A's database on the RO port.
func TestROTemplateEnvEnforcesTenantAuthz(t *testing.T) {
	d, err := MakeDriver(ROTemplateEnv(appsBase()))
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	az, ok := d.(interface {
		Authorize(user, database string) error
	})
	if !ok {
		t.Fatalf("RO template driver must implement Authorize (tenant boundary)")
	}
	if err := az.Authorize("app_appa", "appa"); err != nil {
		t.Fatalf("app A's own role must be authorized on its RO db: %v", err)
	}
	if az.Authorize("app_appb", "appa") == nil {
		t.Fatalf("cross-tenant: app B role reading app A's RO db MUST be refused")
	}
	if az.Authorize("cloud_admin", "appa") == nil {
		t.Fatalf("cloud_admin on the RO port MUST be refused")
	}
	if az.Authorize("app_ro", "ro") == nil {
		t.Fatalf("reserved system 'ro' MUST be refused on the RO port")
	}
}

// The RO compute serves the same physical database (postgres) as the writer, so
// the servedDatabase rewrite must be preserved on the RO lane.
func TestROTemplateEnvPreservesServedDatabase(t *testing.T) {
	d, err := MakeDriver(ROTemplateEnv(appsBase()))
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	sd, ok := d.(interface{ ServedDatabase() string })
	if !ok || sd.ServedDatabase() != "postgres" {
		t.Fatalf("RO template driver must serve postgres (got ok=%v)", ok)
	}
}

// Wake scales THIS app's RO compute (compute-ro-<app>) to GW_RO_WAKE_REPLICAS,
// Sleep back to 0 — per-app RO lifecycle. The writer template lane is unaffected.
func TestROTemplateEnvWakeScalesPerAppROCompute(t *testing.T) {
	fs := &fakeScaler{}
	base := appsBase()
	base["GW_RO_WAKE_REPLICAS"] = "2"
	d, err := MakeDriverWithScaler(ROTemplateEnv(base), fs)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	tgt := d.Resolve("shop")
	if err := d.Wake(context.Background(), tgt); err != nil {
		t.Fatalf("Wake err=%v", err)
	}
	if err := d.Sleep(context.Background(), tgt); err != nil {
		t.Fatalf("Sleep err=%v", err)
	}
	if len(fs.calls) != 2 {
		t.Fatalf("scaler calls = %d, want 2", len(fs.calls))
	}
	if got := fs.calls[0]; got != (scaleCall{"scale-zero-pg", "compute-ro-shop", 2}) {
		t.Fatalf("RO wake scale = %+v, want compute-ro-shop=2", got)
	}
	if got := fs.calls[1]; got != (scaleCall{"scale-zero-pg", "compute-ro-shop", 0}) {
		t.Fatalf("RO sleep scale = %+v, want compute-ro-shop=0", got)
	}
}

// The writer template lane must remain single-writer: absent GW_WAKE_REPLICAS it
// wakes to exactly 1, even now that template mode honors the knob.
func TestTemplateWriterWakesToOneReplica(t *testing.T) {
	fs := &fakeScaler{}
	d, err := MakeDriverWithScaler(appsBase(), fs) // writer lane (no GW_WAKE_REPLICAS)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if err := d.Wake(context.Background(), d.Resolve("shop")); err != nil {
		t.Fatalf("Wake err=%v", err)
	}
	if got := fs.calls[0]; got != (scaleCall{"scale-zero-pg", "compute-shop", 1}) {
		t.Fatalf("writer wake scale = %+v, want compute-shop=1 (single-writer)", got)
	}
}
