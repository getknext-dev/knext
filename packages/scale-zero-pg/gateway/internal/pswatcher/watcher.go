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

import (
	"context"
	"errors"
	"fmt"
)

// ErrTenantNotFound is returned by a Promoter when the pageserver does not hold the
// tenant being promoted (e.g. an apps tenant that was never provisioned). On
// failover such a tenant is SKIPPED — there is nothing routed to strand — while any
// OTHER promotion error aborts the failover so a tenant that DOES exist is never
// left on the demoted pageserver (#1098).
var ErrTenantNotFound = errors.New("tenant not found on pageserver")

// Prober reports whether the primary pageserver is alive (its :9898 /v1/status).
type Prober interface {
	Alive(ctx context.Context) bool
}

// Promoter promotes the standby pageserver to AttachedSingle at a generation
// (PUT :9898/v1/tenant/<T>/location_config). It returns ErrTenantNotFound (wrapped)
// when the pageserver does not hold the tenant.
type Promoter interface {
	Promote(ctx context.Context, tenant string, generation int) error
}

// GenerationViewer reads a tenant's CURRENT generation as the pageserver reports it
// (GET :9898/v1/tenant/<T>, top-level "generation"). Used only by the startup
// seed/heal path to recover a pruned/empty ledger from the pageserver's live view.
// ok=false when the tenant is absent (404) or carries no generation field.
type GenerationViewer interface {
	Generation(ctx context.Context, tenant string) (gen int, ok bool, err error)
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
	Tenant string // BASE tenant id: seeded gen view + the routed-set floor (always promoted)
	// Tenants is the FULL routed-tenant set the flipped client Service will serve —
	// promotion scope must equal routing scope (#1098). The `pageserver` Service
	// routes EVERY tenant the plane holds: the base tenant AND the apps tenant under
	// which every per-app AppDatabase is a timeline (Neon attach/generation is
	// per-tenant, so promoting the apps tenant re-attaches all its per-app timelines
	// in one call). When empty, defaults to [Tenant] (single-tenant back-compat).
	Tenants         []string
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
	genViewer     GenerationViewer // OPTIONAL: pageserver generation view for startup seed/heal
	k8s           K8sOps
	cfg           Config
	metrics       *Metrics

	failures int
	done     bool // failover already performed (or adopted) — never re-promote

	// promotedInProcess is set once THIS instance runs failover() itself (which already
	// bounces the compute). It disambiguates the adopt path (#57): a flipped selector we
	// did NOT flip ourselves means a prior watcher may have died before bouncing.
	promotedInProcess bool
	// adoptBounced records that the compute has been bounced along the ADOPT path
	// (issue #57). A watcher that crashed in the flip→delete window resumes with the
	// selector already on the standby but a compute still pinned to the dead primary;
	// on adoption it must bounce the compute exactly once. Set only after a successful
	// DeletePods so a transient error is retried on a later tick (crash-only).
	adoptBounced bool
	// primarySeenPresent is the #58 anchor: the primary pod (PrimarySelector) has been
	// observed present at least once. Until it has, a PodReady present=false is treated
	// as "selector matches nothing" (misconfig), NOT as death — we refuse to promote.
	primarySeenPresent bool
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
	// Default the routed-tenant set to the single base tenant (back-compat) when the
	// caller did not enumerate it.
	if len(cfg.Tenants) == 0 && cfg.Tenant != "" {
		cfg.Tenants = []string{cfg.Tenant}
	}
	return &Controller{prober: p, standbyProber: standby, promoter: pr, k8s: k, cfg: cfg, metrics: m}
}

// SetGenerationViewer wires the OPTIONAL pageserver generation view used by the
// startup seed/heal path (SeedLedger). Kept off the constructor so existing callers
// and tests that never exercise seed/heal are unaffected.
func (c *Controller) SetGenerationViewer(gv GenerationViewer) { c.genViewer = gv }

// Metrics exposes the counter set (promotions, primary_up).
func (c *Controller) Metrics() *Metrics { return c.metrics }

// routedTenants returns the full set of tenants the flipped client Service serves —
// the promotion scope (#1098). Always includes the base tenant.
func (c *Controller) routedTenants() []string {
	if len(c.cfg.Tenants) > 0 {
		return c.cfg.Tenants
	}
	return []string{c.cfg.Tenant}
}

// SeedLedger seeds/heals the durable generation ledger to max(ledger, pageserver
// view, base) at startup. It is the WRITE/HEAL half of the ledger-authority contract
// (#1098): pswatcher is the sole writer + seeder/healer, and readers take
// max(ledger, pageserver, 1) fail-closed (T1, #1095). This auto-corrects an
// upgrade-path prune that emptied/reset the ledger key — the pageserver's live
// generation view recovers the true value, turning T1's loud fail-closed refusal
// into automatic recovery.
//
// It NEVER lowers the ledger: a ledger ahead of the pageserver's local view (e.g. a
// fresh-PVC pageserver that reports 1 / 404s while the durable ledger is 5) is left
// untouched — flooring it down is the silent-data-loss class T1 fenced. The
// pageserver view is best-effort: if it is unreachable, the ledger is left as-is
// (never floored on an unavailable vantage).
func (c *Controller) SeedLedger(ctx context.Context) error {
	led, ok, err := c.k8s.GetGeneration(ctx)
	if err != nil {
		return err
	}
	target := c.cfg.BaseGeneration
	if target < 1 {
		target = 1
	}
	if ok && led > target {
		target = led
	}
	if c.genViewer != nil {
		if psGen, psOK, verr := c.genViewer.Generation(ctx, c.cfg.Tenant); verr == nil && psOK && psGen > target {
			target = psGen
		}
	}
	// Write only when the key is absent (seed) or would be RAISED (heal up). Never
	// re-write an equal-or-leading ledger, and never lower it.
	if !ok || target > led {
		return c.k8s.SetGeneration(ctx, target)
	}
	return nil
}

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
		// #57 — adopt-path compute bounce. If this instance did NOT run failover()
		// itself (which already bounces the compute) but is ADOPTING a flipped selector
		// from cluster state, a prior watcher may have died in the flip→delete window,
		// leaving a compute pinned to the dead primary. Bounce it exactly once. Deleting
		// already-gone pods is a no-op (DeletePods tolerates NotFound), so this is safe
		// whether or not the bounce already happened. Retry on error (crash-only): only
		// latch adoptBounced after a successful delete.
		if !c.promotedInProcess && !c.adoptBounced {
			if _, err := c.k8s.DeletePods(ctx, c.cfg.ComputeSelector); err != nil {
				c.metrics.SetFailedOver(true)
				return false, err
			}
			c.adoptBounced = true
		}
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
		// #58 — establish the seen-present anchor during healthy operation, so a later
		// present=false can be trusted to mean "died" rather than "selector never
		// matched". Only poll the API server while UNANCHORED (normally just the first
		// healthy tick); once anchored, the healthy path costs nothing extra.
		if !c.primarySeenPresent {
			if _, present, err := c.k8s.PodReady(ctx, c.cfg.PrimarySelector); err == nil && present {
				c.primarySeenPresent = true
			}
		}
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
	if present {
		c.primarySeenPresent = true // #58 — positive confirmation we are watching the right pod
	}
	if present && ready {
		c.metrics.SuspectedPartition()
		return false, nil
	}

	// #58 — an absence we have NEVER anchored (no pod ever matched PrimarySelector) is
	// far more likely a misconfigured/drifted selector or an RBAC empty-list than a
	// genuine death. Refuse to burn the only standby on a vantage we cannot trust —
	// UNLESS the generation ledger already shows a prior promotion (gen > BaseGeneration),
	// meaning we are RESUMING a decided failover, not making a fresh one.
	if !present && !c.primarySeenPresent {
		advanced, aerr := c.ledgerAdvanced(ctx)
		if aerr != nil {
			return false, aerr
		}
		if !advanced {
			c.metrics.PrimaryNeverSeen()
			return false, nil
		}
	}

	if err := c.failover(ctx); err != nil {
		// Leave done=false so the next tick retries; the standby may just be
		// slow to accept the re-attach.
		return false, err
	}
	c.done = true
	c.promotedInProcess = true // failover() already bounced the compute — skip the adopt bounce
	c.failures = 0
	c.metrics.Promotion()
	c.metrics.SetFailedOver(true)
	return true, nil
}

// ledgerAdvanced reports whether the generation ledger has already been advanced
// beyond the base generation the primary was attached at — i.e. a prior instance
// promoted at least once. Used by the #58 anchor to let a restarted watcher RESUME a
// decided failover even when the primary pod is absent and was never locally
// anchored (an advanced ledger is independent evidence a promotion was warranted).
func (c *Controller) ledgerAdvanced(ctx context.Context) (bool, error) {
	gen, ok, err := c.k8s.GetGeneration(ctx)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil
	}
	return gen > c.cfg.BaseGeneration, nil
}

// failover runs the proven runbook, in order: promote EVERY routed tenant (fences
// the dead primary via gen+1) → persist the advanced generation ONCE → flip the
// client Service → bounce the compute so a cold wake re-attaches to the promoted
// standby.
//
// Promotion scope == routing scope (#1098): the flipped `pageserver` Service routes
// every tenant the plane holds, so ALL of them are re-attached before the flip —
// otherwise a non-base tenant is stranded on the demoted pageserver (split-brain).
// The single shared ledger advances exactly once for the whole plane; every tenant
// is promoted at that one generation (idempotent + generation-guarded — re-running
// converges and never double-advances or promotes below the ledger).
//
// Any step's error aborts BEFORE the selector flip, so reads keep pointing at the
// (dead) primary rather than a half-promoted plane. A tenant the pageserver does not
// hold (ErrTenantNotFound — e.g. an unprovisioned apps tenant) is SKIPPED, not
// stranded; any OTHER promotion error aborts (retry next tick). The flip proceeds
// only if at least one routed tenant was actually promoted.
func (c *Controller) failover(ctx context.Context) error {
	gen, ok, err := c.k8s.GetGeneration(ctx)
	if err != nil {
		return err
	}
	if !ok {
		gen = c.cfg.BaseGeneration
	}
	newGen := gen + 1

	promoted := 0
	for _, tenant := range c.routedTenants() {
		if perr := c.promoter.Promote(ctx, tenant, newGen); perr != nil {
			if errors.Is(perr, ErrTenantNotFound) {
				// Nothing routed to strand — count it (surfaces a misconfigured
				// routed set / unprovisioned apps tenant) and move on.
				c.metrics.TenantSkipped()
				continue
			}
			// A real failure on an existing tenant: abort before the flip so it is
			// never left on the demoted pageserver. Retried on the next tick; the
			// ledger has NOT advanced (SetGeneration is below), so re-promotion of
			// the already-promoted tenants stays at the same generation (idempotent).
			return perr
		}
		promoted++
	}
	if promoted == 0 {
		return fmt.Errorf("failover: no routed tenant could be promoted at generation %d (routed set: %v)", newGen, c.routedTenants())
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
