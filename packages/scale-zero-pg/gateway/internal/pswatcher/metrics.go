package pswatcher

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// sortedKeys returns a map's keys in stable sorted order (deterministic exposition).
func sortedKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// D9 — RUNNING-BINARY capability signal (pswatcher_build_info).
//
// The deploy-time lockstep guards all pinned the manifest to a SOURCE constant
// (PSW_MAX_FREEZE_MS↔DefaultMaxFreezeDuration, PSW_APPS_TENANT_ID↔APPDB_TENANT_ID,
// PSW_PRIMARY_CONTAINER↔53). They therefore stayed green on a manifest that runs a
// STALE image which ignores the env — at one sprint close 58-pswatcher.yaml still
// pinned a pre-capability image and every source check passed. The fix is a signal a
// scraper reads off the DEPLOYED binary: this gauge names the capabilities COMPILED
// INTO the binary, so a stale image reds the drill rather than passing.
//
// Each entry is added in the SAME change that lands the capability it names. A binary
// built before an entry existed cannot emit it — that is the whole point: the gauge is
// the manifest↔running-binary link the source-pinned guards lacked. (Within the
// package boundary this is a build-capability *declaration*, not cross-package
// introspection: it asserts the binary was built from a tree that carried the feature,
// which is exactly what catches a stale image; see docs/operations.md.)
const (
	// FeatureRoutedSet — failover promotes the routed apps-tenant SET alongside the
	// base tenant (PSW_APPS_TENANT_ID), so per-app databases are not stranded on the
	// demoted pageserver (#1098).
	FeatureRoutedSet = "routed-set"
	// FeatureFreeze — a TTL-bounded maintenance FREEZE suppresses failover and is
	// clamped to DefaultMaxFreezeDuration (PSW_MAX_FREEZE_MS), #1099.
	FeatureFreeze = "freeze"
	// FeatureStandbyWarm — the standby warm-Secondary registration is a CONTINUOUS
	// reconcile (D1), not the one-shot Job, so a failover that rebuilds the ex-primary as
	// an empty standby re-arms automatically (ADR-0010 §5). A pre-D1 image cannot emit
	// this token, so a stale 58-pswatcher.yaml image reds the capability drill.
	FeatureStandbyWarm = "standby-warm"
)

// pswatcherFeatures is the capability list this binary ships, in a stable order so the
// emitted label is deterministic (a scraper matches substrings, not exact strings).
var pswatcherFeatures = []string{FeatureFreeze, FeatureRoutedSet, FeatureStandbyWarm}

// BuildVersion is the build tag of this binary. It defaults to "dev" so
// pswatcher_build_info always carries a non-empty version label, and can be stamped at
// link time (-X '...pswatcher.BuildVersion=vX.Y.Z') without touching this file.
var BuildVersion = "dev"

// FeaturesLabel returns the comma-joined capability list emitted as the `features`
// label of pswatcher_build_info.
func FeaturesLabel() string { return strings.Join(pswatcherFeatures, ",") }

// Metrics holds the watcher's counters, safe for concurrent use (the HTTP
// server reads while the control loop writes).
type Metrics struct {
	mu sync.Mutex

	PromotionsTotal          int `json:"promotions_total"`
	ChecksTotal              int `json:"checks_total"`
	PrimaryUpVal             int `json:"primary_up"`                 // 1 = the CURRENT read authority (primary, or promoted standby post-failover) is reachable
	FailedOverVal            int `json:"failed_over"`                // 1 = a failover has happened; primary_up now tracks the promoted standby
	SuspectedPartitionsTotal int `json:"suspected_partitions_total"` // times a promotion was WITHHELD because the primary was Ready per the API server (our-vantage partition)
	PrimaryNeverSeenTotal    int `json:"primary_never_seen_total"`   // times a promotion was WITHHELD because the primary pod was NEVER observed present (selector likely misconfigured — issue #58)
	TenantAbsentTotal        int `json:"tenant_absent_total"`        // times a routed-set tenant was SKIPPED on failover because BOTH the standby and a second vantage report it absent (e.g. an apps tenant never provisioned) — #1098
	LedgerHealErrorsTotal    int `json:"ledger_heal_errors_total"`   // times the startup ledger seed/heal could not read the pageserver generation view — a permanently broken vantage makes the heal path dead code, so it must be visible (#1098 review)

	// T5 (#1099) — failover-trigger discrimination + maintenance freeze.
	DependencyDegradedTotal    int   `json:"dependency_degraded_total"`        // times a promotion was WITHHELD because the primary pod is present but NotReady while its container is STILL RUNNING — a dependency degraded (e.g. object-store creds mid-rotation), NOT a node death. Failing over here needlessly consumes the standby (the live split-brain incident).
	FailoverFrozenVal          int   `json:"failover_frozen"`                  // 1 = a maintenance freeze is ACTIVE (planned op in progress) — failover is deliberately suppressed. Alert on this being 1 for longer than the planned window.
	FailoverFreezeSuppressed   int   `json:"failover_freeze_suppressed_total"` // times a failover that WOULD have fired was suppressed because a maintenance freeze was active.
	FailoverFreezeExpirySecond int64 `json:"failover_freeze_expiry_seconds"`   // unix seconds at which the active freeze expires (0 when none) — lets alerting compute time-remaining and notice a freeze that has lapsed or is stuck.
	// FreezeReadErrorsTotal counts ticks on which the maintenance-freeze state could
	// NOT be established — the ConfigMap was unreadable, its `until` was not RFC3339,
	// or it carried no createdAt to clamp against. Each of those is treated as NO
	// freeze (HA stays ON — fail-SAFE), which means an operator's freeze may silently
	// not be in effect. That has to be loud, hence a counter with its own alert.
	FreezeReadErrorsTotal int `json:"freeze_read_errors_total"`
	// T6 (#1100) — convergent recovery. ConvergeRepromotionsTotal counts re-promotions
	// the ADOPT/converge path performed to complete an interrupted or incomplete failover
	// (a routed tenant observed below the ledger generation on the promoted pageserver was
	// re-attached at that SAME generation). It is idempotent + generation-guarded: it
	// NEVER advances the ledger, so this rising while pswatcher_promotions_total /
	// pswatcher_tenant_absent_total do not means a stranded tenant was healed with no
	// manual step. ConvergeBlockedTotal counts converge ticks where a routed tenant could
	// NOT be verified (generation view unwired or erroring) so it was NOT re-promoted —
	// fail-safe (never promote on an unreadable vantage); a permanently blind vantage over
	// a stranded tenant is thus visible rather than silent.
	// ConvergeErrorsTotal counts ticks whose converge pass could not COMPLETE (a
	// promote or ledger read failed). Converge is BEST-EFFORT: its failure never
	// aborts the tick's health/bounce path (#1100 review, FIX 1), so this counter —
	// not a frozen primary_up — is the signal that a plane is not converging.
	// ConvergeTenantAbsentTotal counts routed tenants the promoted pageserver does not
	// hold at all (404 from the vantage): converge cannot re-attach them, so a
	// never-warmed or unprovisioned routed tenant would otherwise stay stranded
	// forever and invisibly (#1100 review, FIX 2).
	ConvergeRepromotionsTotal int `json:"converge_repromotions_total"`
	ConvergeBlockedTotal      int `json:"converge_blocked_total"`
	ConvergeErrorsTotal       int `json:"converge_errors_total"`
	ConvergeTenantAbsentTotal int `json:"converge_tenant_absent_total"`

	// D4 (ADR-0010 §4) — LedgerCASConflictsTotal counts failovers ABORTED because the
	// reserve-before-promote ledger write LOST a resourceVersion CAS: a concurrent writer
	// (the two-pswatchers-during-a-partition window) advanced the ledger first. The loser
	// aborts WITHOUT promoting and never retries at the winner's value, so this rising is
	// the ONLY signal that two writers contended — alert on it (PswatcherLedgerCASConflict).
	LedgerCASConflictsTotal int `json:"ledger_cas_conflicts_total"`

	// D1 — the reconciling standby-warm loop (ADR-0010 §5). StandbyWarmReconcilesTotal
	// counts reconcile passes; StandbyWarmRegistrationsTotal counts warm-Secondary
	// registrations issued (a rising count with no failover means the loop re-armed a
	// standby that had lost a routed tenant — e.g. the rebuilt ex-primary after a
	// failover); StandbyWarmErrorsTotal counts a reconcile that could not read the client
	// selector, could not resolve the standby, could not read the standby's membership, or
	// failed a registration — each a case where the standby may not be warm, so it must be
	// loud (alert PswatcherStandbyWarmFailing). TenantWarm is the per-tenant loss-of-warmth
	// GAUGE: 1 = the tenant is held as a Secondary on the current standby, 0 = it is not
	// (or could not be confirmed). Alert PswatcherStandbyNotWarm fires on a 0.
	//
	// StandbyStaleAttachedTotal counts the case that makes the gauge mode-AWARE: the
	// resolved standby LISTS a routed tenant, but holds it ATTACHED rather than as a warm
	// Secondary — what an ex-primary whose PVC survived a failover reloads (its persisted
	// AttachedSingle at the OLD generation). Membership alone reads that as warm, so a
	// mode-blind gauge publishes "HA armed" for a plane that is not armed. Such a tenant
	// is reported (gauge 0 + this counter + a log line) and deliberately NOT written to —
	// see reconcileStandbyWarm for why the write stays mode-agnostic.
	StandbyWarmReconcilesTotal    int            `json:"standby_warm_reconciles_total"`
	StandbyWarmRegistrationsTotal int            `json:"standby_warm_registrations_total"`
	StandbyWarmErrorsTotal        int            `json:"standby_warm_errors_total"`
	StandbyStaleAttachedTotal     int            `json:"standby_stale_attached_total"`
	StandbyTenantWarm             map[string]int `json:"standby_tenant_warm,omitempty"`

	// FailoverReasonVal is the classification of the LAST completed failover:
	// "node_death" once the watcher has confirmed a genuine death and promoted.
	// Rendered as a labeled sample pswatcher_failover_reason{reason="..."} 1 so a
	// scraper can prove the watcher DISCRIMINATED (the failover drill asserts it).
	FailoverReasonVal string `json:"failover_reason,omitempty"`
}

// NewMetrics starts with primary assumed up (avoids a spurious 0 before the
// first probe completes).
func NewMetrics() *Metrics { return &Metrics{PrimaryUpVal: 1} }

// Promotion counts one completed failover.
func (m *Metrics) Promotion() { m.mu.Lock(); m.PromotionsTotal++; m.mu.Unlock() }

// Check counts one liveness poll.
func (m *Metrics) Check() { m.mu.Lock(); m.ChecksTotal++; m.mu.Unlock() }

// SetPrimaryUp records the last observed liveness of the CURRENT read authority —
// the primary before failover, the promoted standby after (see the watcher's
// re-anchor). Post-failover this is the honest health of the node actually serving
// reads, not a blind 1.
func (m *Metrics) SetPrimaryUp(up bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if up {
		m.PrimaryUpVal = 1
	} else {
		m.PrimaryUpVal = 0
	}
}

// SetFailedOver records whether a failover has occurred (latching; the MVP never
// fails back). Once 1, primary_up tracks the promoted standby.
func (m *Metrics) SetFailedOver(v bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if v {
		m.FailedOverVal = 1
	} else {
		m.FailedOverVal = 0
	}
}

// SuspectedPartition counts one WITHHELD promotion: our HTTP probe failed but the
// API server reported the primary pod Running & Ready (a watcher-side partition),
// so we refused to burn the only standby.
func (m *Metrics) SuspectedPartition() {
	m.mu.Lock()
	m.SuspectedPartitionsTotal++
	m.mu.Unlock()
}

// PrimaryNeverSeen counts one WITHHELD promotion: our HTTP probe failed and the
// API server reports the primary pod ABSENT, but we have NEVER observed a pod
// matching PrimarySelector present — so the absence is more likely a
// misconfigured/drifted selector (or an RBAC empty-list) than a real death. We
// refuse to promote on an un-anchored vantage rather than burn the only standby
// (issue #58).
func (m *Metrics) PrimaryNeverSeen() {
	m.mu.Lock()
	m.PrimaryNeverSeenTotal++
	m.mu.Unlock()
}

// PrimaryNeverSeenCount returns the never-anchored-absence withheld count (tests).
func (m *Metrics) PrimaryNeverSeenCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.PrimaryNeverSeenTotal
}

// TenantSkipped counts one routed-set tenant that was skipped on failover because
// the pageserver does not hold it (not-found). The failover still completes for the
// tenants that exist; this surfaces a misconfigured routed set or an unprovisioned
// apps tenant for alerting (#1098).
func (m *Metrics) TenantSkipped() {
	m.mu.Lock()
	m.TenantAbsentTotal++
	m.mu.Unlock()
}

// TenantAbsent returns the skipped-tenant count (tests).
func (m *Metrics) TenantAbsent() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.TenantAbsentTotal
}

// LedgerHealError counts one failed read of the pageserver generation view during
// the startup ledger seed/heal. Discarding it (the pre-review behaviour) made a
// permanently broken vantage indistinguishable from a healthy one: the heal path
// would be dead code with nothing to alert on (#1098 review).
func (m *Metrics) LedgerHealError() {
	m.mu.Lock()
	m.LedgerHealErrorsTotal++
	m.mu.Unlock()
}

// LedgerHealErrors returns the seed/heal vantage-error count (tests).
func (m *Metrics) LedgerHealErrors() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.LedgerHealErrorsTotal
}

// DependencyDegraded counts one WITHHELD promotion: the primary pod is present but
// NotReady while its container is STILL RUNNING, so a dependency has degraded (e.g.
// object-store creds mid-rotation) rather than the node dying. Promoting here would
// consume the only standby on a recoverable blip — the live split-brain (#1099).
func (m *Metrics) DependencyDegraded() {
	m.mu.Lock()
	m.DependencyDegradedTotal++
	m.mu.Unlock()
}

// DependencyDegradedCount returns the dependency-degraded withheld count (tests).
func (m *Metrics) DependencyDegradedCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.DependencyDegradedTotal
}

// SetFailoverFrozen records whether a maintenance freeze is ACTIVE and, if so, the
// unix expiry of that freeze (0 when none). The gauge lets alerting fire while a
// freeze is active (and notice one that outlives its planned window); the expiry
// lets it compute time-remaining and detect a lapsed/stuck freeze (#1099).
func (m *Metrics) SetFailoverFrozen(active bool, expiryUnix int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if active {
		m.FailoverFrozenVal = 1
		m.FailoverFreezeExpirySecond = expiryUnix
	} else {
		m.FailoverFrozenVal = 0
		m.FailoverFreezeExpirySecond = 0
	}
}

// FailoverFrozen returns 1 while a maintenance freeze is active (tests).
func (m *Metrics) FailoverFrozen() int { m.mu.Lock(); defer m.mu.Unlock(); return m.FailoverFrozenVal }

// FreezeExpiry returns the active freeze's unix expiry, 0 when none (tests).
func (m *Metrics) FreezeExpiry() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.FailoverFreezeExpirySecond
}

// FreezeSuppressed counts one failover that WOULD have fired but was suppressed by
// an active maintenance freeze.
func (m *Metrics) FreezeSuppressed() {
	m.mu.Lock()
	m.FailoverFreezeSuppressed++
	m.mu.Unlock()
}

// FreezeSuppressedCount returns the freeze-suppressed failover count (tests).
func (m *Metrics) FreezeSuppressedCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.FailoverFreezeSuppressed
}

// FreezeReadError counts one tick whose maintenance-freeze state could not be
// established (unreadable ConfigMap, malformed `until`, or a freeze with no createdAt
// to clamp against). The watcher then treats it as NO freeze and keeps HA ON — the
// fail-SAFE direction — so this counter is the ONLY signal that an operator's freeze
// is not actually in effect. Alert on it (PswatcherFreezeUnreadable).
func (m *Metrics) FreezeReadError() {
	m.mu.Lock()
	m.FreezeReadErrorsTotal++
	m.mu.Unlock()
}

// FreezeReadErrors returns the freeze-read-error count (tests).
func (m *Metrics) FreezeReadErrors() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.FreezeReadErrorsTotal
}

// ConvergeRepromotion counts one re-promotion performed by the adopt/converge path
// to complete an interrupted/incomplete failover: a routed tenant observed below the
// ledger generation on the promoted pageserver, re-attached at that SAME generation
// (idempotent, generation-guarded — the ledger is never advanced on this path).
func (m *Metrics) ConvergeRepromotion() {
	m.mu.Lock()
	m.ConvergeRepromotionsTotal++
	m.mu.Unlock()
}

// ConvergeRepromotions returns the converge re-promotion count (tests).
func (m *Metrics) ConvergeRepromotions() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ConvergeRepromotionsTotal
}

// ConvergeBlocked counts one converge tick on which a routed tenant could not be
// verified (the generation view is unwired or errored), so it was NOT re-promoted.
// Promoting on an unreadable vantage is exactly the guess this controller refuses;
// the counter keeps a permanently blind vantage over a stranded tenant visible.
func (m *Metrics) ConvergeBlocked() {
	m.mu.Lock()
	m.ConvergeBlockedTotal++
	m.mu.Unlock()
}

// ConvergeBlockedCount returns the converge-blocked count (tests).
func (m *Metrics) ConvergeBlockedCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ConvergeBlockedTotal
}

// ConvergeError counts one tick whose converge pass could not complete (a promote or
// a ledger read failed). The tick DELIBERATELY continues — it still republishes
// primary_up and still performs the adopt bounce, because gating those on converge
// turns a per-tenant promote failure into an unbounded compute outage with a frozen
// gauge and no alert (#1100 review, FIX 1). This counter is what makes the failure
// visible; alert on it (PswatcherConvergeFailing).
func (m *Metrics) ConvergeError() {
	m.mu.Lock()
	m.ConvergeErrorsTotal++
	m.mu.Unlock()
}

// ConvergeErrors returns the converge-error count (tests).
func (m *Metrics) ConvergeErrors() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ConvergeErrorsTotal
}

// ConvergeTenantAbsent counts one routed tenant the promoted pageserver does not hold
// (the vantage 404s for it). Converge has nothing to re-attach, so without this
// counter a routed tenant that was never warmed on the promoted pageserver stays
// stranded forever and invisibly (#1100 review, FIX 2).
func (m *Metrics) ConvergeTenantAbsent() {
	m.mu.Lock()
	m.ConvergeTenantAbsentTotal++
	m.mu.Unlock()
}

// ConvergeTenantAbsentCount returns the converge tenant-absent count (tests).
func (m *Metrics) ConvergeTenantAbsentCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ConvergeTenantAbsentTotal
}

// LedgerCASConflict counts one failover aborted because the reserve-before-promote ledger
// write lost a resourceVersion CAS to a concurrent writer (D4, ADR-0010 §4). The loser
// never promotes and never retries at the winner's value, so this counter is the sole
// signal that two writers contended for the ledger.
func (m *Metrics) LedgerCASConflict() {
	m.mu.Lock()
	m.LedgerCASConflictsTotal++
	m.mu.Unlock()
}

// LedgerCASConflicts returns the ledger CAS-conflict count (tests).
func (m *Metrics) LedgerCASConflicts() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.LedgerCASConflictsTotal
}

// StandbyWarmReconcile counts one standby-warm reconcile pass (D1).
func (m *Metrics) StandbyWarmReconcile() {
	m.mu.Lock()
	m.StandbyWarmReconcilesTotal++
	m.mu.Unlock()
}

// StandbyWarmReconciles returns the reconcile-pass count (tests).
func (m *Metrics) StandbyWarmReconciles() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.StandbyWarmReconcilesTotal
}

// StandbyWarmRegistration counts one warm-Secondary registration issued to the standby.
func (m *Metrics) StandbyWarmRegistration() {
	m.mu.Lock()
	m.StandbyWarmRegistrationsTotal++
	m.mu.Unlock()
}

// StandbyWarmRegistrations returns the warm-registration count (tests).
func (m *Metrics) StandbyWarmRegistrations() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.StandbyWarmRegistrationsTotal
}

// StandbyWarmError counts one standby-warm reconcile failure (unreadable selector,
// unresolvable standby, unreadable membership, or a failed registration) — any case
// where the standby may not be warm. Loud so a disarmed HA plane is not silent.
func (m *Metrics) StandbyWarmError() {
	m.mu.Lock()
	m.StandbyWarmErrorsTotal++
	m.mu.Unlock()
}

// StandbyWarmErrors returns the standby-warm error count (tests).
func (m *Metrics) StandbyWarmErrors() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.StandbyWarmErrorsTotal
}

// StandbyStaleAttached counts one routed tenant that the resolved standby holds
// ATTACHED instead of as a warm Secondary — a stale ex-primary location. The loop does
// NOT write to such a node (that node may be a just-promoted writer mid-flip), so this
// counter plus the 0 gauge is the ONLY signal that HA is un-armed for that tenant and
// needs an operator to detach or rebuild the node.
func (m *Metrics) StandbyStaleAttached() {
	m.mu.Lock()
	m.StandbyStaleAttachedTotal++
	m.mu.Unlock()
}

// StandbyStaleAttachedCount returns the stale-ATTACHED count (tests).
func (m *Metrics) StandbyStaleAttachedCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.StandbyStaleAttachedTotal
}

// SetTenantWarm records the per-tenant loss-of-warmth gauge: warm=true ⇒ the tenant is
// held as a Secondary on the CURRENT standby, warm=false ⇒ it is not (or could not be
// confirmed). Alerting fires on a 0.
func (m *Metrics) SetTenantWarm(tenant string, warm bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.StandbyTenantWarm == nil {
		m.StandbyTenantWarm = map[string]int{}
	}
	if warm {
		m.StandbyTenantWarm[tenant] = 1
	} else {
		m.StandbyTenantWarm[tenant] = 0
	}
}

// TenantWarm returns the per-tenant warmth gauge, 0 when never set (tests).
func (m *Metrics) TenantWarm(tenant string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.StandbyTenantWarm[tenant]
}

// SetFailoverReason records the classification of the failover that just completed
// (e.g. "node_death"), exposed as pswatcher_failover_reason{reason="..."} 1.
func (m *Metrics) SetFailoverReason(reason string) {
	m.mu.Lock()
	m.FailoverReasonVal = reason
	m.mu.Unlock()
}

// FailoverReason returns the last recorded failover classification (tests).
func (m *Metrics) FailoverReason() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.FailoverReasonVal
}

// Promotions returns the promotion count (used by tests).
func (m *Metrics) Promotions() int { m.mu.Lock(); defer m.mu.Unlock(); return m.PromotionsTotal }

// PrimaryUp returns the last recorded read-authority liveness (used by tests).
func (m *Metrics) PrimaryUp() int { m.mu.Lock(); defer m.mu.Unlock(); return m.PrimaryUpVal }

// FailedOver returns 1 once a failover has happened (used by tests).
func (m *Metrics) FailedOver() int { m.mu.Lock(); defer m.mu.Unlock(); return m.FailedOverVal }

// SuspectedPartitions returns the withheld-promotion count (used by tests).
func (m *Metrics) SuspectedPartitions() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.SuspectedPartitionsTotal
}

// PromText renders the Prometheus text exposition.
func (m *Metrics) PromText() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	// D9 running-binary capability signal, emitted unconditionally so a scraper can
	// prove the DEPLOYED binary carries these features (a stale image cannot emit them).
	out := fmt.Sprintf("pswatcher_build_info{version=%q,features=%q} 1\n", BuildVersion, FeaturesLabel())
	out += fmt.Sprintf(
		"pswatcher_promotions_total %d\n"+
			"pswatcher_checks_total %d\n"+
			"pswatcher_primary_up %d\n"+
			"pswatcher_failed_over %d\n"+
			"pswatcher_suspected_partitions_total %d\n"+
			"pswatcher_primary_never_seen_total %d\n"+
			"pswatcher_tenant_absent_total %d\n"+
			"pswatcher_ledger_heal_errors_total %d\n"+
			"pswatcher_dependency_degraded_total %d\n"+
			"pswatcher_failover_frozen %d\n"+
			"pswatcher_failover_freeze_suppressed_total %d\n"+
			"pswatcher_failover_freeze_expiry_seconds %d\n"+
			"pswatcher_freeze_read_errors_total %d\n"+
			"pswatcher_converge_repromotions_total %d\n"+
			"pswatcher_converge_blocked_total %d\n"+
			"pswatcher_converge_errors_total %d\n"+
			"pswatcher_converge_tenant_absent_total %d\n"+
			"pswatcher_ledger_cas_conflicts_total %d\n"+
			"pswatcher_standby_warm_reconciles_total %d\n"+
			"pswatcher_standby_warm_registrations_total %d\n"+
			"pswatcher_standby_warm_errors_total %d\n"+
			"pswatcher_standby_stale_attached_total %d\n",
		m.PromotionsTotal, m.ChecksTotal, m.PrimaryUpVal, m.FailedOverVal, m.SuspectedPartitionsTotal, m.PrimaryNeverSeenTotal, m.TenantAbsentTotal, m.LedgerHealErrorsTotal,
		m.DependencyDegradedTotal, m.FailoverFrozenVal, m.FailoverFreezeSuppressed, m.FailoverFreezeExpirySecond, m.FreezeReadErrorsTotal,
		m.ConvergeRepromotionsTotal, m.ConvergeBlockedTotal, m.ConvergeErrorsTotal, m.ConvergeTenantAbsentTotal, m.LedgerCASConflictsTotal,
		m.StandbyWarmReconcilesTotal, m.StandbyWarmRegistrationsTotal, m.StandbyWarmErrorsTotal, m.StandbyStaleAttachedTotal,
	)
	// D1 — the per-tenant loss-of-warmth gauge, one LABELED sample per routed tenant the
	// reconcile has observed. Rendered in sorted key order so the exposition is stable.
	for _, tenant := range sortedKeys(m.StandbyTenantWarm) {
		out += fmt.Sprintf("pswatcher_standby_tenant_warm{tenant=%q} %d\n", tenant, m.StandbyTenantWarm[tenant])
	}
	// The classification of the last failover is a LABELED sample so a scraper can
	// prove the watcher discriminated node-death from a non-death event. Emitted only
	// once a failover has actually been classified (never a bare zero-value line).
	if m.FailoverReasonVal != "" {
		out += fmt.Sprintf("pswatcher_failover_reason{reason=%q} 1\n", m.FailoverReasonVal)
	}
	return out
}

// Handler serves /healthz, /metrics (Prometheus) and /metrics.json.
func (m *Metrics) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain")
		_, _ = w.Write([]byte(m.PromText()))
	})
	mux.HandleFunc("/metrics.json", func(w http.ResponseWriter, _ *http.Request) {
		m.mu.Lock()
		b, err := json.MarshalIndent(m, "", "  ")
		m.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write(b)
	})
	return mux
}
