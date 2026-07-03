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

	PromotionsTotal int `json:"promotions_total"`
	ChecksTotal     int `json:"checks_total"`
	PrimaryUp       int `json:"primary_up"` // 1 = primary (or promoted standby) reachable
}

// NewMetrics starts with primary assumed up (avoids a spurious 0 before the
// first probe completes).
func NewMetrics() *Metrics { return &Metrics{PrimaryUp: 1} }

// Promotion counts one completed failover.
func (m *Metrics) Promotion() { m.mu.Lock(); m.PromotionsTotal++; m.mu.Unlock() }

// Check counts one liveness poll.
func (m *Metrics) Check() { m.mu.Lock(); m.ChecksTotal++; m.mu.Unlock() }

// SetPrimaryUp records the last observed primary liveness.
func (m *Metrics) SetPrimaryUp(up bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if up {
		m.PrimaryUp = 1
	} else {
		m.PrimaryUp = 0
	}
}

// Promotions returns the promotion count (used by tests).
func (m *Metrics) Promotions() int { m.mu.Lock(); defer m.mu.Unlock(); return m.PromotionsTotal }

// PromText renders the Prometheus text exposition.
func (m *Metrics) PromText() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return fmt.Sprintf(
		"pswatcher_promotions_total %d\npswatcher_checks_total %d\npswatcher_primary_up %d\n",
		m.PromotionsTotal, m.ChecksTotal, m.PrimaryUp,
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
