package pswatcher

import (
	"context"
	"errors"
	"testing"
	"time"
)

// D1 — the reconciling standby-warm loop (re-arm-after-failover, ADR-0010 §5).
//
// The one-shot warm Job leaves the plane DISARMED the moment the first failover
// succeeds: the promoted standby is now primary, and the rebuilt ex-primary is an
// empty standby that nobody re-warms. This loop keeps the CURRENT standby registered
// as a warm Secondary for every routed tenant, continuously.
//
// The critical guard the loop must never violate: registering a Secondary on the node
// the client Service currently selects (the live PRIMARY) DEMOTES the writer. So the
// standby is resolved as the node the client Service does NOT select, and warm PUTs
// target ONLY that node.

const (
	primaryNodeURL = "http://pageserver-primary:9898"
	standbyNodeURL = "http://pageserver-standby:9898"
	appsTenant     = "a0000000000000000000000000000001"
)

type warmCall struct{ baseURL, tenant string }

// fakeWarmer records every warm-Secondary registration by the node it targeted.
type fakeWarmer struct {
	calls []warmCall
	err   error
}

func (f *fakeWarmer) WarmSecondary(_ context.Context, baseURL, tenant string) error {
	f.calls = append(f.calls, warmCall{baseURL, tenant})
	return f.err
}

// fakeMembershipAt models the plane-wide /v1/location_config listing at an EXPLICIT
// node URL — the reconcile must probe whichever node is currently the standby, which
// swaps after a failover, so it cannot use the fixed-URL failover oracle.
type fakeMembershipAt struct {
	held map[string]map[string]bool // baseURL -> tenant -> held
	err  error
}

func (f *fakeMembershipAt) HoldsTenantAt(_ context.Context, baseURL, tenant string) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	return f.held[baseURL][tenant], nil
}

func warmTargetsMap() map[string]string {
	return map[string]string{
		"pageserver":         primaryNodeURL,
		"pageserver-standby": standbyNodeURL,
	}
}

// newWarmController wires a controller for the standby-warm reconcile with the real
// two-node topology and a routed set of {base, apps}.
func newWarmController(k *fakeK8s, w *fakeWarmer, m *fakeMembershipAt) *Controller {
	c := NewController(&toggleProber{alive: true}, &toggleProber{alive: true}, &fakePromoter{}, k, Config{
		Tenant:        "f0f0",
		Tenants:       []string{"f0f0", appsTenant},
		ClientService: "pageserver",
		StandbyApp:    "pageserver-standby",
		WarmTargets:   warmTargetsMap(),
		WarmInterval:  0,
	}, NewMetrics())
	c.SetStandbyWarmer(w, m)
	return c
}

// At rest the client Service selects the PRIMARY (app=pageserver). The warm reconcile
// must register Secondaries ONLY on the standby node (pageserver-standby), NEVER on the
// live primary (pageserver-primary) — that would demote the writer.
func TestReconcileStandbyWarmNeverWarmsThePrimary(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{}} // standby holds nothing yet
	c := newWarmController(k, w, m)

	if err := c.reconcileStandbyWarm(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(w.calls) == 0 {
		t.Fatal("expected the standby to be warmed for the routed tenants")
	}
	for _, call := range w.calls {
		if call.baseURL == primaryNodeURL {
			t.Fatalf("NEVER-DEMOTE GUARD VIOLATED: registered a warm Secondary on the live PRIMARY %s (tenant %s) — this demotes the writer", call.baseURL, call.tenant)
		}
		if call.baseURL != standbyNodeURL {
			t.Fatalf("warmed an unexpected node %s, want the standby %s", call.baseURL, standbyNodeURL)
		}
	}
	if len(w.calls) != 2 {
		t.Fatalf("warmed %d tenants, want 2 (base + apps)", len(w.calls))
	}
}

// The D1 core: after a failover the client Service selects the PROMOTED standby
// (app=pageserver-standby). The rebuilt ex-primary (app=pageserver, reachable at
// pageserver-primary) is the NEW empty standby nobody re-warms — the reconcile must
// re-arm IT, and must NOT touch pageserver-standby, which is now the live primary.
func TestReconcileStandbyWarmReArmsRebuiltExPrimaryAfterFailover(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver-standby"} // post-failover: standby is now primary
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{}} // the rebuilt ex-primary holds nothing
	c := newWarmController(k, w, m)

	if err := c.reconcileStandbyWarm(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(w.calls) != 2 {
		t.Fatalf("warmed %d tenants, want 2 re-armed on the rebuilt ex-primary", len(w.calls))
	}
	for _, call := range w.calls {
		if call.baseURL == standbyNodeURL {
			t.Fatalf("NEVER-DEMOTE GUARD VIOLATED: registered a warm Secondary on %s, which the client Service now selects (the PROMOTED primary) — this demotes the live writer", call.baseURL)
		}
		if call.baseURL != primaryNodeURL {
			t.Fatalf("warmed %s, want the rebuilt ex-primary %s", call.baseURL, primaryNodeURL)
		}
	}
}

// A standby already holding every routed tenant is a no-op, and the loss-of-warmth
// gauge reads 1 for each held tenant.
func TestReconcileStandbyWarmNoOpWhenAlreadyWarm(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{
		standbyNodeURL: {"f0f0": true, appsTenant: true},
	}}
	c := newWarmController(k, w, m)

	if err := c.reconcileStandbyWarm(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(w.calls) != 0 {
		t.Fatalf("re-warmed an already-warm standby: %v", w.calls)
	}
	if g := c.Metrics().TenantWarm("f0f0"); g != 1 {
		t.Fatalf("standby_tenant_warm{f0f0}=%d, want 1", g)
	}
	if g := c.Metrics().TenantWarm(appsTenant); g != 1 {
		t.Fatalf("standby_tenant_warm{apps}=%d, want 1", g)
	}
}

// Loss of warmth must be observable: an unreadable standby membership surfaces an
// error, increments the error counter, and drives the per-tenant gauge to 0.
func TestReconcileStandbyWarmLossOfWarmthIsObservable(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{err: errors.New("standby unreachable")}
	c := newWarmController(k, w, m)

	if err := c.reconcileStandbyWarm(context.Background()); err == nil {
		t.Fatal("an unreadable standby membership must surface an error")
	}
	if c.Metrics().StandbyWarmErrors() == 0 {
		t.Fatal("standby_warm_errors_total must count an unreadable membership")
	}
	if g := c.Metrics().TenantWarm("f0f0"); g != 0 {
		t.Fatalf("standby_tenant_warm{f0f0}=%d, want 0 (loss-of-warmth observable)", g)
	}
}

// A warm-registration failure must NOT be silent: it errors, counts, and leaves the
// gauge at 0.
func TestReconcileStandbyWarmRegistrationFailureIsLoud(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{err: errors.New("pageserver 500")}
	m := &fakeMembershipAt{held: map[string]map[string]bool{}} // needs warming
	c := newWarmController(k, w, m)

	if err := c.reconcileStandbyWarm(context.Background()); err == nil {
		t.Fatal("a failed warm registration must surface an error")
	}
	if c.Metrics().StandbyWarmErrors() == 0 {
		t.Fatal("standby_warm_errors_total must count a failed registration")
	}
	if g := c.Metrics().TenantWarm("f0f0"); g != 0 {
		t.Fatalf("standby_tenant_warm{f0f0}=%d, want 0 after a failed registration", g)
	}
}

// The never-demote guard when the primary is unresolvable: a client-Service selector
// that names no known pageserver node means we cannot tell which node is primary, so
// warming ANY node risks the live writer — the reconcile must abort and warm nothing.
func TestReconcileStandbyWarmAbortsWhenPrimaryUnresolvable(t *testing.T) {
	for _, sel := range []string{"", "something-else"} {
		k := &fakeK8s{selectorApp: sel}
		w := &fakeWarmer{}
		m := &fakeMembershipAt{held: map[string]map[string]bool{}}
		c := newWarmController(k, w, m)
		if err := c.reconcileStandbyWarm(context.Background()); err == nil {
			t.Fatalf("selector %q: an unresolvable primary must abort the warm reconcile", sel)
		}
		if len(w.calls) != 0 {
			t.Fatalf("selector %q: warmed a node despite an unresolvable primary: %v", sel, w.calls)
		}
		if c.Metrics().StandbyWarmErrors() == 0 {
			t.Fatalf("selector %q: an aborted reconcile must count an error", sel)
		}
	}
}

// A read error from the client Service selector aborts too — the guard cannot resolve
// the primary, so it refuses to warm rather than risk the writer.
func TestReconcileStandbyWarmAbortsWhenSelectorUnreadable(t *testing.T) {
	k := &fakeK8s{getSelErr: errors.New("api server down")}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{}}
	c := newWarmController(k, w, m)
	if err := c.reconcileStandbyWarm(context.Background()); err == nil {
		t.Fatal("an unreadable client Service selector must abort the warm reconcile")
	}
	if len(w.calls) != 0 {
		t.Fatalf("warmed a node despite an unreadable selector: %v", w.calls)
	}
}

// Tick must drive the reconcile — it is not enough to have the method; the loop has to
// call it, on the healthy path, so the standby stays warm during normal operation.
func TestTickDrivesStandbyWarmReconcile(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: true}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{}}
	c := newWarmController(k, w, m)

	if _, err := c.Tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if len(w.calls) == 0 {
		t.Fatal("Tick did not drive the standby-warm reconcile")
	}
	if c.Metrics().StandbyWarmReconciles() == 0 {
		t.Fatal("Tick did not count a standby-warm reconcile")
	}
}

// The reconcile is throttled by WarmInterval so it does not hammer the standby every
// poll, while still re-arming within one interval of a failover.
func TestStandbyWarmRespectsInterval(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{}}
	c := newWarmController(k, w, m)
	c.cfg.WarmInterval = time.Minute
	base := time.Now()

	c.SetClock(func() time.Time { return base })
	c.maybeReconcileStandbyWarm(context.Background())
	first := len(w.calls)
	if first == 0 {
		t.Fatal("first reconcile should run")
	}

	c.SetClock(func() time.Time { return base.Add(30 * time.Second) })
	c.maybeReconcileStandbyWarm(context.Background())
	if len(w.calls) != first {
		t.Fatalf("reconcile ran again before the interval elapsed (calls %d -> %d)", first, len(w.calls))
	}

	c.SetClock(func() time.Time { return base.Add(2 * time.Minute) })
	c.maybeReconcileStandbyWarm(context.Background())
	if len(w.calls) == first {
		t.Fatal("reconcile did not run after the interval elapsed")
	}
}

// An unwired warm loop is a no-op — back-compat for planes/tests that do not configure
// it (the existing failover tests must be unaffected).
func TestStandbyWarmUnwiredIsNoOp(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	c := newController(&fakeProber{seq: []bool{true}, last: true}, &fakePromoter{}, k, 3)
	// no SetStandbyWarmer, no WarmTargets.
	c.maybeReconcileStandbyWarm(context.Background()) // must not panic
	if c.Metrics().StandbyWarmReconciles() != 0 {
		t.Fatal("an unwired warm loop must not count reconciles")
	}
}
