package pswatcher

import (
	"context"
	"errors"
	"testing"
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
	calls    []int // generations promoted at, in order
	failFor  int   // fail the first failFor calls
	tenantOK string
	err      error
}

func (p *fakePromoter) Promote(_ context.Context, tenant string, gen int) error {
	p.tenantOK = tenant
	if p.failFor > 0 {
		p.failFor--
		return errors.New("promote refused (standby not ready)")
	}
	p.calls = append(p.calls, gen)
	return nil
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
}

func (k *fakeK8s) PodReady(_ context.Context, _ string) (bool, bool, error) {
	if k.podReadyErr != nil {
		return false, false, k.podReadyErr
	}
	return k.primaryReady, k.primaryPresent, nil
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
	return NewController(p, sb, pr, k, Config{
		Tenant:          "f0f0",
		ClientService:   "pageserver",
		StandbyApp:      "pageserver-standby",
		ComputeSelector: "app=compute",
		PrimarySelector: "app=pageserver",
		FailThreshold:   threshold,
		BaseGeneration:  1,
	}, NewMetrics())
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
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true}
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
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true}
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

// If the ConfigMap has no generation yet, fall back to the base generation the
// primary was attached at (storage-init used gen 1), so we promote at 2.
func TestGenerationFallsBackToBase(t *testing.T) {
	prober := &fakeProber{seq: []bool{false}, last: false}
	promoter := &fakePromoter{}
	k8s := &fakeK8s{selectorApp: "pageserver", genSet: false}
	c := newController(prober, promoter, k8s, 1)

	if _, err := c.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(promoter.calls) != 1 || promoter.calls[0] != 2 {
		t.Fatalf("promote calls = %v, want [2] (base gen 1 -> 2)", promoter.calls)
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
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true}
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
	k8s := &fakeK8s{selectorApp: "pageserver", gen: 1, genSet: true} // primaryPresent=false ⇒ genuine death
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
		{"probe fails + pod absent ⇒ genuine death ⇒ promote", false, false, true, false},
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

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
