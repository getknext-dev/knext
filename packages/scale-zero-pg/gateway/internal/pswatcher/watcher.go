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
//
// As of D2 (ADR-0010 §5) this is DEFENCE-IN-DEPTH, not the primary detector: the live
// pageserver's PUT location_config returns 200 and ATTACHES a phantom empty tenant for
// a tenant it does not hold — it never 404s — so failover's absence check now runs off
// the STANDBY generation VIEW (the GET vantage, which does 404) BEFORE the PUT. This
// mapping is kept for a future pageserver that restores the 404 on PUT.
var ErrTenantNotFound = errors.New("tenant not found on pageserver")

// ErrGenerationUnreadable is returned by a GenerationViewer when the pageserver
// ANSWERED for a tenant but its generation could not be read (a 200 whose body
// carries no `generation` field). It is deliberately an ERROR and never `ok=false`:
// every caller reads ok=false as ABSENT, and "we could not check" is never "it does
// not exist" (#1100 review, FIX 2). Conflating the two would let converge skip a
// stranded tenant silently, let the ledger heal seed off an unknown, and let
// skippable() read an unverifiable answer as a corroborated absence.
var ErrGenerationUnreadable = errors.New("pageserver reported no generation for tenant")

// ErrTenantShardsUnreadable is returned by a TenantMembershipViewer when the pageserver
// answered 200 but its /v1/location_config body carries no usable `tenant_shards` list.
// Like ErrGenerationUnreadable it is an ERROR and never held=false: an unreadable
// listing is not proof the standby lacks the tenant.
var ErrTenantShardsUnreadable = errors.New("pageserver reported no tenant_shards listing")

// ErrNoStandbyMembership is returned when the failover pre-flight has no standby
// membership oracle wired. It is a HARD failure, never a fall-through: without the
// oracle the only remaining "does the standby hold it?" signal is the PUT, and the live
// PUT 200-attaches a phantom EMPTY tenant instead of reporting not-held (ADR-0010 §5).
// An unwired oracle is reached by OMISSION (a build or deployment that forgot the
// wiring), so failing open here would reinstate the phantom-attach split-brain silently.
var ErrNoStandbyMembership = errors.New("no standby membership oracle wired")

// ErrLedgerConflict is returned by K8sOps.SetGeneration when the ledger write LOST an
// optimistic-concurrency (resourceVersion) CAS — another writer advanced the ledger
// between our read and our write (D4, ADR-0010 §4). It is the ONLY safe signal in the
// two-writers-during-a-partition window (Recreate guarantees single-writer against a
// ROLLOUT, not against a node partition: a force-deleted Node object lets a new pswatcher
// start while the old one may still run on the isolated kubelet). The loser MUST abort the
// tick and MUST NEVER retry at the winner's value — adopting the winner's generation
// mid-failover is exactly how two writers both come to believe they are current.
var ErrLedgerConflict = errors.New("generation ledger CAS conflict (a concurrent writer advanced it)")

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

// SecondaryWarmer registers a tenant as a WARM Secondary on the pageserver at an
// EXPLICIT baseURL (PUT baseURL/v1/tenant/<T>/location_config, mode Secondary,
// secondary_conf.warm:true) and kicks a layer download. It is the write half of the D1
// reconciling standby-warm loop.
//
// baseURL is a parameter, not fixed, because the node that is currently the STANDBY
// swaps after a failover (the rebuilt ex-primary becomes the new standby); the loop
// resolves that node each reconcile and points the warm PUT at it — NEVER at the live
// primary, which a Secondary registration would demote.
type SecondaryWarmer interface {
	WarmSecondary(ctx context.Context, baseURL, tenant string) error
}

// StandbyMembershipAt answers HoldsTenant against an EXPLICIT baseURL — the plane-wide
// GET baseURL/v1/location_config listing (the only vantage that sees a warm Secondary,
// ADR-0010 §5). The reconcile must probe whichever node is currently the standby, which
// swaps after a failover, so it cannot use the fixed-URL failover oracle
// (TenantMembershipViewer). Same fail-closed contract: held=false means only "the node
// answered 200 and did not list it"; every unreadable answer is an ERROR.
//
// It reports the location MODE as well, and that is load-bearing rather than
// informational. After the COMMON failover variant — pod restart with the PVC INTACT
// (53-pageserver.yaml retains it) — the ex-primary reloads its persisted AttachedSingle
// at the OLD generation and IS listed. A membership-only answer makes the reconcile
// skip the warm PUT and publish standby_tenant_warm=1, i.e. "HA armed", for a node that
// is not an armed standby at all — weaker than the one-shot Job this loop replaces.
// attached=true is only meaningful when held=true.
type StandbyMembershipAt interface {
	HoldsTenantAt(ctx context.Context, baseURL, tenant string) (held, attached bool, err error)
}

// TenantMembershipViewer answers "does this pageserver HOLD this tenant?" in ANY
// location mode — Attached* or Secondary — from the plane-wide
// GET :9898/v1/location_config listing (see HTTPTenantMembershipViewer).
//
// It exists because no PER-TENANT endpoint can answer that question on a standby:
// a warm standby holds its routed tenants as SECONDARIES, for which (live-verified)
// GET /v1/tenant/<T> returns 503 and GET /v1/tenant/<T>/location_config returns 404.
// Using the generation view as the oracle therefore aborts EVERY failover on a real
// plane, which is the same HA-dead outcome by a different route.
//
// It is pointed at the STANDBY — the promotion target — and it is the failover's
// held/not-held pre-flight: the PUT cannot be, since the live PUT 200-attaches a
// phantom empty tenant instead of reporting not-held (ADR-0010 §5).
//
// held=false means only "the pageserver answered and the tenant is not in its list".
// Anything unreadable is an ERROR, so the failover can abort rather than mistake
// "unverifiable" for "absent".
type TenantMembershipViewer interface {
	HoldsTenant(ctx context.Context, tenant string) (held bool, err error)
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
	// GetGeneration reads the persisted generation; ok=false when unset. rv is the
	// ledger ConfigMap's resourceVersion at the moment of the read — the token a
	// subsequent SetGeneration passes back to CAS its write against it (D4). rv is empty
	// only when the ConfigMap itself is absent (nothing to CAS against yet).
	GetGeneration(ctx context.Context) (gen int, ok bool, rv string, err error)
	// SetGeneration persists the generation under an optimistic-concurrency precondition
	// (D4, ADR-0010 §4): when rv is non-empty the write is a CAS against that
	// resourceVersion, so a racing writer that advanced the ledger since rv was read makes
	// this return ErrLedgerConflict rather than silently CLOBBERING the higher write. An
	// empty rv performs an unconditional write (startup seed, where there is no prior
	// version to guard).
	SetGeneration(ctx context.Context, gen int, rv string) error
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

	// WarmTargets maps a pageserver app label to the base URL at which THAT node's
	// pageserver HTTP API is reachable via its STABLE per-node Service (never the flipped
	// client Service). The D1 reconciling standby-warm loop uses it to resolve which node
	// is currently the STANDBY — the node the client Service does NOT select — and warm
	// ONLY it. Registering a Secondary on the live PRIMARY would demote the writer, so a
	// selector that resolves to no known node (or cannot be read) aborts the reconcile
	// rather than guess. Empty disables the loop (back-compat).
	WarmTargets map[string]string
	// WarmInterval is the minimum spacing between standby-warm reconciles, so the loop
	// re-arms within one interval of a failover without hammering the standby every poll.
	// Zero runs the reconcile every tick (used by tests); the loop is a no-op unless a
	// SecondaryWarmer + StandbyMembershipAt are wired and WarmTargets is non-empty.
	WarmInterval time.Duration
	// WarmDeadline is the TOTAL wall-clock bound on ONE standby-warm pass. A pass is
	// serial over the routed tenants and each tenant costs a membership GET plus, when
	// it is absent, a warm PUT and a download kick — so an unbounded pass against a
	// standby wedged on its object store can occupy the single control goroutine for far
	// longer than the primary-death detection window. The pass is cut short at this
	// deadline (counted, never reported as warm) and resumes next interval; it is
	// idempotent and per-tenant, so partial progress is kept. Zero disables the bound
	// (tests, and back-compat for callers that do not set it).
	WarmDeadline time.Duration
}

// Controller runs one Tick per poll interval. It is single-goroutine by design;
// no internal locking is needed.
type Controller struct {
	prober        Prober // probes the PRIMARY pageserver (pre-failover authority)
	standbyProber Prober // probes the STANDBY pageserver (post-failover authority)
	promoter      Promoter
	genViewer     GenerationViewer // routed-pageserver generation view (seed/heal + 2nd vantage)
	// standbyMembership is the held/not-held oracle pointed at the STANDBY (the
	// promotion TARGET): the plane-wide /v1/location_config listing, the only vantage
	// that sees a tenant held as a warm SECONDARY. It is the failover's absence
	// detector, because neither of the alternatives works on a real plane — the PUT
	// 200-ATTACHES a phantom empty tenant instead of reporting not-held (ADR-0010 §5),
	// and the per-tenant GET 503s on a Secondary. failover() asks THIS oracle before
	// every PUT, for every routed tenant, and a not-held tenant feeds skippable()
	// UNCHANGED (base aborts; a non-base tenant needs routed-vantage corroboration).
	// UNWIRED IS A HARD ABORT, not a fall-through (see ErrNoStandbyMembership). The
	// PUT-404→ErrTenantNotFound path is retained as defence-in-depth only.
	standbyMembership TenantMembershipViewer
	k8s               K8sOps
	cfg               Config
	metrics           *Metrics
	logger            func(format string, args ...any) // OPTIONAL diagnostics sink
	now               func() time.Time                 // clock seam; time.Now in prod, fixed in tests

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

	// reservedGen is the generation THIS instance CAS-reserved in the ledger before
	// promoting (D4, ADR-0010 §4). It is the crash-resume seam WITHIN one instance: once
	// reserve-before-promote has advanced the ledger, a failover retried after a PARTIAL
	// promotion (a later tenant's PUT failed and aborted the tick) must promote at the
	// SAME reserved generation, not ledger+1 — otherwise a transient promote error would
	// double-advance the ledger every tick. Zero means "no reservation held by this
	// instance"; a restarted instance starts at zero and re-derives from the ledger +
	// selector (the crash-only truth across restarts is convergeFailover, not this field).
	reservedGen int

	// warmer + warmMembership drive the D1 reconciling standby-warm loop. Both take an
	// EXPLICIT node URL because the standby swaps after a failover; the loop resolves the
	// standby each interval and points them at it. Unwired ⇒ the loop is a no-op.
	warmer         SecondaryWarmer
	warmMembership StandbyMembershipAt
	// lastWarmAt throttles the reconcile to cfg.WarmInterval (uses the clock seam).
	lastWarmAt time.Time
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

// SetStandbyMembershipViewer wires the STANDBY held/not-held oracle (see
// standbyMembership + TenantMembershipViewer): the plane-wide /v1/location_config
// listing, the only vantage that sees a tenant held as a warm Secondary. It is the
// failover absence detector that neither the PUT (200-attaches a phantom tenant rather
// than 404ing) nor the per-tenant GET (503s on a Secondary) can be — ADR-0010 §5.
// Kept off the constructor so existing callers/tests are unaffected, but when it is NOT
// wired failover() ABORTS (ErrNoStandbyMembership) — it never falls back to the PUT.
func (c *Controller) SetStandbyMembershipViewer(mv TenantMembershipViewer) {
	c.standbyMembership = mv
}

// standbyHoldsTenant is the failover pre-flight's single entry point to the standby
// membership oracle. Both fail-closed cases live HERE, not at the call site, so no
// caller can reach the PUT without an answer: an UNWIRED oracle is an error (never a
// fall-through to the dead PUT-404 detector), and a read failure is propagated as an
// error (never "not held", which skippable() could corroborate into a skip).
func (c *Controller) standbyHoldsTenant(ctx context.Context, tenant string) (bool, error) {
	if c.standbyMembership == nil {
		return false, fmt.Errorf("failover: %w — refusing to attach routed tenant %s onto an unverified standby (the PUT 200-attaches a phantom empty tenant when the standby does not hold it, so without this oracle a never-warmed standby fails SILENTLY)", ErrNoStandbyMembership, tenant)
	}
	return c.standbyMembership.HoldsTenant(ctx, tenant)
}

// SetStandbyWarmer wires the D1 reconciling standby-warm loop: a SecondaryWarmer that
// registers warm Secondaries at an explicit node URL, and a StandbyMembershipAt that
// reads that node's plane-wide listing. Both take an explicit URL because the standby
// swaps after a failover. Kept off the constructor so existing callers/tests are
// unaffected; when NOT wired (or WarmTargets is empty) the loop is a no-op.
func (c *Controller) SetStandbyWarmer(w SecondaryWarmer, m StandbyMembershipAt) {
	c.warmer = w
	c.warmMembership = m
}

// maybeReconcileStandbyWarm runs the standby-warm reconcile at most once per
// WarmInterval. It is BEST-EFFORT: a failure is logged (the reconcile itself counts the
// metric), never returned, so it can never abort the failover-detection tick around it.
//
// It is also DEADLINE-BOUNDED (WarmDeadline). Without a total bound one pass is, per
// routed tenant and serially, a membership GET (PSW_PROBE_TIMEOUT_MS) plus a warm PUT +
// download kick on the warmer's own client — so a standby wedged on its object store
// could hold the single control goroutine for tens of seconds while PSW_POLL_MS ×
// PSW_FAIL_THRESHOLD promises primary-death detection in about six. The deadline caps
// the stretch; a pass cut short is COUNTED (never silently "warm"), and because the
// reconcile is idempotent and per-tenant, partial progress is kept and the remaining
// tenants are retried next interval.
//
// The bound is the second half of the fix, not the whole of it: the caller runs this
// AFTER the failover-detection path (see Tick), so a slow pass cannot delay the
// promotion decided on the same tick — at worst it delays the NEXT tick, by at most
// WarmDeadline, once per WarmInterval.
func (c *Controller) maybeReconcileStandbyWarm(ctx context.Context) {
	if c.warmer == nil || c.warmMembership == nil || len(c.cfg.WarmTargets) == 0 {
		return // loop not wired — no-op (back-compat)
	}
	if c.cfg.WarmInterval > 0 && !c.lastWarmAt.IsZero() && c.nowT().Sub(c.lastWarmAt) < c.cfg.WarmInterval {
		return // throttled
	}
	c.lastWarmAt = c.nowT()
	c.metrics.StandbyWarmReconcile()
	if c.cfg.WarmDeadline > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.cfg.WarmDeadline)
		defer cancel()
	}
	if err := c.reconcileStandbyWarm(ctx); err != nil {
		c.logf("[pswatcher] standby-warm reconcile: %v (retrying next interval)", err)
	}
}

// resolveStandby returns the app label + stable per-node URL of the node that is
// currently the STANDBY — the one the client Service does NOT select. This IS the
// never-demote-primary guard: it refuses (error) unless it can positively identify a
// standby DISTINCT from the primary, so the warm loop can never register a Secondary on
// the live writer. An empty selector, a selector naming no known node, an ambiguous
// topology (>1 candidate standby), or a resolved standby that collides with the primary
// all abort — fail toward NOT warming (the reversible state), never toward warming the
// primary.
func (c *Controller) resolveStandby(primaryApp string) (app, url string, err error) {
	if primaryApp == "" {
		return "", "", errors.New("standby-warm: the client Service selector is empty — cannot tell which node is primary; refusing to warm (a Secondary PUT onto the live primary would demote it)")
	}
	if _, ok := c.cfg.WarmTargets[primaryApp]; !ok {
		return "", "", fmt.Errorf("standby-warm: the client Service selects app %q, which is not a known pageserver node %v — refusing to warm rather than risk registering a Secondary on the live primary", primaryApp, warmTargetApps(c.cfg.WarmTargets))
	}
	for a, u := range c.cfg.WarmTargets {
		if a == primaryApp {
			continue // the live primary — NEVER warm it
		}
		if app != "" {
			return "", "", fmt.Errorf("standby-warm: more than one candidate standby node (%s, %s) for primary %q — the two-node topology is violated; refusing to warm ambiguously", app, a, primaryApp)
		}
		app, url = a, u
	}
	if app == "" {
		return "", "", fmt.Errorf("standby-warm: no standby node distinct from the primary %q in %v — refusing to warm the primary", primaryApp, warmTargetApps(c.cfg.WarmTargets))
	}
	// Belt-and-suspenders: the resolved standby is NEVER the primary and its URL is NEVER
	// the primary's URL — two app labels that resolve to the same node URL would
	// otherwise put a Secondary PUT on the live writer.
	//
	// Mutation-proved by TestResolveStandbyAbortsWhenStandbyURLCollidesWithThePrimary.
	// The earlier comment here credited TestReconcileStandbyWarmNeverWarmsThePrimary,
	// which never reaches this branch: neutering the check left the suite GREEN, so the
	// claim was decoration (#1124 review, FIX 3). Cite the test that actually reds.
	if app == primaryApp || url == c.cfg.WarmTargets[primaryApp] {
		return "", "", fmt.Errorf("standby-warm: BUG — resolved standby (%s=%s) collides with the live primary (%s) — refusing to warm the writer", app, url, primaryApp)
	}
	return app, url, nil
}

// reconcileStandbyWarm keeps the CURRENT standby registered as a warm Secondary for
// every routed tenant ({base, apps}), continuously — the D1 re-arm-after-failover loop
// (ADR-0010 §5). The one-shot warm Job leaves the plane disarmed the moment the first
// failover rebuilds the ex-primary as an empty standby nobody re-warms; this closes that
// gap without an operator re-running the Job.
//
// The standby is resolved from the LIVE client-Service selector every reconcile (via
// resolveStandby), so it follows the node roles across a failover flip and the warm PUT
// never lands on the live primary. Loss of warmth is observable per tenant
// (standby_tenant_warm gauge) and per failure (standby_warm_errors_total).
func (c *Controller) reconcileStandbyWarm(ctx context.Context) error {
	primaryApp, err := c.k8s.ServiceSelectorApp(ctx, c.cfg.ClientService)
	if err != nil {
		c.metrics.StandbyWarmError()
		return fmt.Errorf("standby-warm: cannot read client Service %q selector to identify the primary — refusing to warm any node (a Secondary PUT onto the live primary would demote it): %w", c.cfg.ClientService, err)
	}
	standbyApp, standbyURL, rerr := c.resolveStandby(primaryApp)
	if rerr != nil {
		c.metrics.StandbyWarmError()
		return rerr
	}
	var errs []error
	for _, tenant := range c.routedTenants() {
		held, attached, herr := c.warmMembership.HoldsTenantAt(ctx, standbyURL, tenant)
		if herr != nil {
			// "We could not check" is not "it is warm": count it, drive the gauge to 0
			// (loss-of-warmth observable), and keep going with the other tenants.
			c.metrics.StandbyWarmError()
			c.metrics.SetTenantWarm(tenant, false)
			errs = append(errs, fmt.Errorf("standby-warm: membership of tenant %s on standby %s (%s) unreadable: %w", tenant, standbyApp, standbyURL, herr))
			continue
		}
		if held && attached {
			// The node holds the tenant, but ATTACHED — not as a warm Secondary. This is
			// what an ex-primary whose PVC survived the failover looks like: it reloaded
			// its persisted AttachedSingle at the OLD generation. It is LISTED, so a
			// membership-only read would call it warm and publish "HA armed" for a plane
			// that is not armed. Report it instead: gauge 0, a dedicated counter, a log
			// line naming the node.
			//
			// And still NO PUT — the write stays mode-AGNOSTIC on purpose. In the
			// promote-BEFORE-flip window the just-promoted new writer is ATTACHED and not
			// yet selected by the client Service, so resolveStandby resolves IT as the
			// standby; PUTting a Secondary there would DEMOTE the new writer — precisely
			// the outage this loop exists to prevent. A misread mode can therefore only
			// mis-REPORT, never demote. Clearing a stale attached location is an operator
			// action (docs/operations.md#pageserver-failover), not this loop's.
			c.metrics.SetTenantWarm(tenant, false)
			c.metrics.StandbyStaleAttached()
			c.logf("[pswatcher] standby-warm: standby %s (%s) holds routed tenant %s ATTACHED, not as a warm Secondary — HA is NOT armed for it and this loop will NOT PUT a Secondary onto an attached node (it may be a just-promoted writer mid-flip); detach or rebuild that node's stale location by hand", standbyApp, standbyURL, tenant)
			continue
		}
		if held {
			c.metrics.SetTenantWarm(tenant, true)
			continue
		}
		// Not warm — register it. The gauge stays 0 until a later reconcile CONFIRMS the
		// membership, so a registration in flight still reads as not-yet-warm.
		c.metrics.SetTenantWarm(tenant, false)
		if werr := c.warmer.WarmSecondary(ctx, standbyURL, tenant); werr != nil {
			c.metrics.StandbyWarmError()
			errs = append(errs, fmt.Errorf("standby-warm: register tenant %s as warm Secondary on standby %s (%s): %w", tenant, standbyApp, standbyURL, werr))
			continue
		}
		c.metrics.StandbyWarmRegistration()
	}
	return errors.Join(errs...)
}

// warmTargetApps returns the app labels in a WarmTargets map, for diagnostics.
func warmTargetApps(m map[string]string) []string {
	apps := make([]string, 0, len(m))
	for a := range m {
		apps = append(apps, a)
	}
	return apps
}

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
	led, ok, rv, err := c.k8s.GetGeneration(ctx)
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
		return c.k8s.SetGeneration(ctx, target, rv)
	}
	// Present key: heal UP only. Never re-write an equal-or-leading ledger. The rv read
	// above CASes the heal so a concurrent failover advancing the ledger is not clobbered.
	if target > led {
		return c.k8s.SetGeneration(ctx, target, rv)
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

	// D3 — publish the composite HA-readiness gauge every tick, computed from
	// already-gathered state: the freeze read above (fresh) and the per-tenant warmth the
	// DEFERRED reconcile published on a prior tick. This deliberately adds NO probe to the
	// hot detection path — the #1124 lesson was that a synchronous standby probe at the top
	// of the tick stretches primary-death detection, so the gauge reuses the reconcile's
	// throttled warmth rather than re-checking membership here. failoverArmed is pure.
	c.metrics.SetFailoverArmed(failoverArmed(frozen, c.routedTenants(), func(t string) bool {
		return c.metrics.TenantWarm(t) == 1
	}))

	// D1 — keep the CURRENT standby warm for every routed tenant, so a failover that
	// leaves the ex-primary an un-armed standby re-arms automatically (ADR-0010 §5).
	// BEST-EFFORT + throttled + deadline-bounded, and DEFERRED so it runs LAST, after
	// every failover-detection and promotion path below has already returned its verdict.
	//
	// The ordering is the fix, not a style choice (#1124 review, FIX 2). Run at the TOP
	// of the tick — where this call used to sit — a standby hung on its object store
	// holds the single control goroutine for a membership timeout plus a warm PUT per
	// routed tenant BEFORE the prober ever runs, stretching the ~6s primary-death
	// detection that PSW_POLL_MS × PSW_FAIL_THRESHOLD promises. Deferred, a slow pass
	// cannot delay the tick's own detection or promotion at all; it can only delay the
	// NEXT tick, by at most WarmDeadline, once per WarmInterval.
	//
	// A deferred call also cannot touch the tick's return values, which makes
	// "best-effort" structural rather than a convention: no failure in this loop can
	// ever become a failover-blocking error.
	defer c.maybeReconcileStandbyWarm(ctx)

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
		// D3 — count the abort by cause at the ONE caller site (scan-safe: a new abort
		// path inside failover() is captured here automatically, rather than needing its
		// own enumerated counter call that a future edit could forget).
		c.metrics.FailoverAborted(classifyFailoverAbort(err))
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
	gen, ok, _, err := c.k8s.GetGeneration(ctx)
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
	gen, ok, _, err := c.k8s.GetGeneration(ctx)
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

// skippable decides whether a routed tenant the STANDBY reports as not-held may be
// skipped, given its index in the routed set. The standby's not-held report is a
// node-local fact (from the membership oracle since D2; see failover), so on its own
// it is never licence to flip (#1098 review, FIX 2):
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

// failover runs the proven runbook. ORDER INVERTED for D4 (ADR-0010 §4): validate the
// routed set → CAS-RESERVE the advanced generation in the ledger ONCE (fences the dead
// primary via gen+1) → promote EVERY routed tenant at the reserved generation → flip the
// client Service → bounce the compute so a cold wake re-attaches to the promoted standby.
// The reserve moved BEFORE the promotes so that a loser in the two-writers-during-a-
// partition window aborts on the CAS conflict before any PUT, rather than PUT-attaching
// tenants at a generation it then fails to persist.
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
// (retry next tick). A standby not-found is NOT automatically a skip — see skippable()
// below: the base tenant is never skippable, and a non-base tenant is skipped only on
// a corroborated absence. The flip proceeds only if at least one routed tenant was
// actually promoted.
//
// Absence is detected by the STANDBY MEMBERSHIP ORACLE (the plane-wide
// GET /v1/location_config listing), not by the PUT and not by the per-tenant GET:
//   - the live PUT location_config returns 200 and ATTACHES a phantom empty tenant for
//     a tenant it does not hold — it never 404s (ADR-0010 §5);
//   - the per-tenant GET /v1/tenant/<T> returns 503 for a tenant held as a warm
//     SECONDARY, which is how a correctly-warmed standby holds its routed tenants, so
//     using it would abort every failover on a real plane.
//
// So before every PUT this asks the membership oracle whether the standby holds the
// tenant; a not-held tenant feeds skippable() unchanged, and an unwired or unreadable
// oracle aborts. The PUT-404→ErrTenantNotFound mapping is RETAINED below as
// defence-in-depth (a future pageserver may restore 404), but it is no longer a
// detector anything relies on — the 200-attach case is caught by the pre-flight.
//
// The generation itself is fail-closed (#1098 review, code #5): an ABSENT ledger key
// is never floored to BaseGeneration, because promoting at 2 on a plane that is
// really at 7 re-attaches below the object-store index. It is recovered from the
// routed pageserver view, or the failover aborts.
// failoverArmed is the verdict behind pswatcher_failover_armed (D3): HA would promote on a
// primary death right now iff no maintenance freeze is suppressing it AND the standby holds
// EVERY routed tenant as a warm Secondary (so failover()'s pre-flight membership oracle
// would pass). An empty routed set — nothing observed yet — is NOT armed: the safe default
// is to report the safety net DOWN until it is proven up. Pure (no IO), so the verdict is
// unit-testable and mutation-provable in isolation from the tick's control flow.
func failoverArmed(frozen bool, routed []string, warm func(string) bool) bool {
	if frozen || len(routed) == 0 {
		return false
	}
	for _, t := range routed {
		if !warm(t) {
			return false
		}
	}
	return true
}

// classifyFailoverAbort maps a failover() error to a bounded pswatcher_failover_aborted_total
// reason label. A lost generation-ledger CAS is the one distinctly-actionable cause (a
// concurrent writer during a partition); every other abort is "aborted" (its error text
// carries the detail into the log). A small closed set keeps the label cardinality bounded.
func classifyFailoverAbort(err error) string {
	switch {
	case errors.Is(err, ErrLedgerConflict):
		return "ledger_cas_lost"
	default:
		return "aborted"
	}
}

func (c *Controller) failover(ctx context.Context) error {
	gen, ok, rv, err := c.k8s.GetGeneration(ctx)
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

	// D4 (ADR-0010 §4) — the target generation. A FRESH failover reserves gen+1; a
	// failover RESUMED within this instance (an earlier tick reserved but a later tenant's
	// PUT failed and aborted before the flip) promotes at the ALREADY-reserved generation,
	// never gen+1 — otherwise a transient promote error would double-advance the ledger on
	// every retry. Promotion at an already-reserved generation is idempotent, so this is
	// safe to re-drive.
	newGen := gen + 1
	reserved := c.reservedGen != 0
	if reserved {
		newGen = c.reservedGen
	}

	// MECHANICAL FENCE (D4/BLOCK-2) — never promote BELOW the ledger, whatever newGen was
	// computed to be. This makes "promotion below the ledger" unparseable-to-violate rather
	// than relying on the reservedGen bookkeeping being correct. The comparison is `>=`, not
	// `>`, ON PURPOSE: a FRESH failover has newGen = gen+1 (> gen), but a legitimate RESUME
	// reads gen == reservedGen (the reserve already advanced the ledger to newGen), so
	// newGen == gen — and that resume MUST proceed to complete the flip it deferred. What
	// this catches is a STALE reservedGen: if the reservation were ever carried into a
	// failover whose ledger has since advanced ABOVE it (newGen < gen), we abort rather than
	// promote at a fenced-below generation. Combined with clearing reservedGen at the flip
	// (below) and the `done` latch, the stale case is unreachable in-process today; the
	// fence is defence-in-depth against a future re-entry path.
	if newGen < gen {
		return fmt.Errorf("failover: refusing to promote at generation %d which is BELOW the ledger generation %d (stale reservation %d) — a promotion below the ledger cannot fence a higher-generation holder", newGen, gen, c.reservedGen)
	}

	// PASS 1 — VALIDATE every routed tenant against the standby membership oracle. This
	// pass is READS ONLY: no ledger write and no PUT happen here, so any abort keeps reads
	// on the (dead) primary rather than a half-promoted plane, and — crucially for D4 — the
	// CAS-reserve below has not run yet, so a validation abort leaves the ledger UNTOUCHED
	// (the phantom-attach abort tests assert exactly this: no ledger advance, no flip).
	//
	// The oracle is the plane-wide /v1/location_config listing (ADR-0010 §5, D2). The two
	// signals it replaces are both broken on a live plane — the PUT returns 200 and
	// ATTACHES a phantom empty tenant for a tenant the standby does not hold (never 404s),
	// and the per-tenant GET 503s for the warm SECONDARY a correctly-warmed standby holds.
	// An unwired or unreadable oracle ABORTS. A not-held tenant feeds the EXISTING
	// skippable() logic UNCHANGED (base aborts; a non-base tenant needs routed-vantage
	// corroboration).
	routed := c.routedTenants()
	toPromote := make([]bool, len(routed))
	promotable := 0
	for i, tenant := range routed {
		held, verr := c.standbyHoldsTenant(ctx, tenant)
		if verr != nil {
			// "We could not check the standby" is never "the standby holds it":
			// promoting+flipping onto a standby we cannot verify holds the tenant is
			// the phantom-attach split-brain this pre-flight exists to prevent.
			return fmt.Errorf("failover: could not establish whether the standby holds routed tenant %s (%w) — aborting before the flip rather than PUT-attaching onto an unverified standby (a PUT 200s even when the tenant is absent)", tenant, verr)
		}
		if !held {
			skip, serr := c.skippable(ctx, i, tenant)
			if serr != nil {
				return serr
			}
			if !skip {
				// Defensive: skippable() returns (false, nil) for no input today — every
				// non-skippable case carries its own error above. If a future edit adds
				// one, it must not silently fall through to the PUT, which would attach a
				// phantom onto a standby we just established does NOT hold the tenant.
				return fmt.Errorf("failover: routed tenant %s is not held by the standby and was not cleared to skip — aborting before the flip rather than PUT-attaching a phantom empty tenant", tenant)
			}
			// Corroborated absent from both vantages — nothing routed to strand.
			c.metrics.TenantSkipped()
			continue
		}
		toPromote[i] = true
		promotable++
	}
	if promotable == 0 {
		return fmt.Errorf("failover: no routed tenant could be promoted at generation %d (routed set: %v)", newGen, routed)
	}

	// RESERVE (D4) — CAS the ledger to newGen BEFORE any Promote PUT. This is the inversion
	// the two-writers-during-a-partition threat model demands: under the OLD order
	// (promote-all → SetGeneration) a loser had ALREADY PUT tenants at newGen before it
	// discovered it lost the ledger write, so both writers promoted. Reserving first means
	// a lost CAS aborts BEFORE any PUT. The lost-CAS abort is LOUD (counter) and NEVER
	// retries at the winner's value — adopting the winner's generation mid-failover is how
	// two writers both come to believe they are current. Reserve-first is also the SAFE
	// skew direction: a ledger AHEAD of reality self-heals (convergeFailover re-promotes up
	// to the ledger; readers take max(ledger, view, 1)), whereas reality ahead of the
	// ledger is the fencing hazard. Skipped when this instance already reserved newGen.
	if !reserved {
		if serr := c.k8s.SetGeneration(ctx, newGen, rv); serr != nil {
			if errors.Is(serr, ErrLedgerConflict) {
				c.metrics.LedgerCASConflict()
				return fmt.Errorf("failover: lost the generation-ledger CAS reserving %d — a concurrent writer advanced the ledger; ABORTING without promoting and NOT retrying at the winner's value (two writers must never both believe they are current): %w", newGen, serr)
			}
			return serr
		}
		c.reservedGen = newGen
	}

	// PASS 2 — PROMOTE the validated tenants at the reserved generation. Idempotent +
	// generation-guarded: a re-PUT at an already-held generation is a no-op on the
	// pageserver, so a retry after a partial failure re-promotes at the SAME newGen and can
	// never double-advance. A Promote failure here aborts AFTER the reserve: the ledger is
	// left AHEAD of the plane (the safe skew — convergeFailover heals it), and reservedGen
	// is RETAINED so the next tick resumes at newGen rather than reserving gen+1 again.
	promoted := 0
	for i, tenant := range routed {
		if !toPromote[i] {
			continue
		}
		if perr := c.promoter.Promote(ctx, tenant, newGen); perr != nil {
			if errors.Is(perr, ErrTenantNotFound) {
				// A tenant held per the oracle but 404ing on the PUT (a race with a
				// detach, or a defence-in-depth 404 a future pageserver restores):
				// re-run skippable to decide. The base tenant is never skippable.
				skip, serr := c.skippable(ctx, i, tenant)
				if serr != nil {
					return serr
				}
				if skip {
					c.metrics.TenantSkipped()
					continue
				}
			}
			// A real failure on an existing tenant: abort before the flip so it is never
			// left on the demoted pageserver. Retried on the next tick at reservedGen.
			return perr
		}
		promoted++
	}
	if promoted == 0 {
		// Every validated tenant 404'd on the PUT in this pass (an extreme race): do NOT
		// flip onto a standby that holds nothing. The ledger stays reserved AHEAD — the
		// safe skew — and a later tick re-promotes at reservedGen.
		return fmt.Errorf("failover: reserved generation %d but no routed tenant could be PUT-promoted (routed set: %v)", newGen, routed)
	}

	if err := c.k8s.FlipServiceSelector(ctx, c.cfg.ClientService, c.cfg.StandbyApp); err != nil {
		return err
	}
	if _, err := c.k8s.DeletePods(ctx, c.cfg.ComputeSelector); err != nil {
		return err
	}
	// Flip + bounce succeeded: the failover is COMPLETE. Clear the reservation so the field
	// never lingers as a stale value a future re-entry could adopt (D4/BLOCK-2). The `done`
	// latch already makes failover() unreachable again in-process, so this is belt-and-
	// braces with the mechanical fence above — but it keeps the invariant "reservedGen is
	// non-zero ONLY while a reserve is outstanding and unflipped" true, which is what the
	// fence's stale-detection reasons about. A DeletePods error above returns WITHOUT
	// clearing, on purpose: the ledger is reserved and the flip has happened, so the next
	// tick must resume at the SAME reservedGen to re-bounce, not reserve gen+1 afresh.
	c.reservedGen = 0
	return nil
}
