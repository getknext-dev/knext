package pswatcher

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// fakeProber reports a scripted liveness sequence. Once the script is
// exhausted it keeps returning the last value.
type fakeProber struct {
	seq  []bool
	i    int
	last bool
}

func (p *fakeProber) Alive(_ context.Context) bool {
	if p.i < len(p.seq) {
		p.last = p.seq[p.i]
		p.i++
	}
	return p.last
}

// toggleProber returns a liveness value that the test can flip mid-run. Used to
// model a node whose health changes across the failover lifecycle (a primary that
// dies and later returns, or a promoted standby that subsequently dies).
type toggleProber struct{ alive bool }

func (p *toggleProber) Alive(_ context.Context) bool { return p.alive }

// fakePromoter records promotion calls and can inject a failure for the first
// N calls (models a pageserver that is slow to accept the re-attach).
type fakePromoter struct {
	calls    []int // generations promoted at, in order (across all tenants)
	failFor  int   // fail the first failFor calls
	tenantOK string
	err      error

	// perTenant records, per tenant id, the generations it was promoted at (in
	// order). Lets multi-tenant tests assert that EVERY routed tenant was
	// re-attached at the incremented generation, not just the base tenant.
	perTenant map[string][]int
	// notFound: a tenant id here returns ErrTenantNotFound (models a routed-set
	// entry the pageserver does not actually hold — e.g. an apps tenant that was
	// never provisioned). Such a tenant must be SKIPPED, never strand the flip.
	notFound map[string]bool
	// hardErr: a tenant id here returns a generic (non-not-found) error, which
	// must ABORT the failover before the Service flip (never strand a real tenant).
	hardErr map[string]bool
}

func (p *fakePromoter) Promote(_ context.Context, tenant string, gen int) error {
	p.tenantOK = tenant
	if p.notFound[tenant] {
		return fmt.Errorf("tenant %s: %w", tenant, ErrTenantNotFound)
	}
	if p.hardErr[tenant] {
		return errors.New("pageserver 500 (real failure)")
	}
	if p.failFor > 0 {
		p.failFor--
		return errors.New("promote refused (standby not ready)")
	}
	p.calls = append(p.calls, gen)
	if p.perTenant == nil {
		p.perTenant = map[string][]int{}
	}
	p.perTenant[tenant] = append(p.perTenant[tenant], gen)
	return nil
}

// fakeGenViewer models the pageserver's current generation view. present[tenant]=false
// models a tenant the pageserver 404s.
//
// okWithErr models a MISBEHAVING viewer: one that returns an error while ALSO claiming
// ok and a generation (e.g. a partially-decoded response, or a future implementation
// that reports a cached value alongside a live-read failure). The consumers must treat
// err as disqualifying on its own — reading the value "because ok was true" would seed
// or promote from an unverified number. Without this, the err checks are invisibly
// subsumed by the !ok checks and mutation-prove as decorative.
type fakeGenViewer struct {
	gens      map[string]int
	present   map[string]bool
	err       error
	okWithErr bool
}

func (g *fakeGenViewer) Generation(_ context.Context, tenant string) (int, bool, error) {
	if g.err != nil {
		if g.okWithErr {
			return g.gens[tenant], true, g.err
		}
		return 0, false, g.err
	}
	if g.present != nil && !g.present[tenant] {
		return 0, false, nil
	}
	return g.gens[tenant], true, nil
}

// fakeK8s is an in-memory model of the Kubernetes surface.
type fakeK8s struct {
	selectorApp string
	gen         int
	genSet      bool
	deletedFor  []string
	setGenTo    []int
	flippedTo   []string
	getSelErr   error
	setGenErr   error
	flipErr     error
	deleteErr   error

	// Second-vantage (#26): what the API server / kubelet reports for the primary
	// pod. present=false models an absent pod (genuinely gone); podReadyErr models
	// an unreachable API server.
	primaryReady   bool
	primaryPresent bool
	podReadyErr    error
	// #1099 — is the primary pod's container RUNNING (process alive) regardless of the
	// Ready condition? present + !ready + running ⇒ dependency degraded (HOLD); the
	// zero value (false) preserves the pre-#1099 "present + NotReady ⇒ death" tests.
	primaryRunning bool

	// #1099 — maintenance-freeze window. freezePresent models the freeze ConfigMap
	// existing; freezeUntil is its raw expiry and freezeCreatedAt its creation time
	// (the Controller applies the TTL clamp). freezeErr models an unreadable CM.
	freezeUntil     time.Time
	freezeCreatedAt time.Time
	freezePresent   bool
	freezeErr       error
}

func (k *fakeK8s) PodReady(_ context.Context, _ string) (bool, bool, bool, error) {
	if k.podReadyErr != nil {
		return false, false, false, k.podReadyErr
	}
	return k.primaryReady, k.primaryPresent, k.primaryRunning, nil
}

func (k *fakeK8s) FailoverFreeze(_ context.Context) (time.Time, time.Time, bool, error) {
	if k.freezeErr != nil {
		return time.Time{}, time.Time{}, false, k.freezeErr
	}
	return k.freezeUntil, k.freezeCreatedAt, k.freezePresent, nil
}

func (k *fakeK8s) ServiceSelectorApp(_ context.Context, _ string) (string, error) {
	return k.selectorApp, k.getSelErr
}
func (k *fakeK8s) FlipServiceSelector(_ context.Context, _, app string) error {
	if k.flipErr != nil {
		return k.flipErr
	}
	k.flippedTo = append(k.flippedTo, app)
	k.selectorApp = app
	return nil
}
func (k *fakeK8s) DeletePods(_ context.Context, selector string) (int, error) {
	if k.deleteErr != nil {
		return 0, k.deleteErr
	}
	k.deletedFor = append(k.deletedFor, selector)
	return 1, nil
}
func (k *fakeK8s) GetGeneration(_ context.Context) (int, bool, error) {
	return k.gen, k.genSet, nil
}
func (k *fakeK8s) SetGeneration(_ context.Context, gen int) error {
	if k.setGenErr != nil {
		return k.setGenErr
	}
	k.gen = gen
	k.genSet = true
	k.setGenTo = append(k.setGenTo, gen)
	return nil
}

func newController(p Prober, pr Promoter, k K8sOps, threshold int) *Controller {
	// Default standby prober is always alive — tests that don't exercise the
	// post-failover re-anchor don't care about the standby's health.
	return newControllerFull(p, &toggleProber{alive: true}, pr, k, threshold)
}

func newControllerFull(p, sb Prober, pr Promoter, k K8sOps, threshold int) *Controller {
	c := NewController(p, sb, pr, k, Config{
		Tenant:          "f0f0",
		ClientService:   "pageserver",
		StandbyApp:      "pageserver-standby",
		ComputeSelector: "app=compute",
		PrimarySelector: "app=pageserver",
		FailThreshold:   threshold,
		BaseGeneration:  1,
	}, NewMetrics())
	// Wire the LIVE-ACCURATE default: a standby warmed for every routed tenant. The
	// failover pre-flight is fail-closed on an unwired oracle, so tests that are not
	// about tenant coverage must exercise the same path production runs, not the
	// abort path (#1120). Tests that ARE about coverage override this.
	c.SetStandbyMembershipViewer(allHeld{})
	return c
}

// MANDATORY negative test: a healthy primary must NEVER trigger a promotion,
// no matter how many times we poll.
func TestNoPromotionWhilePrimaryHealthy(t *testing.T) {
	prober := &fakeProber{seq: []bool{true}, last: true}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true}
	c := newController(prober, promoter, k8s, 3)

	for i := 0; i < 10; i++ {
		failedOver, err := c.Tick(context.Background())
		if err != nil {
			t.Fatalf("tick %d: unexpected error: %v", i, err)
		}
		if failedOver {
			t.Fatalf("tick %d: failed over while primary healthy", i)
		}
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("promoted %v while primary healthy", promoter.calls)
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("flipped selector %v while primary healthy", k8s.flippedTo)
	}
	if c.Metrics().Promotions() != 0 {
		t.Fatalf("promotion metric = %d, want 0", c.Metrics().Promotions())
	}
	if k8s.selectorApp != "pageserver" {
		t.Fatalf("selector changed to %q while healthy", k8s.selectorApp)
	}
}

// A blip below the failure threshold must not trigger a failover.
func TestNoPromotionBelowThreshold(t *testing.T) {
	// dead for 2 polls then recovers; threshold is 3.
	prober := &fakeProber{seq: []bool{false, false, true, true}}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true}
	c := newController(prober, promoter, k8s, 3)

	for i := 0; i < 4; i++ {
		if _, err := c.Tick(context.Background()); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("promoted on a sub-threshold blip: %v", promoter.calls)
	}
}

// Sustained primary failure at/after the threshold must promote the standby at
// generation+1, persist the advanced generation, flip the client Service, and
// bounce the compute — exactly once.
func TestPromoteOnSustainedFailure(t *testing.T) {
	prober := &fakeProber{seq: []bool{false, false, false}, last: false}
	promoter := &fakePromoter{}
	// genuine death modelled as pod present-but-NotReady (the kubelet's view of a
	// dying StatefulSet pod): present anchors the second vantage, NotReady ⇒ death.
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newController(prober, promoter, k8s, 3)

	var failedAt int = -1
	for i := 0; i < 3; i++ {
		fo, err := c.Tick(context.Background())
		if err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
		if fo {
			failedAt = i
		}
	}
	if failedAt != 2 {
		t.Fatalf("failover happened at tick %d, want 2 (threshold=3)", failedAt)
	}
	if len(promoter.calls) != 1 || promoter.calls[0] != 2 {
		t.Fatalf("promote calls = %v, want [2] (gen 1 -> gen+1=2)", promoter.calls)
	}
	if promoter.tenantOK != "f0f0" {
		t.Fatalf("promoted wrong tenant %q", promoter.tenantOK)
	}
	if len(k8s.setGenTo) != 1 || k8s.setGenTo[0] != 2 {
		t.Fatalf("generation persisted = %v, want [2]", k8s.setGenTo)
	}
	if len(k8s.flippedTo) != 1 || k8s.flippedTo[0] != "pageserver-standby" {
		t.Fatalf("selector flip = %v, want [pageserver-standby]", k8s.flippedTo)
	}
	if len(k8s.deletedFor) != 1 || k8s.deletedFor[0] != "app=compute" {
		t.Fatalf("compute bounce = %v, want [app=compute]", k8s.deletedFor)
	}
	if c.Metrics().Promotions() != 1 {
		t.Fatalf("promotion metric = %d, want 1", c.Metrics().Promotions())
	}
}

// Failover must never run twice: once promoted, further dead-primary polls are
// no-ops (the standby is the new authority; re-promoting would flap).
func TestFailoverIsSingleShot(t *testing.T) {
	prober := &fakeProber{seq: []bool{false}, last: false}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newController(prober, promoter, k8s, 1)

	for i := 0; i < 5; i++ {
		if _, err := c.Tick(context.Background()); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	if len(promoter.calls) != 1 {
		t.Fatalf("promoted %d times, want exactly 1: %v", len(promoter.calls), promoter.calls)
	}
}

// Generation is read from the ConfigMap, so repeated failovers over the
// cluster's life keep incrementing (gen 5 -> promote at 6).
func TestGenerationAdvancesFromConfigMap(t *testing.T) {
	prober := &fakeProber{seq: []bool{false}, last: false}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 5, genSet: true}
	c := newController(prober, promoter, k8s, 1)

	if _, err := c.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(promoter.calls) != 1 || promoter.calls[0] != 6 {
		t.Fatalf("promote calls = %v, want [6] (gen 5 -> 6)", promoter.calls)
	}
	if k8s.gen != 6 {
		t.Fatalf("persisted generation = %d, want 6", k8s.gen)
	}
}

// An ABSENT ledger key must never be silently floored to the base generation —
// that is the #1095 silent-data-loss class. The generation is RECOVERED from the
// routed pageserver's live view instead, and the failover promotes at view+1.
func TestGenerationRecoveredWhenLedgerAbsent(t *testing.T) {
	prober := &fakeProber{seq: []bool{false}, last: false}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", genSet: false, primaryPresent: true, primaryReady: false}
	c := newController(prober, promoter, k8s, 1)
	// The routed pageserver reports the plane is at generation 4 — promoting at the
	// base+1 (2) would re-attach BELOW the live plane and be fenced/lose data.
	c.SetGenerationViewer(&fakeGenViewer{gens: map[string]int{"f0f0": 4}, present: map[string]bool{"f0f0": true}})

	if _, err := c.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(promoter.calls) != 1 || promoter.calls[0] != 5 {
		t.Fatalf("promote calls = %v, want [5] (recovered view 4 -> 5), never the base floor", promoter.calls)
	}
}

// MUTATION GUARD (code review #5): an absent ledger that ALSO cannot be recovered
// from the pageserver view must ABORT the failover, not promote at BaseGeneration.
// Promoting at 2 on a plane that is really at 7 re-attaches below the object-store
// index — the exact silent floor-to-1 class #1095 closed.
func TestFailoverRefusesWhenLedgerAbsentAndUnrecoverable(t *testing.T) {
	cases := map[string]GenerationViewer{
		"view unreachable": &fakeGenViewer{err: errors.New("pageserver unreachable")},
		"view reports 404": &fakeGenViewer{present: map[string]bool{"f0f0": false}},
		"no viewer wired":  nil,
		// An errored read is disqualifying even when the viewer also claims ok:
		// promoting at 10 off an unverified 9 is still promoting at a guess.
		"view errored but also claimed ok": &fakeGenViewer{
			gens: map[string]int{"f0f0": 9}, okWithErr: true, err: errors.New("partial read"),
		},
	}
	for name, viewer := range cases {
		t.Run(name, func(t *testing.T) {
			prober := &fakeProber{seq: []bool{false}, last: false}
			promoter := &fakePromoter{}
			k8s := &fakeK8s{selectorApp: "pageserver", genSet: false, primaryPresent: true, primaryReady: false}
			c := newController(prober, promoter, k8s, 1)
			if viewer != nil {
				c.SetGenerationViewer(viewer)
			}

			fo, err := c.Tick(context.Background())
			if err == nil {
				t.Fatal("an absent + unrecoverable ledger must surface an error, not silently floor to the base generation")
			}
			if fo {
				t.Fatal("must not report a failover when the generation is unknown")
			}
			if len(promoter.calls) != 0 {
				t.Fatalf("must not promote at an invented generation: %v", promoter.calls)
			}
			if len(k8s.flippedTo) != 0 {
				t.Fatalf("Service must not flip when the generation is unknown: %v", k8s.flippedTo)
			}
		})
	}
}

// Restart idempotency: if the client Service already points at the standby, a
// failover already happened. The watcher must adopt that state and never
// re-promote, even though the (old) primary probe is dead.
func TestAlreadyFailedOverIsAdopted(t *testing.T) {
	prober := &fakeProber{seq: []bool{false}, last: false}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver-standby", gen: 2, genSet: true}
	c := newController(prober, promoter, k8s, 1)

	for i := 0; i < 3; i++ {
		fo, err := c.Tick(context.Background())
		if err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
		if fo {
			t.Fatalf("tick %d: re-promoted an already-failed-over tenant", i)
		}
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("promoted %v despite selector already on standby", promoter.calls)
	}
}

// A transient promote failure must not consume the failover: the watcher keeps
// retrying and promotes once the standby accepts, still at generation+1.
func TestPromoteFailureRetries(t *testing.T) {
	prober := &fakeProber{seq: []bool{false}, last: false}
	promoter := &fakePromoter{failFor: 2}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newController(prober, promoter, k8s, 1)

	promoted := false
	for i := 0; i < 5 && !promoted; i++ {
		fo, err := c.Tick(context.Background())
		if err == nil && fo {
			promoted = true
		}
	}
	if !promoted {
		t.Fatal("never promoted after transient failures cleared")
	}
	if len(promoter.calls) != 1 || promoter.calls[0] != 2 {
		t.Fatalf("promote calls = %v, want [2]", promoter.calls)
	}
	// Selector must not flip until the promote actually succeeded.
	if len(k8s.flippedTo) != 1 {
		t.Fatalf("selector flipped %d times, want 1 (only after successful promote)", len(k8s.flippedTo))
	}
}

// #25 — full failover lifecycle: healthy → primary dies → promote → the watcher
// RE-ANCHORS to the node it promoted (probes the standby, reports ITS truth), and
// the old primary returning is never re-adopted or double-attached.
func TestPostFailoverReAnchorsToPromotedStandby(t *testing.T) {
	primary := &toggleProber{alive: true}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false} // pod present-but-NotReady ⇒ genuine death
	c := newControllerFull(primary, standby, promoter, k8s, 3)
	ctx := context.Background()

	// Phase 1 — healthy: no failover, primary_up reflects the (healthy) primary.
	if fo, _ := c.Tick(ctx); fo {
		t.Fatal("failed over while primary healthy")
	}
	if c.Metrics().PrimaryUp() != 1 || c.Metrics().FailedOver() != 0 {
		t.Fatalf("healthy: primary_up=%d failed_over=%d, want 1/0", c.Metrics().PrimaryUp(), c.Metrics().FailedOver())
	}

	// Phase 2 — primary dies: 3 misses ⇒ promote on the 3rd (threshold=3).
	primary.alive = false
	promotedAt := -1
	for i := 0; i < 3; i++ {
		fo, err := c.Tick(ctx)
		if err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
		if fo {
			promotedAt = i
		}
	}
	if promotedAt != 2 {
		t.Fatalf("promoted at tick %d, want 2", promotedAt)
	}
	if c.Metrics().Promotions() != 1 || c.Metrics().FailedOver() != 1 {
		t.Fatalf("after promote: promotions=%d failed_over=%d, want 1/1", c.Metrics().Promotions(), c.Metrics().FailedOver())
	}
	if len(k8s.flippedTo) != 1 || k8s.flippedTo[0] != "pageserver-standby" {
		t.Fatalf("selector flip = %v, want [pageserver-standby]", k8s.flippedTo)
	}

	// Phase 3 — RE-ANCHOR: the watcher now probes the STANDBY. Healthy ⇒ primary_up=1
	// (truthfully the promoted authority), and it does NOT re-promote.
	if fo, _ := c.Tick(ctx); fo {
		t.Fatal("re-promoted after failover")
	}
	if c.Metrics().PrimaryUp() != 1 {
		t.Fatal("primary_up should track the healthy promoted standby")
	}

	// Phase 3b — the PROMOTED standby dies: the metric must tell the truth (0), not a
	// blind 1. This is the exact #25 defect: pre-fix, primary_up stayed 1 forever.
	standby.alive = false
	if _, err := c.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if c.Metrics().PrimaryUp() != 0 {
		t.Fatal("primary_up must reflect the DEAD promoted standby, not a hardcoded 1 (#25 blind-after-failover)")
	}

	// Phase 4 — the OLD primary returns: it must NOT be re-adopted or double-attached.
	primary.alive = true
	standby.alive = true
	for i := 0; i < 3; i++ {
		if _, err := c.Tick(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if c.Metrics().Promotions() != 1 {
		t.Fatal("old primary returning must not trigger a second promotion")
	}
	if len(k8s.flippedTo) != 1 || k8s.selectorApp != "pageserver-standby" {
		t.Fatalf("authority must remain the promoted standby (flips=%v selector=%q)", k8s.flippedTo, k8s.selectorApp)
	}
	if c.Metrics().PrimaryUp() != 1 {
		t.Fatal("primary_up should track the (healthy) standby, not the returned old primary")
	}
}

// #26 — second-vantage decision table: a failed HTTP probe alone must not promote.
// The API server (kubelet's view) is the corroborating vantage.
func TestPromotionGatedBySecondVantage(t *testing.T) {
	cases := []struct {
		name                         string
		primaryReady, primaryPresent bool
		wantPromote                  bool
		wantSuspected                bool
	}{
		{"probe fails + pod Running&Ready ⇒ OUR partition ⇒ hold", true, true, false, true},
		{"probe fails + pod NotReady ⇒ genuine death ⇒ promote", false, true, true, false},
		// #58: pod absent with NO prior present-anchor (gen==base) is now HOLD, not
		// promote — absence of a never-seen pod is likely selector misconfig, covered
		// by the dedicated TestSeenPresentAnchor below.
		{"probe fails + pod absent + never anchored ⇒ HOLD (selector suspect)", false, false, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			primary := &toggleProber{alive: false} // our HTTP probe always fails
			standby := &toggleProber{alive: true}
			promoter := &fakePromoter{}
			k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true,
				primaryReady: tc.primaryReady, primaryPresent: tc.primaryPresent}
			c := newControllerFull(primary, standby, promoter, k8s, 3)

			promoted := false
			for i := 0; i < 6; i++ {
				fo, err := c.Tick(context.Background())
				if err != nil {
					t.Fatalf("tick %d: %v", i, err)
				}
				if fo {
					promoted = true
				}
			}
			if promoted != tc.wantPromote {
				t.Fatalf("promoted=%v, want %v", promoted, tc.wantPromote)
			}
			if !tc.wantPromote && len(promoter.calls) != 0 {
				t.Fatalf("promoted despite pod healthy per kubelet: %v", promoter.calls)
			}
			gotSuspected := c.Metrics().SuspectedPartitions() > 0
			if gotSuspected != tc.wantSuspected {
				t.Fatalf("suspected_partitions>0=%v, want %v (count=%d)", gotSuspected, tc.wantSuspected, c.Metrics().SuspectedPartitions())
			}
		})
	}
}

// #26 — if the second vantage (API server) is unreachable, the watcher must NOT
// promote on our probe alone: refuse to burn the only standby under uncertainty.
func TestPartitionCheckErrorDoesNotPromote(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, podReadyErr: errors.New("apiserver unreachable")}
	c := newControllerFull(primary, standby, promoter, k8s, 1)

	sawErr := false
	for i := 0; i < 5; i++ {
		if _, err := c.Tick(context.Background()); err != nil {
			sawErr = true
		}
	}
	if !sawErr {
		t.Fatal("expected an error while the second-vantage check is unavailable")
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("must not promote when the second vantage is unavailable: %v", promoter.calls)
	}
}

// #23 — crash-only resume: a watcher that died AFTER advancing the ledger but BEFORE
// flipping the client Service resumes on restart and drives the failover to
// completion from the ledger — idempotently (generation stays monotonic, reads
// recover on the standby), no split-brain.
func TestCrashOnlyResumeMidFailover(t *testing.T) {
	primary := &toggleProber{alive: false} // primary genuinely gone
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	// Restarted watcher: ledger already at 2 (a prior instance promoted), but the
	// Service was never flipped (still "pageserver"), and the primary pod is absent.
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 2, genSet: true, primaryPresent: false}
	c := newControllerFull(primary, standby, promoter, k8s, 1)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fo {
		t.Fatal("restarted watcher did not resume the interrupted failover")
	}
	if k8s.selectorApp != "pageserver-standby" {
		t.Fatalf("resume did not flip the Service to the standby: %q", k8s.selectorApp)
	}
	if len(k8s.deletedFor) != 1 {
		t.Fatal("resume did not bounce the compute")
	}
	if k8s.gen <= 2 {
		t.Fatalf("generation must stay monotonic on resume (fences the dead primary), got %d", k8s.gen)
	}
	if len(promoter.calls) != 1 {
		t.Fatalf("resume must promote exactly once (no flap), got %v", promoter.calls)
	}
}

// #57 — crash in the flip→delete window: a prior watcher promoted and FLIPPED the
// client Service to the standby, then died before bouncing the compute. On restart
// the watcher adopts the flipped selector; it must still bounce the compute exactly
// once (a compute pinned to the dead primary is otherwise never re-attached).
func TestAdoptBouncesComputeOnResume(t *testing.T) {
	primary := &toggleProber{alive: false} // old primary dead
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	// selector ALREADY on the standby (promote+flip completed), compute never bounced.
	k8s := &fakeK8s{selectorApp: "pageserver-standby", gen: 2, genSet: true}
	c := newControllerFull(primary, standby, promoter, k8s, 3)

	for i := 0; i < 5; i++ {
		fo, err := c.Tick(context.Background())
		if err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
		if fo {
			t.Fatalf("tick %d: adopt path must never re-promote", i)
		}
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("adopt path promoted: %v", promoter.calls)
	}
	if len(k8s.deletedFor) != 1 || k8s.deletedFor[0] != "app=compute" {
		t.Fatalf("adopt path must bounce the compute EXACTLY once, got %v (#57)", k8s.deletedFor)
	}
}

// #57 — the adopt-path bounce is crash-only/idempotent: a transient DeletePods
// error must not permanently skip the bounce; the watcher retries until it lands,
// still exactly once.
func TestAdoptBounceRetriesOnError(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver-standby", gen: 2, genSet: true, deleteErr: errors.New("apiserver blip")}
	c := newControllerFull(primary, standby, promoter, k8s, 3)

	// first tick: adoption detected, bounce attempted but errors → recorded, retried.
	if _, err := c.Tick(context.Background()); err == nil {
		t.Fatal("expected the failed adopt-bounce to surface an error")
	}
	if len(k8s.deletedFor) != 0 {
		t.Fatalf("no bounce should be recorded while DeletePods errors: %v", k8s.deletedFor)
	}
	k8s.deleteErr = nil // the blip clears
	for i := 0; i < 4; i++ {
		if _, err := c.Tick(context.Background()); err != nil {
			t.Fatalf("tick %d after blip cleared: %v", i, err)
		}
	}
	if len(k8s.deletedFor) != 1 {
		t.Fatalf("adopt bounce must land exactly once after the blip clears, got %v", k8s.deletedFor)
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("adopt path must never promote: %v", promoter.calls)
	}
}

// #58 — seen-present anchor. PodReady present=false is ambiguous: a genuinely dead
// primary vs. a selector that never matched anything (typo/label drift/RBAC empty
// list). Only treat absence as death once the pod has been observed present at least
// once — otherwise HOLD and surface pswatcher_primary_never_seen, rather than burn
// the only standby on a vantage we can't trust.
func TestSeenPresentAnchor(t *testing.T) {
	ctx := context.Background()

	t.Run("never anchored + absent + ledger at base ⇒ HOLD", func(t *testing.T) {
		primary := &toggleProber{alive: false}
		standby := &toggleProber{alive: true}
		promoter := &fakePromoter{}
		// selector never matches ⇒ present=false forever; gen==base ⇒ no prior promotion.
		k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: false}
		c := newControllerFull(primary, standby, promoter, k8s, 1)
		for i := 0; i < 5; i++ {
			fo, err := c.Tick(ctx)
			if err != nil {
				t.Fatalf("tick %d: %v", i, err)
			}
			if fo {
				t.Fatal("promoted on an absence we never anchored (selector may be misconfigured)")
			}
		}
		if len(promoter.calls) != 0 {
			t.Fatalf("must not promote on a never-anchored absence: %v", promoter.calls)
		}
		if c.Metrics().PrimaryNeverSeenCount() == 0 {
			t.Fatal("pswatcher_primary_never_seen_total must increment on a never-anchored absence")
		}
	})

	t.Run("anchored (seen present) then vanished ⇒ PROMOTE", func(t *testing.T) {
		primary := &toggleProber{alive: false}
		standby := &toggleProber{alive: true}
		promoter := &fakePromoter{}
		// pod present & Ready per the kubelet ⇒ HOLD (suspected partition) but ANCHORS.
		k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: true}
		c := newControllerFull(primary, standby, promoter, k8s, 1)
		for i := 0; i < 3; i++ {
			if fo, _ := c.Tick(ctx); fo {
				t.Fatal("promoted while the pod is Ready per the kubelet")
			}
		}
		if len(promoter.calls) != 0 {
			t.Fatalf("must hold while the pod is Ready: %v", promoter.calls)
		}
		// the anchored pod now vanishes — a trusted absence ⇒ promote.
		k8s.primaryPresent = false
		k8s.primaryReady = false
		promoted := false
		for i := 0; i < 3 && !promoted; i++ {
			if fo, _ := c.Tick(ctx); fo {
				promoted = true
			}
		}
		if !promoted {
			t.Fatal("an anchored primary that vanished must promote")
		}
	})

	t.Run("absent but ledger advanced ⇒ RESUME (promote)", func(t *testing.T) {
		primary := &toggleProber{alive: false}
		standby := &toggleProber{alive: true}
		promoter := &fakePromoter{}
		// gen>base ⇒ a prior instance already decided a failover; resume trumps the
		// never-seen guard even though the pod is absent and we never anchored.
		k8s := &fakeK8s{selectorApp: "pageserver", gen: 2, genSet: true, primaryPresent: false}
		c := newControllerFull(primary, standby, promoter, k8s, 1)
		fo, err := c.Tick(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !fo {
			t.Fatal("an advanced ledger must resume the failover even on an un-anchored absence")
		}
	})
}

func TestMetricsPromText(t *testing.T) {
	m := NewMetrics()
	m.SetPrimaryUp(false)
	m.Promotion()
	txt := m.PromText()
	for _, want := range []string{"pswatcher_promotions_total 1", "pswatcher_primary_up 0"} {
		if !contains(txt, want) {
			t.Fatalf("PromText missing %q:\n%s", want, txt)
		}
	}
}

// newControllerRouted wires a controller whose routed-tenant set (the tenants the
// flipped client Service will serve) is `tenants`. The first entry is the base
// tenant; the rest model per-tenant routing scope (e.g. the apps tenant).
func newControllerRouted(p, sb Prober, pr Promoter, k K8sOps, threshold int, tenants []string) *Controller {
	base := ""
	if len(tenants) > 0 {
		base = tenants[0]
	}
	c := NewController(p, sb, pr, k, Config{
		Tenant:          base,
		Tenants:         tenants,
		ClientService:   "pageserver",
		StandbyApp:      "pageserver-standby",
		ComputeSelector: "app=compute",
		PrimarySelector: "app=pageserver",
		FailThreshold:   threshold,
		BaseGeneration:  1,
	}, NewMetrics())
	// See newControllerFull: the live-accurate default is a standby that holds every
	// routed tenant; coverage tests override it.
	c.SetStandbyMembershipViewer(allHeld{})
	return c
}

// T2 (#1098) core fix — promotion scope == routing scope. The flipped `pageserver`
// Service routes EVERY tenant the plane holds (the base tenant AND the apps tenant
// under which every per-app AppDatabase is a timeline). A failover must re-attach
// ALL of them at the incremented generation, or the non-base tenants are stranded
// on the demoted pageserver (the split-brain the live GKE run hit).
func TestFailoverPromotesAllRoutedTenants(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	// genuine death (present-but-NotReady) so the second vantage confirms.
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	tenants := []string{"f0f0-base", "a000-apps"}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, tenants)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fo {
		t.Fatal("failover did not happen on a sustained genuine primary death")
	}
	// EVERY routed tenant must be promoted at gen+1 (1 -> 2), not just the base.
	for _, tn := range tenants {
		got := promoter.perTenant[tn]
		if len(got) != 1 || got[0] != 2 {
			t.Fatalf("tenant %q promoted at %v, want [2] (every routed tenant re-attached at gen+1)", tn, got)
		}
	}
	// The single shared ledger advances EXACTLY ONCE (one generation for the whole
	// plane), not once per tenant.
	if len(k8s.setGenTo) != 1 || k8s.setGenTo[0] != 2 {
		t.Fatalf("ledger advance = %v, want [2] exactly once for the whole plane", k8s.setGenTo)
	}
	if len(k8s.flippedTo) != 1 {
		t.Fatalf("Service flipped %d times, want exactly 1 (after all tenants promoted)", len(k8s.flippedTo))
	}
	if c.Metrics().Promotions() != 1 {
		t.Fatalf("promotions metric = %d, want 1 (one failover, not one per tenant)", c.Metrics().Promotions())
	}
}

// T2 — a NON-BASE routed-set entry the pageserver does not hold (an apps tenant
// that was never provisioned) may be SKIPPED only when a SECOND vantage corroborates
// the absence. A standby 404 is node-local ("I don't hold it"), never proof the
// tenant does not exist. With corroboration the failover still completes for the
// tenants that DO exist; the skip is counted, not fatal.
func TestFailoverSkipsAbsentTenant(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{notFound: map[string]bool{"a000-apps": true}}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	// Second vantage AGREES the apps tenant does not exist ⇒ nothing routed to strand.
	c.SetGenerationViewer(&fakeGenViewer{
		gens:    map[string]int{"f0f0-base": 1},
		present: map[string]bool{"f0f0-base": true, "a000-apps": false},
	})

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fo {
		t.Fatal("failover must complete for the tenants that exist even if one is absent")
	}
	if got := promoter.perTenant["f0f0-base"]; len(got) != 1 || got[0] != 2 {
		t.Fatalf("base tenant promote = %v, want [2]", got)
	}
	if got := promoter.perTenant["a000-apps"]; len(got) != 0 {
		t.Fatalf("absent tenant must not be recorded as promoted, got %v", got)
	}
	if c.Metrics().TenantAbsent() != 1 {
		t.Fatalf("tenant_absent metric = %d, want 1", c.Metrics().TenantAbsent())
	}
	if len(k8s.flippedTo) != 1 {
		t.Fatalf("Service must still flip once (base recovered), got %d flips", len(k8s.flippedTo))
	}
}

// T2 — a REAL (non-not-found) promotion error on ANY routed tenant must ABORT the
// failover before the Service flip. Flipping with a tenant left un-promoted would
// strand it on the demoted pageserver — the exact split-brain being fixed.
func TestFailoverAbortsOnRealTenantError(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{hardErr: map[string]bool{"a000-apps": true}}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})

	fo, err := c.Tick(context.Background())
	if err == nil {
		t.Fatal("a real promote error must surface (abort + retry), got nil")
	}
	if fo {
		t.Fatal("must not report failover complete when a routed tenant failed to promote")
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("Service must NOT flip while a real tenant is un-promoted (split-brain): flips=%v", k8s.flippedTo)
	}
	if len(k8s.setGenTo) != 0 {
		t.Fatalf("ledger must NOT advance while the failover is incomplete: %v", k8s.setGenTo)
	}
}

// T2 review fix (code #2) — the BASE tenant is NEVER skippable. The "nothing routed
// to strand" rationale only ever held for an unprovisioned OPTIONAL tenant; the base
// tenant is what every compute reads through. A base-tenant not-found must ABORT
// before the flip, leaving reads pointed at the (dead) primary rather than at a
// standby that does not hold the data.
func TestFailoverAbortsWhenBaseTenantNotFound(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{notFound: map[string]bool{"f0f0-base": true}}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	// Even a corroborating vantage must not license skipping the BASE tenant.
	c.SetGenerationViewer(&fakeGenViewer{present: map[string]bool{"f0f0-base": false, "a000-apps": false}})

	fo, err := c.Tick(context.Background())
	if err == nil {
		t.Fatal("a base-tenant not-found must ABORT the failover (surface an error), got nil")
	}
	if fo {
		t.Fatal("must not report a completed failover when the base tenant was not promoted")
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("Service must NOT flip when the base tenant is absent on the standby: %v", k8s.flippedTo)
	}
	if len(k8s.setGenTo) != 0 {
		t.Fatalf("ledger must NOT advance on an aborted failover: %v", k8s.setGenTo)
	}
}

// T2 review fix (arch B2) — a standby 404 is NODE-LOCAL. An apps tenant that was
// provisioned AFTER the one-shot standby warming Job ran 404s on the standby while
// being very much real, with every per-app timeline routed through it. Skipping it
// and flipping strands all of them on the demoted pageserver — the split-brain this
// change exists to close. A second vantage that reports the tenant PRESENT must abort.
func TestFailoverAbortsWhenAbsentTenantPresentOnSecondVantage(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{notFound: map[string]bool{"a000-apps": true}}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
	// The routed vantage HOLDS the apps tenant ⇒ the standby 404 is node-local only.
	c.SetGenerationViewer(&fakeGenViewer{
		gens:    map[string]int{"f0f0-base": 1, "a000-apps": 1},
		present: map[string]bool{"f0f0-base": true, "a000-apps": true},
	})

	fo, err := c.Tick(context.Background())
	if err == nil {
		t.Fatal("an apps tenant present on a second vantage must ABORT the failover, not be skipped")
	}
	if fo {
		t.Fatal("must not report a completed failover while a real routed tenant is un-promoted")
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("Service must NOT flip while a real routed tenant is un-promoted: %v", k8s.flippedTo)
	}
	if len(k8s.setGenTo) != 0 {
		t.Fatalf("ledger must NOT advance on an aborted failover: %v", k8s.setGenTo)
	}
	if c.Metrics().TenantAbsent() != 0 {
		t.Fatalf("an uncorroborated absence is not a skip; tenant_absent = %d, want 0", c.Metrics().TenantAbsent())
	}
}

// T2 review fix — fail CLOSED when the absence cannot be corroborated at all (the
// second vantage errored, or none is wired). "We could not check" must never read as
// "it does not exist".
func TestFailoverAbortsWhenAbsenceCannotBeCorroborated(t *testing.T) {
	for name, viewer := range map[string]GenerationViewer{
		"vantage errored": &fakeGenViewer{err: errors.New("pageserver unreachable")},
		"no vantage":      nil,
	} {
		t.Run(name, func(t *testing.T) {
			primary := &toggleProber{alive: false}
			standby := &toggleProber{alive: true}
			promoter := &fakePromoter{notFound: map[string]bool{"a000-apps": true}}
			k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
			c := newControllerRouted(primary, standby, promoter, k8s, 1, []string{"f0f0-base", "a000-apps"})
			if viewer != nil {
				c.SetGenerationViewer(viewer)
			}

			fo, err := c.Tick(context.Background())
			if err == nil {
				t.Fatal("an uncorroboratable absence must ABORT the failover, got nil")
			}
			if fo {
				t.Fatal("must not report a completed failover on an uncorroboratable absence")
			}
			if len(k8s.flippedTo) != 0 {
				t.Fatalf("Service must NOT flip on an uncorroboratable absence: %v", k8s.flippedTo)
			}
		})
	}
}

// T2 Part B — startup seed/heal. The durable ledger is the sole authority; pswatcher
// seeds/heals it to max(ledger, pageserver-view, 1) at startup. This auto-corrects an
// upgrade-path prune that reset/emptied the key, converting T1's loud fail-closed
// refusal into automatic recovery.
func TestStartupSeedHealsLedger(t *testing.T) {
	ctx := context.Background()

	t.Run("absent ledger + pageserver at N ⇒ healed UP to N", func(t *testing.T) {
		promoter := &fakePromoter{}
		k8s := &fakeK8s{selectorApp: "pageserver", genSet: false} // pruned/empty key
		c := newControllerRouted(&toggleProber{alive: true}, &toggleProber{alive: true}, promoter, k8s, 1, []string{"f0f0-base"})
		c.SetGenerationViewer(&fakeGenViewer{gens: map[string]int{"f0f0-base": 5}, present: map[string]bool{"f0f0-base": true}})
		if err := c.SeedLedger(ctx); err != nil {
			t.Fatal(err)
		}
		if k8s.gen != 5 || !k8s.genSet {
			t.Fatalf("ledger healed to %d (set=%v), want 5 (from the pageserver max)", k8s.gen, k8s.genSet)
		}
	})

	t.Run("low ledger + higher pageserver view ⇒ healed UP", func(t *testing.T) {
		promoter := &fakePromoter{}
		k8s := &fakeK8s{selectorApp: "pageserver", gen: 3, genSet: true}
		c := newControllerRouted(&toggleProber{alive: true}, &toggleProber{alive: true}, promoter, k8s, 1, []string{"f0f0-base"})
		c.SetGenerationViewer(&fakeGenViewer{gens: map[string]int{"f0f0-base": 7}, present: map[string]bool{"f0f0-base": true}})
		if err := c.SeedLedger(ctx); err != nil {
			t.Fatal(err)
		}
		if k8s.gen != 7 {
			t.Fatalf("ledger = %d, want healed up to 7", k8s.gen)
		}
	})

	// MUTATION GUARD: the heal must NEVER lower the ledger. A ledger ahead of the
	// pageserver's local view (e.g. a fresh-PVC pageserver that 404s / reports 1
	// while the durable ledger is 5) must be left untouched — flooring it down is
	// the silent-data-loss class T1 fenced.
	t.Run("high ledger + lower pageserver view ⇒ NOT healed down", func(t *testing.T) {
		promoter := &fakePromoter{}
		k8s := &fakeK8s{selectorApp: "pageserver", gen: 5, genSet: true}
		c := newControllerRouted(&toggleProber{alive: true}, &toggleProber{alive: true}, promoter, k8s, 1, []string{"f0f0-base"})
		c.SetGenerationViewer(&fakeGenViewer{gens: map[string]int{"f0f0-base": 1}, present: map[string]bool{"f0f0-base": true}})
		if err := c.SeedLedger(ctx); err != nil {
			t.Fatal(err)
		}
		if k8s.gen != 5 {
			t.Fatalf("ledger = %d, want 5 (heal must never lower the ledger)", k8s.gen)
		}
		if len(k8s.setGenTo) != 0 {
			t.Fatalf("no write expected when the ledger already leads: %v", k8s.setGenTo)
		}
	})

	t.Run("pageserver unreachable ⇒ ledger left as-is (no down-floor)", func(t *testing.T) {
		promoter := &fakePromoter{}
		k8s := &fakeK8s{selectorApp: "pageserver", gen: 4, genSet: true}
		c := newControllerRouted(&toggleProber{alive: true}, &toggleProber{alive: true}, promoter, k8s, 1, []string{"f0f0-base"})
		c.SetGenerationViewer(&fakeGenViewer{err: errors.New("pageserver unreachable")})
		if err := c.SeedLedger(ctx); err != nil {
			t.Fatal(err)
		}
		if k8s.gen != 4 || len(k8s.setGenTo) != 0 {
			t.Fatalf("ledger must be left at 4 when the pageserver view is unavailable, got %d writes=%v", k8s.gen, k8s.setGenTo)
		}
		// FIX 4 — a swallowed viewer error makes the heal path dead code silently.
		// A permanently broken vantage must be COUNTED (and alertable), not discarded.
		if c.Metrics().LedgerHealErrors() != 1 {
			t.Fatalf("ledger_heal_errors_total = %d, want 1 (a broken generation view must not be swallowed)", c.Metrics().LedgerHealErrors())
		}
	})
}

// T2 review fix (arch B1 / sysd Q2 / code #1) — SeedLedger must NEVER invent a value.
// The pre-fix code wrote BaseGeneration (1) whenever the key was ABSENT and the view
// was unavailable, reopening the silent floor-to-1 / data-loss class #1095 closed and
// contradicting the ledger contract ("if the view is unavailable it leaves the ledger
// untouched"; readers fail closed). Only a generation actually RECOVERED from a
// pageserver may be seeded.
func TestSeedLedgerRefusesToInventAGeneration(t *testing.T) {
	ctx := context.Background()

	cases := map[string]GenerationViewer{
		"view unreachable": &fakeGenViewer{err: errors.New("pageserver unreachable")},
		"view reports 404": &fakeGenViewer{present: map[string]bool{"f0f0-base": false}},
		"no viewer wired":  nil,
		// An ERRORED read is disqualifying on its own. A viewer that hands back a
		// generation alongside an error has not verified it, so seeding from it is
		// still inventing a number — just with extra confidence.
		"view errored but also claimed ok": &fakeGenViewer{
			gens: map[string]int{"f0f0-base": 9}, okWithErr: true, err: errors.New("partial read"),
		},
	}
	for name, viewer := range cases {
		t.Run(name+" + absent ledger ⇒ refuse, no write", func(t *testing.T) {
			k8s := &fakeK8s{selectorApp: "pageserver", genSet: false} // pruned/empty key
			c := newControllerRouted(&toggleProber{alive: true}, &toggleProber{alive: true}, &fakePromoter{}, k8s, 1, []string{"f0f0-base"})
			if viewer != nil {
				c.SetGenerationViewer(viewer)
			}
			err := c.SeedLedger(ctx)
			if err == nil {
				t.Fatal("SeedLedger must REFUSE (return an error) rather than seed an invented floor")
			}
			if len(k8s.setGenTo) != 0 || k8s.genSet {
				t.Fatalf("no ledger write may happen on an unrecovered generation: writes=%v set=%v", k8s.setGenTo, k8s.genSet)
			}
		})
	}
}

// FIX 3 — the routed-tenant set is derived from env in exactly one testable place,
// so the base-first ordering + apps-tenant de-duplication is asserted, not implied.
func TestRoutedTenantsFromEnv(t *testing.T) {
	cases := []struct {
		name, base, apps string
		want             []string
	}{
		{"base only", "f0f0", "", []string{"f0f0"}},
		{"base + apps", "f0f0", "a000", []string{"f0f0", "a000"}},
		{"apps == base is de-duplicated", "f0f0", "f0f0", []string{"f0f0"}},
		{"blank base yields nothing", "", "a000", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RoutedTenants(tc.base, tc.apps)
			if len(got) != len(tc.want) {
				t.Fatalf("RoutedTenants(%q,%q) = %v, want %v", tc.base, tc.apps, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("RoutedTenants(%q,%q) = %v, want %v (base must come FIRST — it is the promotion floor)", tc.base, tc.apps, got, tc.want)
				}
			}
		})
	}
}

// T2 — promotion idempotency + generation guard. Re-running the failover lifecycle
// (adopt path after the flip) must NOT double-advance the ledger and must never
// promote below the ledger.
func TestMultiTenantFailoverIdempotent(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true, primaryPresent: true, primaryReady: false}
	tenants := []string{"f0f0-base", "a000-apps"}
	c := newControllerRouted(primary, standby, promoter, k8s, 1, tenants)

	// Drive many ticks: one failover, then repeated adopt ticks.
	for i := 0; i < 6; i++ {
		if _, err := c.Tick(context.Background()); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	// Ledger advanced exactly once (1 -> 2), never per-tenant, never per-tick.
	if len(k8s.setGenTo) != 1 || k8s.setGenTo[0] != 2 {
		t.Fatalf("ledger advances = %v, want a single [2] (no double-advance)", k8s.setGenTo)
	}
	if k8s.gen < 2 {
		t.Fatalf("ledger = %d, must never drop below the promoted generation", k8s.gen)
	}
	for _, tn := range tenants {
		if got := promoter.perTenant[tn]; len(got) != 1 || got[0] != 2 {
			t.Fatalf("tenant %q promoted %v, want a single [2] (idempotent, no flap)", tn, got)
		}
	}
	if len(k8s.flippedTo) != 1 {
		t.Fatalf("Service flipped %d times, want exactly 1", len(k8s.flippedTo))
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
