package pswatcher

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

// convergePromoter records promotions per tenant AND keeps a linked generation
// view in sync — a successful Promote(tenant, gen) makes a subsequent view read
// report that tenant at that generation, exactly as a real pageserver does after
// a `PUT location_config`. That linkage is what lets these tests drive MANY ticks
// and prove the converge loop TERMINATES (idempotent, no flap) rather than
// re-promoting a tenant every tick.
type convergePromoter struct {
	perTenant map[string][]int
	view      *fakeGenViewer
	notFound  map[string]bool // return wrapped ErrTenantNotFound (models a standby 404)
	failFor   int             // fail the first failFor calls (transient)
}

func (p *convergePromoter) Promote(_ context.Context, tenant string, gen int) error {
	if p.notFound[tenant] {
		return fmt.Errorf("tenant %s: %w", tenant, ErrTenantNotFound)
	}
	if p.failFor > 0 {
		p.failFor--
		return errors.New("promote refused (transient)")
	}
	if p.perTenant == nil {
		p.perTenant = map[string][]int{}
	}
	p.perTenant[tenant] = append(p.perTenant[tenant], gen)
	if p.view != nil {
		if p.view.gens == nil {
			p.view.gens = map[string]int{}
		}
		if p.view.present == nil {
			p.view.present = map[string]bool{}
		}
		p.view.gens[tenant] = gen
		p.view.present[tenant] = true
	}
	return nil
}

// T6 (#1100) CORE — an interrupted/incomplete failover that already FLIPPED the
// client Service but left a routed tenant un-attached at the ledger generation on
// the promoted pageserver must be CONVERGED on a later tick: the lagging tenant is
// re-promoted at the SAME ledger generation, idempotently, with NO manual step —
// replacing the live manual selector-repoint + hand promotion. This is the
// "converge to complete" behaviour that replaces "latch and stop".
func TestConvergeRepromotesLaggingTenantAfterFlip(t *testing.T) {
	tenants := []string{"f0f0-base", "a000-apps"}
	// A prior failover flipped the selector and advanced the ledger to 2, but the
	// apps tenant was NOT attached at gen 2 (skipped as absent during the failover,
	// then warmed afterwards). It now sits at the OLD generation 1 on the promoted
	// pageserver — stranded, exactly the class the manual repoint fixed by hand.
	k8s := &fakeK8s{selectorApp: "pageserver-standby", gen: 2, genSet: true}
	view := &fakeGenViewer{
		gens:    map[string]int{"f0f0-base": 2, "a000-apps": 1},
		present: map[string]bool{"f0f0-base": true, "a000-apps": true},
	}
	promoter := &convergePromoter{view: view}
	c := newControllerRouted(&toggleProber{alive: false}, &toggleProber{alive: true}, promoter, k8s, 1, tenants)
	c.SetGenerationViewer(view)

	for i := 0; i < 5; i++ {
		fo, err := c.Tick(context.Background())
		if err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
		if fo {
			t.Fatalf("tick %d: converge must not report a NEW failover", i)
		}
	}
	// The lagging apps tenant is re-attached at the LEDGER generation (2), exactly
	// once across the ticks (idempotent — the linked view reports it at 2 afterwards).
	if got := promoter.perTenant["a000-apps"]; len(got) != 1 || got[0] != 2 {
		t.Fatalf("apps converge promote = %v, want a single [2] (re-promote at the ledger gen, no flap)", got)
	}
	// The base tenant was already at the ledger gen ⇒ never re-promoted (no-op).
	if got := promoter.perTenant["f0f0-base"]; len(got) != 0 {
		t.Fatalf("base already converged ⇒ must not be re-promoted, got %v", got)
	}
	// GENERATION GUARD: the converge path NEVER advances the ledger.
	if k8s.gen != 2 || len(k8s.setGenTo) != 0 {
		t.Fatalf("converge must not advance the ledger: gen=%d writes=%v (want gen=2, no writes)", k8s.gen, k8s.setGenTo)
	}
	// The selector is not re-flipped; the adopt bounce still lands exactly once.
	if k8s.selectorApp != "pageserver-standby" || len(k8s.flippedTo) != 0 {
		t.Fatalf("converge must not re-flip the Service: selector=%q flips=%v", k8s.selectorApp, k8s.flippedTo)
	}
	if len(k8s.deletedFor) != 1 {
		t.Fatalf("adopt bounce must land exactly once, got %v", k8s.deletedFor)
	}
	if c.Metrics().ConvergeRepromotions() != 1 {
		t.Fatalf("converge_repromotions_total = %d, want 1", c.Metrics().ConvergeRepromotions())
	}
}

// T6 (#1100) EXIT CRITERION — kill pswatcher mid-failover (after promoting the base
// tenant + flipping, before the apps tenant), restart it, and it CONVERGES with NO
// manual step AND with the ledger generation advanced EXACTLY ONCE across the whole
// interrupted+resumed failover. This is the single-writer / no-double-advance
// invariant reviewers are told to attack.
func TestInterruptedFailoverConvergesWithSingleGenerationAdvance(t *testing.T) {
	tenants := []string{"f0f0-base", "a000-apps"}
	// ONE shared cluster; the ledger + selector are the crash-only truth across restarts.
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	view := &fakeGenViewer{
		gens:    map[string]int{"f0f0-base": 1},
		present: map[string]bool{"f0f0-base": true, "a000-apps": false}, // apps not yet warmed on the standby
	}

	// --- Instance 1: promotes the base tenant at gen 2 and flips, but the apps tenant
	//     is absent on the standby (not yet warmed) and corroborated absent, so it is
	//     skipped. The failover completes for the base; the ledger advances 1 -> 2 once.
	p1 := &convergePromoter{view: view, notFound: map[string]bool{"a000-apps": true}}
	c1 := newControllerRouted(&toggleProber{alive: false}, &toggleProber{alive: true}, p1, k8s, 1, tenants)
	c1.SetGenerationViewer(view)
	fo, err := c1.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fo {
		t.Fatal("instance 1 did not complete the (partial) failover")
	}
	if len(k8s.setGenTo) != 1 || k8s.setGenTo[0] != 2 {
		t.Fatalf("instance 1 ledger advance = %v, want a single [2]", k8s.setGenTo)
	}

	// pswatcher is KILLED here. The apps tenant is now warmed on the promoted
	// pageserver but still sits at the OLD generation (1) — stranded, exactly the
	// state that previously needed a manual selector-repoint + hand promotion.
	view.present["a000-apps"] = true
	view.gens["a000-apps"] = 1

	// --- Instance 2: RESTART. Fresh in-memory state, same cluster. It must converge
	//     the interrupted failover with NO manual step and WITHOUT advancing again.
	p2 := &convergePromoter{view: view}
	c2 := newControllerRouted(&toggleProber{alive: false}, &toggleProber{alive: true}, p2, k8s, 1, tenants)
	c2.SetGenerationViewer(view)
	for i := 0; i < 5; i++ {
		if _, err := c2.Tick(context.Background()); err != nil {
			t.Fatalf("restart tick %d: %v", i, err)
		}
	}
	if got := p2.perTenant["a000-apps"]; len(got) != 1 || got[0] != 2 {
		t.Fatalf("restart converge apps promote = %v, want a single [2] (at the ledger gen)", got)
	}
	// THE invariant reviewers attack: exactly ONE generation advance across the whole
	// interrupted+resumed failover — instance 1 wrote [2]; instance 2 must write nothing.
	if len(k8s.setGenTo) != 1 {
		t.Fatalf("generation advanced %d times across the episode, want exactly 1: %v", len(k8s.setGenTo), k8s.setGenTo)
	}
	if k8s.gen != 2 {
		t.Fatalf("final ledger = %d, want 2 (single advance, converged)", k8s.gen)
	}
	// The plane converged with no manual selector patch: still on the standby, and the
	// selector was flipped EXACTLY once across the whole episode (instance 1's failover) —
	// the converge path never re-flips.
	if k8s.selectorApp != "pageserver-standby" || len(k8s.flippedTo) != 1 {
		t.Fatalf("selector must end on the standby with exactly one flip across the episode: selector=%q flips=%v", k8s.selectorApp, k8s.flippedTo)
	}
}

// T6 (#1100) — a fully-completed failover must NOT be re-done: converge on an
// already-correct plane is a silent no-op (no spurious re-promotion, no ledger
// write, no flap) across arbitrarily many ticks.
func TestConvergeNoOpWhenAlreadyComplete(t *testing.T) {
	tenants := []string{"f0f0-base", "a000-apps"}
	k8s := &fakeK8s{selectorApp: "pageserver-standby", gen: 2, genSet: true}
	view := &fakeGenViewer{
		gens:    map[string]int{"f0f0-base": 2, "a000-apps": 2}, // fully converged
		present: map[string]bool{"f0f0-base": true, "a000-apps": true},
	}
	promoter := &convergePromoter{view: view}
	c := newControllerRouted(&toggleProber{alive: false}, &toggleProber{alive: true}, promoter, k8s, 1, tenants)
	c.SetGenerationViewer(view)

	for i := 0; i < 6; i++ {
		fo, err := c.Tick(context.Background())
		if err != nil || fo {
			t.Fatalf("tick %d: fo=%v err=%v (converge on a complete plane must be a silent no-op)", i, fo, err)
		}
	}
	if len(promoter.perTenant) != 0 {
		t.Fatalf("converge re-promoted a fully-converged plane: %v", promoter.perTenant)
	}
	if k8s.gen != 2 || len(k8s.setGenTo) != 0 {
		t.Fatalf("converge must not touch the ledger on a complete plane: gen=%d writes=%v", k8s.gen, k8s.setGenTo)
	}
	if c.Metrics().ConvergeRepromotions() != 0 {
		t.Fatalf("converge_repromotions_total = %d, want 0 on a complete plane", c.Metrics().ConvergeRepromotions())
	}
}

// T6 (#1100) — converge is FAIL-SAFE: with the generation view unwired (or
// erroring), a lagging tenant is NOT re-promoted (promoting on an unreadable
// vantage is exactly the guess this controller refuses). The block is counted so a
// permanently blind vantage over a stranded tenant is visible, never silent.
func TestConvergeFailsSafeWhenViewUnavailable(t *testing.T) {
	tenants := []string{"f0f0-base", "a000-apps"}
	k8s := &fakeK8s{selectorApp: "pageserver-standby", gen: 2, genSet: true}
	promoter := &convergePromoter{}
	c := newControllerRouted(&toggleProber{alive: false}, &toggleProber{alive: true}, promoter, k8s, 1, tenants)
	// No generation viewer wired.

	for i := 0; i < 3; i++ {
		if _, err := c.Tick(context.Background()); err != nil {
			t.Fatalf("tick %d: converge must not error on an unreadable vantage: %v", i, err)
		}
	}
	if len(promoter.perTenant) != 0 {
		t.Fatalf("converge must not promote on an unverifiable vantage: %v", promoter.perTenant)
	}
	if c.Metrics().ConvergeBlockedCount() == 0 {
		t.Fatal("converge_blocked_total must increment when the vantage cannot verify a routed tenant")
	}
}
