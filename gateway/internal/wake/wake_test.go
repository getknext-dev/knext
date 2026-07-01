package wake

import (
	"strings"
	"testing"
)

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
