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
//
// It carries the MODE as well as membership: `held` is "listed in tenant_shards at
// all", `attached` is "listed with a location config object" (an ATTACHED location,
// not a warm Secondary). The distinction is the whole point of FIX 1 — an ex-primary
// that reloads its persisted AttachedSingle is LISTED, and a mode-blind reconcile
// reports that as "HA armed".
type fakeMembershipAt struct {
	held     map[string]map[string]bool // baseURL -> tenant -> listed at all
	attached map[string]map[string]bool // baseURL -> tenant -> listed as ATTACHED
	err      error
	// block makes the probe hang until the caller's context is cancelled (or 2s
	// elapses) — models a standby wedged on its object store.
	block bool
	// onProbe fires on every probe, so a test can observe WHEN the reconcile ran
	// relative to the rest of the tick.
	onProbe func()
}

func (f *fakeMembershipAt) HoldsTenantAt(ctx context.Context, baseURL, tenant string) (bool, bool, error) {
	if f.onProbe != nil {
		f.onProbe()
	}
	if f.block {
		select {
		case <-ctx.Done():
			return false, false, ctx.Err()
		case <-time.After(2 * time.Second):
			return false, false, errors.New("standby wedged (no deadline bounded this probe)")
		}
	}
	if f.err != nil {
		return false, false, f.err
	}
	return f.held[baseURL][tenant], f.attached[baseURL][tenant], nil
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

// FIX 1 (the BLOCK) — the gauge must be MODE-AWARE.
//
// The common failover variant keeps the PVC (53-pageserver.yaml retains it), so the
// ex-primary pod restarts and reloads its PERSISTED AttachedSingle at the OLD
// generation. It is then LISTED in /v1/location_config — so a membership-only read
// says "held", the reconcile skips the PUT, and the gauge publishes 1 = "HA armed".
// That is a FALSE GREEN and strictly weaker than the one-shot Job this loop replaces:
// an ATTACHED ex-primary is not a warm Secondary, and a failover onto it is exactly the
// split-brain/stale-generation case the plane must never reach.
//
// The gauge is therefore mode-aware; the WRITE stays mode-AGNOSTIC (a PUT only when the
// tenant is ABSENT) — see TestReconcileStandbyWarmNeverPutsSecondaryOntoAnAttachedNode.
func TestReconcileStandbyWarmAttachedStandbyIsNotWarm(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{
		held:     map[string]map[string]bool{standbyNodeURL: {"f0f0": true, appsTenant: true}},
		attached: map[string]map[string]bool{standbyNodeURL: {"f0f0": true, appsTenant: true}},
	}
	c := newWarmController(k, w, m)

	_ = c.reconcileStandbyWarm(context.Background())

	if g := c.Metrics().TenantWarm("f0f0"); g != 0 {
		t.Fatalf("standby_tenant_warm{f0f0}=%d, want 0: the standby holds the tenant ATTACHED (a stale ex-primary location), which is NOT a warm Secondary — publishing 1 here reports HA as armed when it is not", g)
	}
	if g := c.Metrics().TenantWarm(appsTenant); g != 0 {
		t.Fatalf("standby_tenant_warm{apps}=%d, want 0 for an ATTACHED (not Secondary) hold", g)
	}
	if c.Metrics().StandbyStaleAttachedCount() != 2 {
		t.Fatalf("standby_stale_attached_total=%d, want 2 — a stale ATTACHED hold on the standby must be counted, not silent", c.Metrics().StandbyStaleAttachedCount())
	}
	if len(w.calls) != 0 {
		t.Fatalf("PUT a Secondary onto a node holding the tenant ATTACHED: %v — that node may be the just-promoted writer in the promote-before-flip window, and the PUT would DEMOTE it", w.calls)
	}
}

// The write half stays MODE-AGNOSTIC, and that is load-bearing, not an oversight.
//
// In the promote-BEFORE-flip window the newly-promoted node is ATTACHED and the client
// Service has not been flipped to it yet, so resolveStandby resolves IT as the standby.
// A "mode-aware write" (PUT Secondary because the node is attached-not-secondary) would
// DEMOTE the new writer — reintroducing the outage this whole loop exists to avoid. So a
// held tenant NEVER produces a PUT, whatever its mode; only an ABSENT tenant does.
func TestReconcileStandbyWarmNeverPutsSecondaryOntoAnAttachedNode(t *testing.T) {
	// Mid-flip: the client Service still selects the OLD primary (app=pageserver), while
	// pageserver-standby has already been promoted and holds the tenants ATTACHED.
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{
		held:     map[string]map[string]bool{standbyNodeURL: {"f0f0": true, appsTenant: true}},
		attached: map[string]map[string]bool{standbyNodeURL: {"f0f0": true, appsTenant: true}},
	}
	c := newWarmController(k, w, m)

	_ = c.reconcileStandbyWarm(context.Background())

	for _, call := range w.calls {
		t.Fatalf("NEVER-DEMOTE GUARD VIOLATED: PUT a warm Secondary (tenant %s) onto %s, which holds that tenant ATTACHED — mid-flip that node is the just-promoted WRITER, and this demotes it", call.tenant, call.baseURL)
	}
}

// A standby that is ATTACHED for one tenant and ABSENT for another must still be warmed
// for the ABSENT one: the mode-awareness is a gauge/report change, it must not stop the
// loop doing its job for the tenants it CAN safely register.
func TestReconcileStandbyWarmStillWarmsAbsentTenantsAlongsideAnAttachedOne(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{
		held:     map[string]map[string]bool{standbyNodeURL: {"f0f0": true}},
		attached: map[string]map[string]bool{standbyNodeURL: {"f0f0": true}},
	}
	c := newWarmController(k, w, m)

	_ = c.reconcileStandbyWarm(context.Background())

	if len(w.calls) != 1 || w.calls[0].tenant != appsTenant {
		t.Fatalf("warm calls = %v, want exactly one for the ABSENT apps tenant", w.calls)
	}
}

// The gauge must DROP, not latch: a tenant confirmed warm on one pass and unconfirmable
// on the next reads 0. A latched 1 is the silent-disarm failure mode.
func TestStandbyWarmGaugeDropsToZeroWhenWarmthIsLost(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{
		standbyNodeURL: {"f0f0": true, appsTenant: true},
	}}
	c := newWarmController(k, w, m)

	if err := c.reconcileStandbyWarm(context.Background()); err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	if g := c.Metrics().TenantWarm("f0f0"); g != 1 {
		t.Fatalf("standby_tenant_warm{f0f0}=%d after a confirmed warm pass, want 1", g)
	}

	m.err = errors.New("standby unreachable") // warmth can no longer be confirmed
	_ = c.reconcileStandbyWarm(context.Background())
	if g := c.Metrics().TenantWarm("f0f0"); g != 0 {
		t.Fatalf("standby_tenant_warm{f0f0}=%d, want 0 — the gauge LATCHED at its last-known-good value, so a standby that lost warmth reads as armed forever", g)
	}
}

// The ambiguity abort (>1 candidate standby). A three-node WarmTargets means the
// two-node topology assumption is violated and we cannot say which node is the standby —
// warming the wrong one could demote a writer, so the reconcile must refuse.
func TestResolveStandbyAbortsOnMoreThanOneCandidate(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{}}
	c := newWarmController(k, w, m)
	c.cfg.WarmTargets = map[string]string{
		"pageserver":         primaryNodeURL,
		"pageserver-standby": standbyNodeURL,
		"pageserver-third":   "http://pageserver-third:9898",
	}

	err := c.reconcileStandbyWarm(context.Background())
	if err == nil {
		t.Fatal("a >2-node topology must ABORT the reconcile — we cannot tell which node is the standby, and warming the wrong one can demote a writer")
	}
	if len(w.calls) != 0 {
		t.Fatalf("warmed a node despite an ambiguous topology: %v", w.calls)
	}
	if c.Metrics().StandbyWarmErrors() == 0 {
		t.Fatal("an ambiguity abort must be counted")
	}
}

// The collision guard (the belt-and-suspenders check). Two app labels pointing at the
// SAME node URL means the "standby" we resolved is reachable at the primary's address —
// a PUT there demotes the live writer. Refuse.
func TestResolveStandbyAbortsWhenStandbyURLCollidesWithThePrimary(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{}}
	c := newWarmController(k, w, m)
	// A copy-paste/templating slip: both node Services resolved to the same URL.
	c.cfg.WarmTargets = map[string]string{
		"pageserver":         primaryNodeURL,
		"pageserver-standby": primaryNodeURL,
	}

	err := c.reconcileStandbyWarm(context.Background())
	if err == nil {
		t.Fatal("a standby whose URL is the PRIMARY's URL must ABORT — warming it registers a Secondary on the live writer and demotes it")
	}
	if len(w.calls) != 0 {
		t.Fatalf("NEVER-DEMOTE GUARD VIOLATED: warmed %v, whose URL is the live primary's", w.calls)
	}
}

// FIX 2 (a) — the reconcile runs AFTER the failover-detection path, so a slow standby
// can never delay the promotion decided on the same tick.
func TestStandbyWarmRunsAfterFailoverDetection(t *testing.T) {
	prober := &fakeProber{seq: []bool{false, false, false}, last: false}
	promoter := &fakePromoter{}
	k := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{held: map[string]map[string]bool{}}
	c := NewController(prober, &toggleProber{alive: true}, promoter, k, Config{
		Tenant:          "f0f0",
		ClientService:   "pageserver",
		StandbyApp:      "pageserver-standby",
		ComputeSelector: "app=compute",
		PrimarySelector: "app=pageserver",
		FailThreshold:   3,
		BaseGeneration:  1,
		WarmTargets:     warmTargetsMap(),
	}, NewMetrics())
	c.SetStandbyMembershipViewer(allHeld{})
	c.SetStandbyWarmer(w, m)

	// Last-wins: the final observation is the one taken on the tick that promoted.
	promotionsWhenWarmed := -1
	m.onProbe = func() { promotionsWhenWarmed = len(promoter.calls) }

	for i := 0; i < 3; i++ {
		if _, err := c.Tick(context.Background()); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	if len(promoter.calls) == 0 {
		t.Fatal("setup: no promotion happened, so the ordering claim is vacuous")
	}
	if promotionsWhenWarmed != len(promoter.calls) {
		t.Fatalf("the standby-warm reconcile ran BEFORE the failover-detection path (it saw %d promotions, the tick performed %d in total) — a standby hung on its object store would then delay primary-death detection", promotionsWhenWarmed, len(promoter.calls))
	}
}

// FIX 2 (b) — the reconcile is DEADLINE-BOUNDED. A standby wedged on its object store
// must not hold the single control goroutine for a membership timeout per tenant.
func TestStandbyWarmReconcileIsDeadlineBounded(t *testing.T) {
	k := &fakeK8s{selectorApp: "pageserver"}
	w := &fakeWarmer{}
	m := &fakeMembershipAt{block: true} // hangs until the context is cancelled
	c := newWarmController(k, w, m)
	c.cfg.WarmDeadline = 30 * time.Millisecond

	start := time.Now()
	c.maybeReconcileStandbyWarm(context.Background())
	elapsed := time.Since(start)

	if elapsed > time.Second {
		t.Fatalf("the standby-warm reconcile took %v against a wedged standby — it is NOT bounded by WarmDeadline (%v), so a hung standby stretches every tick and delays primary-death detection", elapsed, c.cfg.WarmDeadline)
	}
	if c.Metrics().StandbyWarmErrors() == 0 {
		t.Fatal("a reconcile cut short by its deadline must COUNT an error — an unwarmed standby is never silent")
	}
	if g := c.Metrics().TenantWarm("f0f0"); g != 0 {
		t.Fatalf("standby_tenant_warm{f0f0}=%d, want 0 when warmth could not be confirmed", g)
	}
}

// FIX 3 — the reconcile is BEST-EFFORT: it can never abort the tick around it. A dead
// primary with a FAILING warm loop must still promote; turning the loop into a hard gate
// would convert "the standby is unreachable" into "HA is disabled".
func TestFailingStandbyWarmStillPromotesOnDeadPrimary(t *testing.T) {
	prober := &fakeProber{seq: []bool{false, false, false}, last: false}
	promoter := &fakePromoter{}
	k := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	w := &fakeWarmer{err: errors.New("pageserver 500")}
	m := &fakeMembershipAt{err: errors.New("standby unreachable")}
	c := NewController(prober, &toggleProber{alive: true}, promoter, k, Config{
		Tenant:          "f0f0",
		ClientService:   "pageserver",
		StandbyApp:      "pageserver-standby",
		ComputeSelector: "app=compute",
		PrimarySelector: "app=pageserver",
		FailThreshold:   3,
		BaseGeneration:  1,
		WarmTargets:     warmTargetsMap(),
	}, NewMetrics())
	c.SetStandbyMembershipViewer(allHeld{})
	c.SetStandbyWarmer(w, m)

	failedAt := -1
	for i := 0; i < 3; i++ {
		fo, err := c.Tick(context.Background())
		if err != nil {
			t.Fatalf("tick %d returned an error (%v) — a failing standby-warm reconcile must NEVER abort the failover tick", i, err)
		}
		if fo {
			failedAt = i
		}
	}
	if failedAt != 2 {
		t.Fatalf("failover happened at tick %d, want 2 — a failing standby-warm loop blocked the promotion (best-effort became a hard gate)", failedAt)
	}
	if len(k.flippedTo) != 1 || k.flippedTo[0] != "pageserver-standby" {
		t.Fatalf("selector flip = %v, want [pageserver-standby] despite the failing warm loop", k.flippedTo)
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
