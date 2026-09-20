package pswatcher

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// D3 — pswatcher_failover_armed composite gauge + pswatcher_failover_aborted_total{reason}.
// The gauge answers "would HA promote if the primary died right now?" from already-gathered
// state; the counter names WHY a would-be failover that entered failover() did not complete.

// The pure verdict is the mutation target: freeze suppresses, an empty routed set is NOT
// armed (safe default), and EVERY routed tenant must be warm.
func TestFailoverArmedVerdict(t *testing.T) {
	warmAll := func(string) bool { return true }
	warmNone := func(string) bool { return false }
	routed := []string{"f0f0-base", "a000-apps"}

	cases := []struct {
		name   string
		frozen bool
		routed []string
		warm   func(string) bool
		want   bool
	}{
		{"all warm, not frozen -> armed", false, routed, warmAll, true},
		{"frozen -> not armed even if all warm", true, routed, warmAll, false},
		{"empty routed set -> not armed (safe default)", false, nil, warmAll, false},
		{"none warm -> not armed", false, routed, warmNone, false},
		{"one cold tenant -> not armed", false, routed, func(t string) bool { return t == "f0f0-base" }, false},
		{"single warm tenant -> armed", false, []string{"only"}, warmAll, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := failoverArmed(tc.frozen, tc.routed, tc.warm); got != tc.want {
				t.Fatalf("failoverArmed(frozen=%v, routed=%v) = %v, want %v", tc.frozen, tc.routed, got, tc.want)
			}
		})
	}
}

func TestClassifyFailoverAbort(t *testing.T) {
	if got := classifyFailoverAbort(fmt.Errorf("wrap: %w", ErrLedgerConflict)); got != "ledger_cas_lost" {
		t.Fatalf("a wrapped ErrLedgerConflict must classify as ledger_cas_lost, got %q", got)
	}
	if got := classifyFailoverAbort(errors.New("some other abort")); got != "aborted" {
		t.Fatalf("a non-CAS abort must classify as aborted, got %q", got)
	}
}

// The gauge is PUBLISHED every tick from freeze + the reconcile's per-tenant warmth: a
// healthy tick with every routed tenant warm reads 1; a maintenance freeze forces 0.
func TestTickPublishesFailoverArmedGauge(t *testing.T) {
	routed := []string{"f0f0-base", "a000-apps"}

	// armed: primary healthy, no freeze, all routed tenants pre-warmed.
	primary := &toggleProber{alive: true}
	standby := &toggleProber{alive: true}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 3, genSet: true, genRV: "5", primaryPresent: true, primaryReady: true}
	c := newControllerRouted(primary, standby, &fakePromoter{}, k8s, 1, routed)
	for _, tn := range routed {
		c.Metrics().SetTenantWarm(tn, true)
	}
	if _, err := c.Tick(context.Background()); err != nil {
		t.Fatalf("healthy tick: %v", err)
	}
	if got := c.Metrics().FailoverArmed(); got != 1 {
		t.Fatalf("all tenants warm + healthy + unfrozen must publish failover_armed=1, got %d", got)
	}

	// frozen: same warmth, but a live maintenance freeze forces the gauge to 0.
	now := time.Now()
	k8sF := &fakeK8s{
		selectorApp: "pageserver", gen: 3, genSet: true, genRV: "5",
		primaryPresent: true, primaryReady: true,
		freezePresent: true, freezeUntil: now.Add(10 * time.Minute), freezeCreatedAt: now,
	}
	cf := newControllerRouted(primary, standby, &fakePromoter{}, k8sF, 1, routed)
	for _, tn := range routed {
		cf.Metrics().SetTenantWarm(tn, true)
	}
	if _, err := cf.Tick(context.Background()); err != nil {
		t.Fatalf("frozen tick: %v", err)
	}
	if got := cf.Metrics().FailoverArmed(); got != 0 {
		t.Fatalf("a live maintenance freeze must publish failover_armed=0 despite warmth, got %d", got)
	}
}

// A failover that ENTERS failover() and aborts on a lost ledger CAS is counted by cause.
func TestFailoverAbortCounterLabelsLostCAS(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true, genRV: "77",
		primaryPresent: true, primaryReady: false,
		setGenErr: ErrLedgerConflict,
	}
	c := newControllerRouted(primary, standby, &fakePromoter{}, k8s, 1, []string{"f0f0-base", "a000-apps"})

	if _, err := c.Tick(context.Background()); err == nil {
		t.Fatal("a lost reserve CAS must abort the tick")
	}
	if got := c.Metrics().FailoverAbortedCount("ledger_cas_lost"); got != 1 {
		t.Fatalf("a lost-CAS abort must increment failover_aborted_total{reason=ledger_cas_lost}, got %d", got)
	}
	// The gauge + labeled counter must both render in the exposition.
	txt := c.Metrics().PromText()
	if !strings.Contains(txt, "pswatcher_failover_armed ") {
		t.Fatal("PromText must expose pswatcher_failover_armed")
	}
	if !strings.Contains(txt, `pswatcher_failover_aborted_total{reason="ledger_cas_lost"} 1`) {
		t.Fatalf("PromText must expose the labeled abort counter, got:\n%s", txt)
	}
}
