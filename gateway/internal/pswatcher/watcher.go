// Package pswatcher is the pageserver auto-failover controller. The MVP's single
// pageserver is the read authority; the reviews flagged its loss as an unbounded
// read outage. This watcher converts the proven MANUAL runbook (promote a warm
// Secondary at generation+1, flip the client Service selector, bounce the
// compute) into an automatic action driven by primary liveness — no human step.
//
// The generation+1 re-attach fences the dead primary (single-writer is intrinsic
// to Neon; the higher generation wins). Generation is persisted in a ConfigMap so
// repeated failovers over the cluster's life keep incrementing, and a restarted
// watcher never re-uses a stale generation.
package pswatcher

import "context"

// Prober reports whether the primary pageserver is alive (its :9898 /v1/status).
type Prober interface {
	Alive(ctx context.Context) bool
}

// Promoter promotes the standby pageserver to AttachedSingle at a generation
// (PUT :9898/v1/tenant/<T>/location_config).
type Promoter interface {
	Promote(ctx context.Context, tenant string, generation int) error
}

// K8sOps is the Kubernetes surface the watcher drives. Kept minimal so the
// RBAC stays tight (services get/patch, configmaps get/update, pods list/delete).
type K8sOps interface {
	// ServiceSelectorApp returns the client Service's current spec.selector["app"].
	ServiceSelectorApp(ctx context.Context, service string) (string, error)
	// FlipServiceSelector patches the client Service selector to {app: app}.
	FlipServiceSelector(ctx context.Context, service, app string) error
	// DeletePods deletes pods matching selector; returns the count deleted.
	DeletePods(ctx context.Context, selector string) (int, error)
	// GetGeneration reads the persisted generation; ok=false when unset.
	GetGeneration(ctx context.Context) (gen int, ok bool, err error)
	// SetGeneration persists the generation.
	SetGeneration(ctx context.Context, gen int) error
	// PodReady is the SECOND vantage on primary liveness (the kubelet's view via the
	// API server, independent of the watcher's own HTTP path). It reports whether a
	// pod matching selector is Running & Ready (ready) and whether any such pod
	// exists at all (present). {present:false} ⇒ the primary pod is genuinely gone.
	PodReady(ctx context.Context, selector string) (ready, present bool, err error)
}

// Config is the watcher's static wiring.
type Config struct {
	Tenant          string // tenant id whose read authority we fail over
	ClientService   string // Service whose selector clients (computes) resolve
	StandbyApp      string // app label the ClientService flips TO on failover
	ComputeSelector string // label selector for compute pods to bounce
	PrimarySelector string // label selector for the primary pageserver pod (second-vantage check)
	FailThreshold   int    // consecutive failed probes before promoting
	BaseGeneration  int    // generation the primary was attached at (storage-init: 1)
}

// Controller runs one Tick per poll interval. It is single-goroutine by design;
// no internal locking is needed.
type Controller struct {
	prober        Prober // probes the PRIMARY pageserver (pre-failover authority)
	standbyProber Prober // probes the STANDBY pageserver (post-failover authority)
	promoter      Promoter
	k8s           K8sOps
	cfg           Config
	metrics       *Metrics

	failures int
	done     bool // failover already performed (or adopted) — never re-promote
}

// NewController wires a Controller. FailThreshold < 1 is clamped to 1. The standby
// prober lets the watcher re-anchor its liveness view onto the node it promoted
// once the client Service has flipped (issue #25).
func NewController(p, standby Prober, pr Promoter, k K8sOps, cfg Config, m *Metrics) *Controller {
	if cfg.FailThreshold < 1 {
		cfg.FailThreshold = 1
	}
	if cfg.BaseGeneration < 1 {
		cfg.BaseGeneration = 1
	}
	return &Controller{prober: p, standbyProber: standby, promoter: pr, k8s: k, cfg: cfg, metrics: m}
}

// Metrics exposes the counter set (promotions, primary_up).
func (c *Controller) Metrics() *Metrics { return c.metrics }

// Tick performs one liveness check and, on sustained failure, one failover.
// It returns true exactly on the tick that performs the promotion.
func (c *Controller) Tick(ctx context.Context) (bool, error) {
	c.metrics.Check()

	// Re-anchor the authority from the CURRENT Service selector every tick. This is
	// the crash-only truth source: a restarted watcher (and one that already failed
	// over in-process) learns from the cluster, not stale memory. Once the client
	// Service points at the standby, a failover happened — adopt it.
	failedOver := c.done
	if app, err := c.k8s.ServiceSelectorApp(ctx, c.cfg.ClientService); err == nil && app == c.cfg.StandbyApp {
		failedOver = true
	}
	c.done = failedOver

	if failedOver {
		// #25 — re-anchor: the promoted standby is now the SOLE read authority. Probe
		// IT (not the dead old primary) and report ITS true health, so primary_up
		// cannot read a false "healthy" after our own action. The old primary
		// returning is never re-adopted: we never flip the selector back.
		c.metrics.SetFailedOver(true)
		c.metrics.SetPrimaryUp(c.standbyProber.Alive(ctx))
		return false, nil
	}

	if c.prober.Alive(ctx) {
		c.failures = 0
		c.metrics.SetPrimaryUp(true)
		return false, nil
	}

	c.failures++
	c.metrics.SetPrimaryUp(false)
	if c.failures < c.cfg.FailThreshold {
		return false, nil // a blip — don't split-brain a slow primary
	}

	// #26 — second-vantage confirmation before an irreversible, standby-consuming
	// promotion. Our HTTP probe only reflects OUR network path to the primary. Ask
	// the API server (the kubelet's independent view):
	//   probe fails + pod Running&Ready   → a WATCHER-SIDE partition, not primary
	//                                        death → hold, count it, keep the standby.
	//   probe fails + pod NotReady/absent  → the primary is genuinely down → promote.
	//   API unreachable                    → cannot corroborate → refuse to promote
	//                                        (never burn the only standby on one vantage).
	ready, present, err := c.k8s.PodReady(ctx, c.cfg.PrimarySelector)
	if err != nil {
		return false, err
	}
	if present && ready {
		c.metrics.SuspectedPartition()
		return false, nil
	}

	if err := c.failover(ctx); err != nil {
		// Leave done=false so the next tick retries; the standby may just be
		// slow to accept the re-attach.
		return false, err
	}
	c.done = true
	c.failures = 0
	c.metrics.Promotion()
	c.metrics.SetFailedOver(true)
	return true, nil
}

// failover runs the proven runbook, in order: promote (fences the dead primary
// via gen+1) → persist the advanced generation → flip the client Service →
// bounce the compute so a cold wake re-attaches to the promoted standby. Any
// step's error aborts before the selector flip, so reads keep pointing at the
// (dead) primary rather than a half-promoted standby.
func (c *Controller) failover(ctx context.Context) error {
	gen, ok, err := c.k8s.GetGeneration(ctx)
	if err != nil {
		return err
	}
	if !ok {
		gen = c.cfg.BaseGeneration
	}
	newGen := gen + 1

	if err := c.promoter.Promote(ctx, c.cfg.Tenant, newGen); err != nil {
		return err
	}
	if err := c.k8s.SetGeneration(ctx, newGen); err != nil {
		return err
	}
	if err := c.k8s.FlipServiceSelector(ctx, c.cfg.ClientService, c.cfg.StandbyApp); err != nil {
		return err
	}
	if _, err := c.k8s.DeletePods(ctx, c.cfg.ComputeSelector); err != nil {
		return err
	}
	return nil
}
