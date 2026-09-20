package pswatcher

import (
	"context"
	"errors"
	"testing"
)

var errTestStandbyUnreachable = errors.New("standby pageserver unreachable")

// D2 — the phantom-attach P0 correctness defect (ADR-0010 §5).
//
// The live pageserver's `PUT /v1/tenant/<T>/location_config` returns 200 and
// ATTACHES a phantom EMPTY tenant for a tenant it does not hold — it NEVER 404s.
// So the failover's `ErrTenantNotFound`-on-404 detector is dead against the real
// pageserver: on a plane whose standby was never warmed for a routed (apps) tenant,
// every PUT succeeds 200, the ledger advances, the client Service selector flips, and
// every per-app DB is served an EMPTY tenant while the real timelines sit fenced on
// the demoted pageserver — worse than split-brain, all counters green.
//
// The fix asks a STANDBY MEMBERSHIP ORACLE — `GET /v1/location_config`, the only
// endpoint that lists a tenant held as a warm Secondary (see
// standby_membership_test.go) — before any PUT, and feeds a not-held tenant into the
// EXISTING skippable() logic unchanged.
//
// phantomPromoter models the REAL pageserver semantics: PUT always succeeds (200),
// even for a tenant the pageserver does not hold. It never returns ErrTenantNotFound.
type phantomPromoter struct {
	perTenant map[string][]int
}

func (p *phantomPromoter) Promote(_ context.Context, tenant string, gen int) error {
	if p.perTenant == nil {
		p.perTenant = map[string][]int{}
	}
	p.perTenant[tenant] = append(p.perTenant[tenant], gen)
	return nil // 200 — attaches, even for a tenant this pageserver does not hold
}

// With the REAL PUT-200 semantics and a STANDBY that does NOT hold the apps tenant
// (it is absent from the standby's location_config listing) while the routed vantage
// still HOLDS it (the real timelines are on the primary), failover() must ABORT before
// the flip: no generation advance, no selector flip, no phantom attach carried forward.
// On origin/main — which has no standby pre-flight — the PUT 200s for every tenant, so
// the failover completes and flips: this test is RED there, and that red is the proof
// the defect is real.
func TestFailoverAbortsWhenStandbyLacksTenantDespitePut200(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &phantomPromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	// The STANDBY (promotion target) does NOT hold the apps tenant — it is absent from
	// its /v1/location_config listing.
	c.SetStandbyMembershipViewer(&fakeMembership{
		held: map[string]bool{"f0f0-base": true, "a000-apps": false},
	})
	// The routed vantage HOLDS the apps tenant (its real timelines live on the primary)
	// ⇒ the standby's absence is uncorroborated-as-nonexistent: the standby was never
	// warmed. skippable() must abort rather than skip.
	c.SetGenerationViewer(&fakeGenViewer{
		gens:    map[string]int{"f0f0-base": 1, "a000-apps": 1},
		present: map[string]bool{"f0f0-base": true, "a000-apps": true},
	})

	fo, err := c.Tick(context.Background())
	if err == nil {
		t.Fatal("failover must ABORT (surface an error) when the standby does not hold a routed tenant the routed vantage still holds — got nil")
	}
	if fo {
		t.Fatal("must not report a completed failover: the standby lacks the apps tenant's timelines (phantom attach)")
	}
	if len(k8s.setGenTo) != 0 {
		t.Fatalf("ledger must NOT advance on an aborted failover: %v", k8s.setGenTo)
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("Service must NOT flip before the standby is confirmed to hold every routed tenant: %v", k8s.flippedTo)
	}
	// The base tenant may have been promoted before the apps tenant aborted, but the
	// apps tenant must never be attached on a standby that does not hold it.
	if got := promoter.perTenant["a000-apps"]; len(got) != 0 {
		t.Fatalf("the apps tenant must not be PUT-attached on a standby that does not hold it (phantom attach): %v", got)
	}
}

// The BASE tenant is NEVER skippable: if the standby does not hold it, failover aborts
// before the flip regardless of any other vantage — the membership oracle detects the
// absence the PUT-200 hides.
func TestFailoverAbortsWhenStandbyLacksBaseTenantDespitePut200(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &phantomPromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	// The standby holds NEITHER tenant (neither is in its location_config listing).
	c.SetStandbyMembershipViewer(&fakeMembership{
		held: map[string]bool{"f0f0-base": false, "a000-apps": false},
	})
	c.SetGenerationViewer(&fakeGenViewer{
		present: map[string]bool{"f0f0-base": false, "a000-apps": false},
	})

	fo, err := c.Tick(context.Background())
	if err == nil {
		t.Fatal("a base tenant absent on the standby must ABORT the failover — got nil")
	}
	if fo {
		t.Fatal("must not report a completed failover when the base tenant is absent on the standby")
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("Service must NOT flip when the base tenant is absent on the standby: %v", k8s.flippedTo)
	}
	if len(k8s.setGenTo) != 0 {
		t.Fatalf("ledger must NOT advance on an aborted failover: %v", k8s.setGenTo)
	}
}

// The corroboration path stays intact: when the standby does not hold a NON-base tenant
// AND the routed vantage ALSO reports it absent (corroborated nonexistent — e.g. an apps
// tenant that was never provisioned anywhere), the tenant is SKIPPED and the failover
// completes for the tenants that DO exist. This asserts the pre-flight feeds skippable()
// unchanged rather than aborting on every standby miss.
func TestFailoverSkipsCorroboratedAbsentTenantViaStandbyView(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &phantomPromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	// Standby holds the base but not the apps tenant.
	c.SetStandbyMembershipViewer(&fakeMembership{
		held: map[string]bool{"f0f0-base": true, "a000-apps": false},
	})
	// Routed vantage AGREES the apps tenant does not exist ⇒ nothing routed to strand.
	c.SetGenerationViewer(&fakeGenViewer{
		gens:    map[string]int{"f0f0-base": 1},
		present: map[string]bool{"f0f0-base": true, "a000-apps": false},
	})

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatalf("failover must complete for the tenants that exist even if one is corroborated-absent: %v", err)
	}
	if !fo {
		t.Fatal("failover must complete (base recovered, apps skipped)")
	}
	if got := promoter.perTenant["f0f0-base"]; len(got) != 1 || got[0] != 2 {
		t.Fatalf("base tenant must be promoted at gen+1, got %v", got)
	}
	if got := promoter.perTenant["a000-apps"]; len(got) != 0 {
		t.Fatalf("a corroborated-absent apps tenant must NOT be attached, got %v", got)
	}
	if c.Metrics().TenantAbsent() != 1 {
		t.Fatalf("tenant_skipped = %d, want 1 (the corroborated-absent apps tenant)", c.Metrics().TenantAbsent())
	}
	if len(k8s.flippedTo) != 1 {
		t.Fatalf("Service must flip once (base recovered): flips=%v", k8s.flippedTo)
	}
}

// The path the real plane runs on every failover: the standby is a warm Secondary for
// EVERY routed tenant, so the oracle answers held for all of them and the promote-all
// path proceeds untouched. Guards the fix against the opposite failure — a pre-flight so
// strict it blocks legitimate promotion (which is what the wrong oracle did live: the
// generation view 503s on a Secondary, so the FIRST routed tenant aborted every time).
func TestFailoverPromotesAllWhenStandbyHoldsEveryRoutedTenant(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &phantomPromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 4, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	c.SetStandbyMembershipViewer(&fakeMembership{
		held: map[string]bool{"f0f0-base": true, "a000-apps": true},
	})
	// Deliberately NOT consulted on this path: every tenant is held, so skippable() is
	// never reached. An errored routed vantage must not block a fully-warmed standby.
	c.SetGenerationViewer(&fakeGenViewer{err: errors.New("routed vantage unreachable")})

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatalf("a standby holding every routed tenant must fail over cleanly: %v", err)
	}
	if !fo {
		t.Fatal("failover must complete when the standby holds every routed tenant")
	}
	for _, tenant := range []string{"f0f0-base", "a000-apps"} {
		if got := promoter.perTenant[tenant]; len(got) != 1 || got[0] != 5 {
			t.Fatalf("%s must be promoted exactly once at gen+1 (5), got %v", tenant, got)
		}
	}
	if len(k8s.setGenTo) != 1 || k8s.setGenTo[0] != 5 {
		t.Fatalf("ledger must advance once to 5: %v", k8s.setGenTo)
	}
	if len(k8s.flippedTo) != 1 {
		t.Fatalf("Service must flip once: %v", k8s.flippedTo)
	}
	if c.Metrics().TenantAbsent() != 0 {
		t.Fatalf("no tenant may be counted absent when the standby holds them all: %d", c.Metrics().TenantAbsent())
	}
}

// Fail closed: when the membership oracle ERRORS (we could not check whether the standby
// holds the tenant), failover must ABORT before the flip — "we could not check" is never
// "it holds it".
func TestFailoverAbortsWhenStandbyViewErrors(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &phantomPromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	c.SetStandbyMembershipViewer(&fakeMembership{err: errTestStandbyUnreachable})
	c.SetGenerationViewer(&fakeGenViewer{present: map[string]bool{"f0f0-base": true, "a000-apps": true}})

	fo, err := c.Tick(context.Background())
	if err == nil {
		t.Fatal("an unreadable standby membership oracle must ABORT the failover, got nil")
	}
	if fo {
		t.Fatal("must not report a completed failover when the standby membership oracle is unreadable")
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("Service must NOT flip when the standby membership oracle is unreadable: %v", k8s.flippedTo)
	}
	if len(k8s.setGenTo) != 0 {
		t.Fatalf("ledger must NOT advance on an aborted failover: %v", k8s.setGenTo)
	}
}

// The test above cannot see the oracle-error branch on its own: it errors for EVERY
// tenant, so the base tenant's never-skippable abort fires first and the failover aborts
// whether or not the error was honoured (#1120 review). This one DISCRIMINATES. The
// oracle answers for the base tenant (held) and fails ONLY on the non-base one, while the
// routed vantage reports that non-base tenant ABSENT — so if the oracle's error were
// treated as "not held", skippable() would corroborate the absence, SKIP the tenant and
// FLIP. It must abort instead: an unreadable oracle is not a corroborating vantage.
func TestFailoverAbortsWhenOracleErrorsOnNonBaseTenantTheRoutedViewCallsAbsent(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &phantomPromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	c.SetStandbyMembershipViewer(&fakeMembership{
		held:   map[string]bool{"f0f0-base": true},
		errFor: map[string]error{"a000-apps": errTestStandbyUnreachable},
	})
	// The routed vantage would CORROBORATE an absence here — that is exactly what makes
	// this test distinguishing: only honouring the oracle's error keeps the failover shut.
	c.SetGenerationViewer(&fakeGenViewer{
		gens:    map[string]int{"f0f0-base": 1},
		present: map[string]bool{"f0f0-base": true, "a000-apps": false},
	})

	fo, err := c.Tick(context.Background())
	if err == nil {
		t.Fatal("an oracle that could not be READ for a non-base tenant must ABORT the failover — an unreadable oracle is not evidence of absence, got nil")
	}
	if fo {
		t.Fatal("must not report a completed failover when the oracle could not be read for a routed tenant")
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("Service must NOT flip: %v", k8s.flippedTo)
	}
	if len(k8s.setGenTo) != 0 {
		t.Fatalf("ledger must NOT advance: %v", k8s.setGenTo)
	}
	if c.Metrics().TenantAbsent() != 0 {
		t.Fatalf("an unreadable tenant must NEVER be counted as a corroborated absence: %d", c.Metrics().TenantAbsent())
	}
}

// FAIL CLOSED ON AN UNWIRED ORACLE (#1120 architecture BLOCK). A build/deploy that never
// wires the membership oracle must ABORT the failover, not silently fall through to the
// dead PUT-404 detector — falling through is precisely the phantom-attach split-brain the
// pre-flight exists to prevent, and it would be reached by omission rather than by choice.
// This mirrors viewGeneration()'s nil handling and skippable()'s "an unwired vantage
// aborts" (ADR-0012: fail toward the reversible state).
//
// newControllerRouted wires a holds-everything oracle by default (the live-accurate
// posture), so this test explicitly UNWIRES it to model the production omission.
func TestFailoverAbortsWhenNoStandbyMembershipOracleWired(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &phantomPromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	c.SetStandbyMembershipViewer(nil) // UNWIRED — the omission case
	c.SetGenerationViewer(&fakeGenViewer{
		gens:    map[string]int{"f0f0-base": 1, "a000-apps": 1},
		present: map[string]bool{"f0f0-base": true, "a000-apps": true},
	})

	fo, err := c.Tick(context.Background())
	if err == nil {
		t.Fatal("an UNWIRED standby membership oracle must ABORT the failover (fail closed) — falling through to the PUT would phantom-attach onto an unverified standby")
	}
	if fo {
		t.Fatal("must not report a completed failover with no membership oracle wired")
	}
	if len(promoter.perTenant) != 0 {
		t.Fatalf("nothing may be PUT-attached with no membership oracle wired: %v", promoter.perTenant)
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("Service must NOT flip with no membership oracle wired: %v", k8s.flippedTo)
	}
	if len(k8s.setGenTo) != 0 {
		t.Fatalf("ledger must NOT advance with no membership oracle wired: %v", k8s.setGenTo)
	}
}
