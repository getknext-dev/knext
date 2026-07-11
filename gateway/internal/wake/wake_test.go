package wake

import (
	"context"
	"strings"
	"testing"
)

// Wake/Sleep in template mode must scale the per-app Deployment (compute-<db>),
// NOT a single shared Deployment — that is the whole point of branch-per-app.
// (fakeScaler + scaleCall are defined in ro_test.go, same package.)
func TestTemplateDriverWakeSleepScalesPerSystemDeployment(t *testing.T) {
	rec := &fakeScaler{}
	d, err := MakeDriverWithScaler(Env{
		"GW_COMPUTE_MODE":            "template",
		"GW_K8S_NAMESPACE":           "scale-zero-pg",
		"GW_K8S_DEPLOYMENT_TEMPLATE": "compute-{system}",
	}, rec)
	if err != nil {
		t.Fatalf("MakeDriverWithScaler: %v", err)
	}
	tgt := d.Resolve("orders")
	if err := d.Wake(context.Background(), tgt); err != nil {
		t.Fatalf("Wake: %v", err)
	}
	if err := d.Sleep(context.Background(), tgt); err != nil {
		t.Fatalf("Sleep: %v", err)
	}
	if !d.CanSleep() {
		t.Fatalf("template driver must be able to sleep per-app computes")
	}
	want := []scaleCall{
		{"scale-zero-pg", "compute-orders", 1},
		{"scale-zero-pg", "compute-orders", 0},
	}
	if len(rec.calls) != len(want) {
		t.Fatalf("scale calls = %+v, want %+v", rec.calls, want)
	}
	for i := range want {
		if rec.calls[i] != want[i] {
			t.Fatalf("scale call[%d] = %+v, want %+v", i, rec.calls[i], want[i])
		}
	}
}

// A deployment template with no {system} placeholder collapses every app onto
// one Deployment — a silent single-writer-violating misconfig. Reject it early.
func TestTemplateModeRejectsDeploymentTemplateWithoutSystemPlaceholder(t *testing.T) {
	_, err := MakeDriverWithScaler(Env{
		"GW_COMPUTE_MODE":            "template",
		"GW_K8S_DEPLOYMENT_TEMPLATE": "compute", // missing {system}
	}, &fakeScaler{})
	if err == nil || !strings.Contains(err.Error(), "{system}") {
		t.Fatalf("err = %v, want error mentioning {system}", err)
	}
}

// Equal app/repl role prefixes collapse the per-app auth role (app_<db>) and the
// per-zone REPLICATION role (repl_<db>) into ONE name — a replication credential
// would then satisfy an ordinary tenant connection and vice versa, destroying the
// role separation authz.go relies on. Defaults differ (app_/repl_), but an
// operator misconfig must fail loud at startup, not silently collapse (#141).
func TestTemplateModeRejectsEqualAppAndReplRolePrefixes(t *testing.T) {
	_, err := MakeDriverWithScaler(Env{
		"GW_COMPUTE_MODE":            "template",
		"GW_K8S_DEPLOYMENT_TEMPLATE": "compute-{system}",
		"GW_APP_ROLE_PREFIX":         "role_",
		"GW_REPL_ROLE_PREFIX":        "role_", // equal -> must be rejected
	}, &fakeScaler{})
	if err == nil || !strings.Contains(err.Error(), "GW_APP_ROLE_PREFIX") ||
		!strings.Contains(err.Error(), "GW_REPL_ROLE_PREFIX") {
		t.Fatalf("err = %v, want error naming both role prefix env vars", err)
	}
}

// The safe defaults (app_ vs repl_) — and any other distinct pair — must still
// construct cleanly, so the guard never rejects a well-formed config.
func TestTemplateModeAcceptsDistinctRolePrefixes(t *testing.T) {
	if _, err := MakeDriverWithScaler(Env{
		"GW_COMPUTE_MODE":            "template",
		"GW_K8S_DEPLOYMENT_TEMPLATE": "compute-{system}",
	}, &fakeScaler{}); err != nil {
		t.Fatalf("default distinct prefixes must construct: %v", err)
	}
}

func TestParseHostPort(t *testing.T) {
	if h, p := ParseHostPort("db", 5432); h != "db" || p != 5432 {
		t.Fatalf("ParseHostPort(db) = %s:%d, want db:5432", h, p)
	}
	if h, p := ParseHostPort("db:6432", 5432); h != "db" || p != 6432 {
		t.Fatalf("ParseHostPort(db:6432) = %s:%d, want db:6432", h, p)
	}
}

func TestStaticDriverResolvesFixedTargetCannotSleep(t *testing.T) {
	d, err := MakeDriver(Env{"GW_COMPUTE_MODE": "static", "GW_TARGET": "pg.local:5433"})
	if err != nil {
		t.Fatalf("MakeDriver err=%v", err)
	}
	got := d.Resolve("anything")
	if got != (Target{Host: "pg.local", Port: 5433, Key: "static"}) {
		t.Fatalf("resolve = %+v, want pg.local:5433 key=static", got)
	}
	if d.CanSleep() {
		t.Fatalf("static driver CanSleep = true, want false")
	}
}

func TestExecDriverCanSleepOnlyWithSleepCmd(t *testing.T) {
	d1, err := MakeDriver(Env{"GW_COMPUTE_MODE": "exec", "GW_TARGET": "x:1", "GW_WAKE_CMD": "true"})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if d1.CanSleep() {
		t.Fatalf("exec without sleep cmd CanSleep = true, want false")
	}
	d2, err := MakeDriver(Env{"GW_COMPUTE_MODE": "exec", "GW_TARGET": "x:1", "GW_WAKE_CMD": "true", "GW_SLEEP_CMD": "true"})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if !d2.CanSleep() {
		t.Fatalf("exec with sleep cmd CanSleep = false, want true")
	}
}

func TestKubectlDriverDefaultsTargetToServiceDNS(t *testing.T) {
	d, err := MakeDriver(Env{"GW_COMPUTE_MODE": "kubectl", "GW_K8S_NAMESPACE": "db", "GW_K8S_DEPLOYMENT": "compute"})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	got := d.Resolve("ignored")
	if got != (Target{Host: "compute.db.svc", Port: 55432, Key: "db/compute"}) {
		t.Fatalf("resolve = %+v, want compute.db.svc:55432 key=db/compute", got)
	}
	if !d.CanSleep() {
		t.Fatalf("kubectl CanSleep = false, want true")
	}
}

func TestTemplateDriverMapsDatabaseNameToPerSystemTarget(t *testing.T) {
	d, err := MakeDriver(Env{"GW_COMPUTE_MODE": "template", "GW_TARGET_TEMPLATE": "compute-{system}.db.svc:5432"})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	got := d.Resolve("orders")
	if got != (Target{Host: "compute-orders.db.svc", Port: 5432, Key: "orders"}) {
		t.Fatalf("resolve = %+v, want compute-orders.db.svc:5432 key=orders", got)
	}
}

func TestUnknownModeThrows(t *testing.T) {
	_, err := MakeDriver(Env{"GW_COMPUTE_MODE": "nope"})
	if err == nil || !strings.Contains(err.Error(), "unknown GW_COMPUTE_MODE") {
		t.Fatalf("err = %v, want unknown GW_COMPUTE_MODE", err)
	}
}

// EnvFromOS must pass through every GW_* variable — a whitelist here silently
// reverts tuning knobs (GW_IDLE_MS etc.) to their defaults in production.
func TestEnvFromOSIncludesAllGWKeys(t *testing.T) {
	t.Setenv("GW_IDLE_MS", "60000")
	t.Setenv("GW_WAKE_TIMEOUT_MS", "120000")
	t.Setenv("GW_CONNECT_TIMEOUT_MS", "1500")
	t.Setenv("GW_RETRY_MS", "100")
	t.Setenv("GW_COMPUTE_MODE", "static")
	env := EnvFromOS()
	for k, want := range map[string]string{
		"GW_IDLE_MS":            "60000",
		"GW_WAKE_TIMEOUT_MS":    "120000",
		"GW_CONNECT_TIMEOUT_MS": "1500",
		"GW_RETRY_MS":           "100",
		"GW_COMPUTE_MODE":       "static",
	} {
		if got := env[k]; got != want {
			t.Errorf("EnvFromOS()[%s] = %q, want %q", k, got, want)
		}
	}
}
