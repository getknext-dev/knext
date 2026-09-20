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
	"time"
)

// DefaultMaxFreezeDuration bounds a maintenance freeze: however far in the future an
// admin sets the freeze's `until`, the watcher clamps the EFFECTIVE expiry to
// createdAt+this, so a fat-fingered or forgotten freeze cannot silently disable HA
// indefinitely. A planned cred rotation / object-store migration fits well inside it.
const DefaultMaxFreezeDuration = 2 * time.Hour

// ErrTenantNotFound is returned by a Promoter when the pageserver being promoted
// does not hold the tenant. It is a NODE-LOCAL fact ("this pageserver does not hold
// it"), NOT evidence that the tenant does not exist: a tenant provisioned after the
// one-shot standby warming Job ran is real, routed, and still 404s on the standby.
//
// So on failover it is never trusted on its own (#1098 review):
//   - the BASE tenant is never skippable — a not-found there aborts the failover;
//   - a non-base tenant is skipped only when a SECOND vantage corroborates the
//     absence; an uncorroborated (or uncorroboratable) absence aborts before the flip
//     so per-app timelines are never stranded on the demoted pageserver.
var ErrTenantNotFound = errors.New("tenant not found on pageserver")

// ErrGenerationUnreadable is returned by a GenerationViewer when the pageserver
// ANSWERED for a tenant but its generation could not be read (a 200 whose body
// carries no `generation` field). It is deliberately an ERROR and never `ok=false`:
// every caller reads ok=false as ABSENT, and "we could not check" is never "it does
// not exist" (#1100 review, FIX 2). Conflating the two would let converge skip a
// stranded tenant silently, let the ledger heal seed off an unknown, and let
// skippable() read an unverifiable answer as a corroborated absence.
var ErrGenerationUnreadable = errors.New("pageserver reported no generation for tenant")

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
// (GET :9898/v1/tenant/<T>, top-level "generation"). ok=false when the tenant is
// absent (404) or carries no generation field.
//
// It MUST be pointed at the CURRENTLY-ROUTED pageserver — the client Service the
// gateway and computes actually dial, whose selector the failover flips — not at a
// fixed primary URL (#1098 review, FIX 1b). The primary is the node that is DOWN in
// the very failover this controller exists for, and after a failover it is the
// DEMOTED node holding the OLD (lower) generation, so seeding from it under-writes.
//
// Two paths use it, and both are fail-closed:
//   - SeedLedger: recovers a pruned/empty ledger. Only a generation actually
//     recovered here may be seeded — never an invented floor.
//   - failover: the SECOND VANTAGE that must corroborate a standby not-found before
//     a non-base routed tenant may be skipped.
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
	// API server, independent of the watcher's own HTTP path). It reports:
	//   - ready:   a pod matching selector is Running & Ready;
	//   - present: any such pod exists at all ({present:false} ⇒ the pod is gone);
	//   - running: the matching pod's container(s) are in the Running state (the
	//     PROCESS is alive), regardless of the Ready condition.
	// The `running` bit is what discriminates a dependency degradation from a node
	// death (#1099): a pod that is present + NotReady + running is a live pageserver
	// whose readiness probe (also /v1/status) is failing because a DEPENDENCY degraded
	// — e.g. object-store creds mid-rotation — NOT a dead node. A pod that is present +
	// NotReady + NOT running (container Terminated/Waiting/CrashLoopBackOff) is a
	// genuine death. A true hang (process "running" but wedged) is converted into the
	// latter by the pageserver's own livenessProbe, which restarts it into a crashloop.
	PodReady(ctx context.Context, selector string) (ready, present, running bool, err error)

	// FailoverFreeze reports the maintenance-freeze window an admin or the operator set
	// to pause failover during a planned op (cred rotation, object-store migration).
	// It returns the raw `until` expiry and the freeze's `createdAt`, plus present=false
	// when no freeze is set. The Controller — not this method — decides "active" so the
	// TTL clamp (min(until, createdAt+MaxFreeze)) is unit-tested: a stuck or fat-fingered
	// freeze can never outlive MaxFreeze from when it was created (#1099).
	FailoverFreeze(ctx context.Context) (until, createdAt time.Time, present bool, err error)
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
	// MaxFreezeDuration bounds an active maintenance freeze (see DefaultMaxFreezeDuration).
	// Zero or negative is clamped to DefaultMaxFreezeDuration in NewController.
	MaxFreezeDuration time.Duration
}

// Controller runs one Tick per poll interval. It is single-goroutine by design;
// no internal locking is needed.
type Controller struct {
	prober        Prober // probes the PRIMARY pageserver (pre-failover authority)
	standbyProber Prober // probes the STANDBY pageserver (post-failover authority)
	promoter      Promoter
	genViewer     GenerationViewer // routed-pageserver generation view (seed/heal + 2nd vantage)
	k8s           K8sOps
	cfg           Config
	metrics       *Metrics
	logger        func(format string, args ...any) // OPTIONAL diagnostics sink
	now           func() time.Time                 // clock seam; time.Now in prod, fixed in tests

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
	if cfg.MaxFreezeDuration <= 0 {
		cfg.MaxFreezeDuration = DefaultMaxFreezeDuration
	}
	// Default the routed-tenant set to the single base tenant (back-compat) when the
	// caller did not enumerate it.
	if len(cfg.Tenants) == 0 && cfg.Tenant != "" {
		cfg.Tenants = []string{cfg.Tenant}
	}
	return &Controller{prober: p, standbyProber: standby, promoter: pr, k8s: k, cfg: cfg, metrics: m, now: time.Now}
}

// SetClock overrides the wall clock used to evaluate a maintenance freeze's TTL.
// Kept off the constructor so existing callers are unaffected; tests inject a fixed
// clock so the freeze-expiry boundary is deterministic.
func (c *Controller) SetClock(now func() time.Time) { c.now = now }

// nowT is the nil-safe clock accessor.
func (c *Controller) nowT() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// freezeActive reads the maintenance-freeze window and reports whether failover is
// currently suppressed, along with the EFFECTIVE (clamped) expiry it publishes. The
// TTL bound is applied HERE, not in K8sOps, so it is unit-tested: the effective
// expiry is min(until, createdAt+MaxFreeze), so a freeze whose `until` is set far in
// the future (fat-finger) or never cleared (stuck) still lapses at
// createdAt+MaxFreeze — a stuck freeze cannot become a silent, unbounded HA outage.
//
// Errors returned here are REPORTS, not verdicts: the caller (Tick) treats any error
// as NO FREEZE and keeps HA on — see the fail-safe rationale at the call site.
//
// A freeze with a ZERO createdAt is REFUSED (an error, treated as no freeze) rather
// than honoured: without a creation anchor the TTL clamp cannot be applied at all, so
// honouring its raw `until` would be exactly the unbounded, unclampable HA suppression
// the clamp exists to prevent (#1099 review, FIX 5).
func (c *Controller) freezeActive(ctx context.Context) (active bool, effectiveUntil time.Time, err error) {
	until, createdAt, present, ferr := c.k8s.FailoverFreeze(ctx)
	if ferr != nil {
		return false, time.Time{}, ferr
	}
	if !present {
		return false, time.Time{}, nil
	}
	if createdAt.IsZero() {
		return false, time.Time{}, fmt.Errorf("maintenance freeze (until %s) has no creation timestamp to clamp against — REFUSING it (treating it as no freeze) rather than honouring an unclampable, unbounded HA suppression", until.Format(time.RFC3339))
	}
	eff := until
	if clampAt := createdAt.Add(c.cfg.MaxFreezeDuration); eff.After(clampAt) {
		eff = clampAt
	}
	return c.nowT().Before(eff), eff, nil
}

// SetGenerationViewer wires the ROUTED-pageserver generation view (see
// GenerationViewer). Kept off the constructor so existing callers and tests are
// unaffected; when it is NOT wired, both consumers fail closed rather than guess.
func (c *Controller) SetGenerationViewer(gv GenerationViewer) { c.genViewer = gv }

// SetLogger wires an optional log sink so diagnostics that must not be swallowed
// (a broken generation vantage) reach the operator's logs as well as a counter.
// The package stays dependency-free; cmd/pswatcher passes its *log.Logger's Printf.
func (c *Controller) SetLogger(f func(format string, args ...any)) { c.logger = f }

// logf is the nil-safe log sink.
func (c *Controller) logf(format string, args ...any) {
	if c.logger != nil {
		c.logger(format, args...)
	}
}

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

// SeedLedger seeds/heals the durable generation ledger at startup. It is the
// WRITE/HEAL half of the ledger-authority contract (#1098): pswatcher is the sole
// writer + seeder/healer, and readers take max(ledger, pageserver, 1) fail-closed
// (T1, #1095). This auto-corrects an upgrade-path prune that emptied/reset the ledger
// key — the routed pageserver's live generation view recovers the true value, turning
// T1's loud fail-closed refusal into automatic recovery.
//
// Two invariants, both fail-closed:
//
//  1. It NEVER lowers the ledger. A ledger ahead of the pageserver's local view (e.g.
//     a fresh-PVC pageserver that reports 1 / 404s while the durable ledger is 5) is
//     left untouched — flooring it down is the silent-data-loss class T1 fenced. When
//     the view is unavailable the ledger is left exactly as-is (never floored on an
//     unavailable vantage); the failed read is counted so a permanently broken vantage
//     is visible rather than silently turning the heal path into dead code.
//
//  2. It NEVER INVENTS a value. When the key is ABSENT, the only generation it may
//     seed is one actually RECOVERED from the routed pageserver. The pre-review code
//     wrote BaseGeneration (1) whenever the view was unavailable, which is the silent
//     floor-to-1 class #1095 closed: a "1" written on a plane that is really at 7 is
//     byte-identical to a genesis 1, so the fail-closed readers cannot tell it apart
//     and attach low. If the generation cannot be recovered, SeedLedger refuses and
//     returns an error; the readers (55-storage-init, provision-app.sh) then stay
//     fail-closed on the still-absent key, which is the loud, correct outcome.
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

	psGen, psOK, verr := c.viewGeneration(ctx, c.cfg.Tenant)
	if verr != nil {
		c.metrics.LedgerHealError()
		c.logf("[pswatcher] ledger seed/heal: routed pageserver generation view unavailable for tenant %s: %v", c.cfg.Tenant, verr)
	}
	if verr == nil && psOK && psGen > target {
		target = psGen
	}

	if !ok {
		// Absent key: seed ONLY a recovered generation, never a floor we made up.
		if verr != nil {
			return fmt.Errorf("ledger seed: the generation key is ABSENT and the routed pageserver view is unavailable (%w) — refusing to seed generation %d, which could hide a higher generation in the object store (#1095)", verr, target)
		}
		if !psOK {
			return fmt.Errorf("ledger seed: the generation key is ABSENT and the routed pageserver does not report a generation for tenant %s — refusing to seed generation %d rather than invent a floor (#1095)", c.cfg.Tenant, target)
		}
		return c.k8s.SetGeneration(ctx, target)
	}
	// Present key: heal UP only. Never re-write an equal-or-leading ledger.
	if target > led {
		return c.k8s.SetGeneration(ctx, target)
	}
	return nil
}

// viewGeneration reads the routed pageserver's generation view for a tenant. It
// centralises the "no viewer wired" case so an UNWIRED vantage is an error — i.e.
// fail-closed — rather than silently reading as "the tenant is absent".
func (c *Controller) viewGeneration(ctx context.Context, tenant string) (int, bool, error) {
	if c.genViewer == nil {
		return 0, false, errors.New("no routed-pageserver generation view is wired")
	}
	return c.genViewer.Generation(ctx, tenant)
}

// Tick performs one liveness check and, on sustained failure, one failover.
// It returns true exactly on the tick that performs the promotion.
func (c *Controller) Tick(ctx context.Context) (bool, error) {
	c.metrics.Check()

	// #1099 — read the maintenance-freeze window every tick and publish the gauge, so
	// alerting can fire while a freeze is active AND notice one that outlives its
	// planned window (a stuck freeze = silent HA outage). The gauge is refreshed on
	// EVERY path below; the freeze only SUPPRESSES the promotion itself (further down).
	//
	// FAIL-SAFE, not fail-loud (#1099 review, FIX 1). An unreadable freeze ConfigMap,
	// a malformed `until`, or a freeze with no createdAt to clamp against is treated
	// as NO FREEZE: HA stays ON and the tick runs to completion. The pre-fix code
	// ABORTED the tick here, which returned before the prober / PodReady / failover
	// path — so a PERMANENT error (a fat-fingered `until` is permanent by
	// construction) silently disabled HA forever, froze pswatcher_primary_up at its
	// last value, and fired no alert: fail-OPEN to an outage, the exact class the
	// freeze's TTL clamp exists to bound.
	//
	// The trade is deliberate and asymmetric. Skipping a freeze for ONE tick on a
	// transient API error risks a failover during a planned op (recoverable, and the
	// freeze is re-read next tick); disabling HA permanently risks an unbounded read
	// outage with no signal. So the error is COUNTED and alerted
	// (pswatcher_freeze_read_errors_total → PswatcherFreezeUnreadable) rather than
	// thrown: the counter is the ONLY way an operator learns their freeze is not
	// actually in effect.
	frozen, freezeUntil, ferr := c.freezeActive(ctx)
	if ferr != nil {
		c.metrics.FreezeReadError()
		c.logf("[pswatcher] maintenance-freeze state could not be established (%v) — proceeding with failover ENABLED (fail-safe); any freeze you set is NOT in effect", ferr)
		frozen, freezeUntil = false, time.Time{}
	}
	if frozen {
		c.metrics.SetFailoverFrozen(true, freezeUntil.Unix())
	} else {
		c.metrics.SetFailoverFrozen(false, 0)
	}

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
		// #25 — re-anchor FIRST: the promoted standby is now the SOLE read authority,
		// so probe IT (not the dead old primary) and publish its true health BEFORE any
		// step below that can fail. Ordering is load-bearing (#1100 review, FIX 1): when
		// the gauge was published last, ANY error on the converge/bounce path returned
		// from the tick with pswatcher_primary_up FROZEN at its last value — a read
		// outage with no alert, the same fail-dangerous class as the T5 freeze-read
		// abort argued against above. The old primary returning is never re-adopted: we
		// never flip the selector back.
		c.metrics.SetFailedOver(true)
		c.metrics.SetPrimaryUp(c.standbyProber.Alive(ctx))

		// T6 (#1100) — CONVERGE, don't just latch. A flipped selector means the failover
		// DECISION was made and the ledger committed to a generation; it does NOT prove
		// every routed tenant actually reached that generation on the promoted pageserver.
		// A failover killed after the flip but before a tenant was (re)attached, a tenant
		// skipped-as-absent then later warmed, a hand-patched selector (the live incident),
		// or a grown routed set all leave a tenant STRANDED at the old generation with no
		// automatic recovery under the old "adopt = bounce only" path. convergeFailover
		// re-attaches any lagging routed tenant at the SAME ledger generation — idempotent,
		// generation-guarded (never advances the ledger, never SetGeneration on this path),
		// a no-op once the routed view reports every tenant at the ledger gen, and fail-safe
		// when the vantage cannot verify. Run it BEFORE the bounce so a bounced compute
		// re-attaches to a fully-promoted plane.
		//
		// BEST-EFFORT, never a gate (#1100 review, FIX 1). A failing converge must NOT
		// abort the rest of this tick: gating the adopt bounce on it means that while a
		// promote keeps failing, a compute still pinned to the DEAD primary is never
		// bounced — turning a per-tenant promote failure into an unbounded compute
		// outage, the exact outage T6 exists to bound. So the error is COUNTED
		// (converge_errors_total → PswatcherConvergeFailing) and logged, the tick runs
		// to completion, and the error is returned at the END for the run loop to log.
		// It is retried on the next tick: converge is observation-driven and idempotent,
		// so a later tick re-attempts exactly the tenants still below the ledger gen.
		convErr := c.convergeFailover(ctx)
		if convErr != nil {
			c.metrics.ConvergeError()
			c.logf("[pswatcher] converge: could not complete the adopt-path convergence (%v) — the tick CONTINUES (health + adopt bounce still run); retrying next tick", convErr)
		}
		// #57 — adopt-path compute bounce. If this instance did NOT run failover()
		// itself (which already bounces the compute) but is ADOPTING a flipped selector
		// from cluster state, a prior watcher may have died in the flip→delete window,
		// leaving a compute pinned to the dead primary. Bounce it exactly once. Deleting
		// already-gone pods is a no-op (DeletePods tolerates NotFound), so this is safe
		// whether or not the bounce already happened. Retry on error (crash-only): only
		// latch adoptBounced after a successful delete.
		if !c.promotedInProcess && !c.adoptBounced {
			if _, err := c.k8s.DeletePods(ctx, c.cfg.ComputeSelector); err != nil {
				return false, errors.Join(convErr, err)
			}
			c.adoptBounced = true
		}
		// Report the converge failure LAST — after the health gauge and the bounce have
		// both already happened — so the run loop logs it without any of them having
		// been skipped.
		return false, convErr
	}

	if c.prober.Alive(ctx) {
		c.failures = 0
		c.metrics.SetPrimaryUp(true)
		// #58 — establish the seen-present anchor during healthy operation, so a later
		// present=false can be trusted to mean "died" rather than "selector never
		// matched". Only poll the API server while UNANCHORED (normally just the first
		// healthy tick); once anchored, the healthy path costs nothing extra.
		if !c.primarySeenPresent {
			if _, present, _, err := c.k8s.PodReady(ctx, c.cfg.PrimarySelector); err == nil && present {
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
	//   probe fails + pod Running&Ready       → a WATCHER-SIDE partition, not primary
	//                                            death → hold, count it, keep the standby.
	//   probe fails + pod NotReady + RUNNING  → a DEPENDENCY degraded (#1099), not a
	//                                            death → hold, count it, keep the standby.
	//   probe fails + pod NotReady + not-run  → container gone/crashing → genuinely down
	//                                            → promote.
	//   probe fails + pod absent              → the primary is genuinely gone → promote.
	//   API unreachable                       → cannot corroborate → refuse to promote
	//                                            (never burn the only standby on one vantage).
	ready, present, running, err := c.k8s.PodReady(ctx, c.cfg.PrimarySelector)
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

	// #1099 — dependency-degradation discrimination. The pageserver's readiness probe
	// is also /v1/status, so an object-store degradation (e.g. creds mid-rotation)
	// makes the pod NotReady and our HTTP probe fail while the PROCESS is still alive
	// (its container is Running). Promoting on that is exactly the needless,
	// standby-consuming failover that caused the live split-brain. Hold and count.
	// This is not a false-negative on a genuine hang: the pageserver's own
	// livenessProbe restarts a wedged process, turning it into a CrashLoopBackOff
	// (container NOT running), at which point the branch below promotes.
	if present && !ready && running {
		c.metrics.DependencyDegraded()
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

	// #1099 — maintenance freeze suppresses even a CONFIRMED death. A planned op (cred
	// rotation, object-store migration) is EXPECTED to make the primary briefly
	// unreachable — even to restart its pod — and a failover then needlessly consumes
	// the standby. The freeze is TTL-bounded (freezeActive clamps to
	// createdAt+MaxFreezeDuration), so it can never silently disable HA forever; the
	// active gauge + expiry metric make a stuck freeze alertable. We suppress AFTER the
	// death is confirmed so the suppressed-count reflects real would-be failovers.
	if frozen {
		c.metrics.FreezeSuppressed()
		return false, nil
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
	// Classify the failover so a scraper can prove the watcher discriminated a genuine
	// death from a non-death event (the failover drill asserts this labeled sample).
	c.metrics.SetFailoverReason("node_death")
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

// convergeFailover drives an already-flipped (adopted) failover to COMPLETENESS,
// idempotently. It re-attaches any routed tenant that the currently-routed (promoted)
// pageserver reports BELOW the ledger generation, at that SAME generation — the
// airtight generation-guard: it NEVER advances the ledger and NEVER promotes above it,
// so re-running converges without creating a second writer or a double generation
// advance. It is OBSERVATION-driven, so a plane the view already reports at the ledger
// generation is a silent no-op (no flap, no cost beyond the reads), and it self-heals a
// tenant that reappears un-attached on a later tick (skipped-then-warmed apps tenant,
// hand-patched selector, grown routed set).
//
// Bounds MTTR: each lagging tenant is re-attached in a single tick once the view
// reports it below the ledger gen, so convergence completes within one poll interval of
// the vantage becoming readable — no unbounded, hands-off stranding.
//
// Fail-safe: an UNWIRED or ERRORING view for a tenant does NOT re-promote it (promoting
// on an unreadable vantage is exactly the guess this controller refuses everywhere
// else); the block is counted (ConvergeBlocked → ConvergeBlockedTotal) so a permanently
// blind vantage over a stranded tenant is visible rather than silent. A base generation
// (or absent) ledger is not a promotion this controller performed, so there is nothing
// to converge above it — return early.
func (c *Controller) convergeFailover(ctx context.Context) error {
	gen, ok, err := c.k8s.GetGeneration(ctx)
	if err != nil {
		return err
	}
	if !ok || gen <= c.cfg.BaseGeneration {
		return nil
	}
	var errs []error
	for _, tenant := range c.routedTenants() {
		observed, present, verr := c.viewGeneration(ctx, tenant)
		if verr != nil {
			// Cannot verify this tenant's generation — refuse to re-promote on an
			// unreadable vantage (fail-safe); surface it so it is not silent. This
			// includes a pageserver that ANSWERED without a generation field
			// (ErrGenerationUnreadable): unverifiable is never "absent" (FIX 2).
			c.metrics.ConvergeBlocked()
			c.logf("[pswatcher] converge: generation view unavailable for routed tenant %s (%v) — NOT re-promoting on an unreadable vantage", tenant, verr)
			continue
		}
		if !present {
			// The promoted pageserver genuinely does not hold this tenant (404):
			// unprovisioned, or never warmed here. There is nothing to re-attach, and
			// attaching a tenant this pageserver does not hold is not converge's job —
			// but it is NOT healthy either, so it is COUNTED rather than silently
			// skipped (#1100 review, FIX 2): a routed tenant absent from the promoted
			// pageserver is a routed tenant nobody can reach, and without this counter
			// it stays stranded forever and invisibly. A tenant that later appears is
			// converged on the tick after the view reports it.
			c.metrics.ConvergeTenantAbsent()
			c.logf("[pswatcher] converge: the promoted pageserver does not hold routed tenant %s — nothing to re-attach; it is UNCONVERGED until it appears (check the routed-tenant set and standby warming)", tenant)
			continue
		}
		if observed >= gen {
			continue // already at (or beyond) the ledger generation — converged, no-op.
		}
		// Lagging: re-attach at the SAME ledger generation. Idempotent (a re-PUT at an
		// already-held generation is a no-op on the pageserver) and generation-guarded
		// (never gen+1, never a ledger write here), so this can never double-advance or
		// create a second writer.
		if perr := c.promoter.Promote(ctx, tenant, gen); perr != nil {
			if errors.Is(perr, ErrTenantNotFound) {
				// The pageserver reports it does not hold the tenant AFTER the routed
				// view said it did — a race with a detach, or a vantage/promote target
				// disagreement. Same disposition as an absent tenant: nothing to
				// re-attach, counted, never a reason to abandon the OTHER tenants.
				c.metrics.ConvergeTenantAbsent()
				c.logf("[pswatcher] converge: re-attach of routed tenant %s returned not-found (%v) — counted as unconverged, continuing with the remaining tenants", tenant, perr)
				continue
			}
			// One tenant's failure must never abandon the others (a base tenant that
			// CAN converge must not be held hostage by a failing apps tenant); collect
			// and keep going, then report.
			errs = append(errs, fmt.Errorf("converge %s at generation %d: %w", tenant, gen, perr))
			continue
		}
		c.metrics.ConvergeRepromotion()
	}
	return errors.Join(errs...)
}

// skippable decides whether a routed tenant the STANDBY reports as not-found may be
// skipped, given its index in the routed set. `PUT location_config` → 404 is a
// node-local fact, so on its own it is never licence to flip (#1098 review, FIX 2):
//
//   - index 0 is the BASE tenant, which every compute reads through. It is NEVER
//     skippable — a not-found there aborts the failover, keeping reads on the (dead)
//     primary rather than moving them to a standby that does not hold the data.
//   - a non-base tenant (today: the apps tenant, under which every per-app
//     AppDatabase is a timeline) requires a SECOND VANTAGE to corroborate the
//     absence. The standby's warming is best-effort and one-shot, so an apps tenant
//     provisioned AFTER standby-init is real, routed, and still 404s there; skipping
//     it and flipping would strand every per-app timeline on the demoted pageserver.
//   - "we could not check" is never "it does not exist": an errored or unwired
//     vantage aborts. In practice that makes standby warming of a DECLARED apps
//     tenant a precondition for automatic failover, which is the intended posture —
//     a blocked, loud, retrying failover beats a silent split-brain.
func (c *Controller) skippable(ctx context.Context, idx int, tenant string) (bool, error) {
	if idx == 0 {
		return false, fmt.Errorf("failover: the BASE tenant %s is not held by the standby — aborting before the flip (a flip now would point every compute at a pageserver without its data); warm/attach it on the standby and retry", tenant)
	}
	_, present, err := c.viewGeneration(ctx, tenant)
	if err != nil {
		return false, fmt.Errorf("failover: routed tenant %s is not held by the standby and the second vantage could not corroborate the absence (%w) — aborting before the flip rather than stranding its timelines on the demoted pageserver", tenant, err)
	}
	if present {
		return false, fmt.Errorf("failover: routed tenant %s is not held by the standby but IS present from the routed vantage — the standby was never warmed for it; aborting before the flip (retry next tick) rather than stranding its per-app timelines", tenant)
	}
	return true, nil
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
// (dead) primary rather than a half-promoted plane. Any promotion error aborts
// (retry next tick). A standby not-found is NOT automatically a skip — see
// ErrTenantNotFound and skippable() below: the base tenant is never skippable, and a
// non-base tenant is skipped only on a corroborated absence. The flip proceeds only
// if at least one routed tenant was actually promoted.
//
// The generation itself is fail-closed (#1098 review, code #5): an ABSENT ledger key
// is never floored to BaseGeneration, because promoting at 2 on a plane that is
// really at 7 re-attaches below the object-store index. It is recovered from the
// routed pageserver view, or the failover aborts.
func (c *Controller) failover(ctx context.Context) error {
	gen, ok, err := c.k8s.GetGeneration(ctx)
	if err != nil {
		return err
	}
	if !ok {
		recovered, rok, rerr := c.viewGeneration(ctx, c.cfg.Tenant)
		if rerr != nil {
			return fmt.Errorf("failover: the generation ledger key is ABSENT and the routed pageserver view is unavailable (%w) — refusing to promote at an invented generation (#1095)", rerr)
		}
		if !rok {
			return fmt.Errorf("failover: the generation ledger key is ABSENT and the routed pageserver reports no generation for base tenant %s — refusing to promote at an invented generation (#1095)", c.cfg.Tenant)
		}
		gen = recovered
		if gen < c.cfg.BaseGeneration {
			gen = c.cfg.BaseGeneration
		}
	}
	newGen := gen + 1

	routed := c.routedTenants()
	promoted := 0
	for i, tenant := range routed {
		if perr := c.promoter.Promote(ctx, tenant, newGen); perr != nil {
			if errors.Is(perr, ErrTenantNotFound) {
				skip, serr := c.skippable(ctx, i, tenant)
				if serr != nil {
					return serr
				}
				if skip {
					// Corroborated absent from two vantages — nothing routed to
					// strand. Count it (surfaces a misconfigured routed set / an
					// unprovisioned apps tenant) and move on.
					c.metrics.TenantSkipped()
					continue
				}
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
		return fmt.Errorf("failover: no routed tenant could be promoted at generation %d (routed set: %v)", newGen, routed)
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
