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
	return fmt.Sprintf(
		"pswatcher_promotions_total %d\n"+
			"pswatcher_checks_total %d\n"+
			"pswatcher_primary_up %d\n"+
			"pswatcher_failed_over %d\n"+
			"pswatcher_suspected_partitions_total %d\n",
		m.PromotionsTotal, m.ChecksTotal, m.PrimaryUpVal, m.FailedOverVal, m.SuspectedPartitionsTotal,
	)
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
