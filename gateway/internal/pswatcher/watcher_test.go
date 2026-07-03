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
	return NewController(p, pr, k, Config{
		Tenant:          "f0f0",
		ClientService:   "pageserver",
		StandbyApp:      "pageserver-standby",
		ComputeSelector: "app=compute",
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
