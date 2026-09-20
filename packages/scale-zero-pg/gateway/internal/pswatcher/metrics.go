package pswatcher

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
)

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
	out := fmt.Sprintf(
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
			"pswatcher_freeze_read_errors_total %d\n",
		m.PromotionsTotal, m.ChecksTotal, m.PrimaryUpVal, m.FailedOverVal, m.SuspectedPartitionsTotal, m.PrimaryNeverSeenTotal, m.TenantAbsentTotal, m.LedgerHealErrorsTotal,
		m.DependencyDegradedTotal, m.FailoverFrozenVal, m.FailoverFreezeSuppressed, m.FailoverFreezeExpirySecond, m.FreezeReadErrorsTotal,
	)
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
