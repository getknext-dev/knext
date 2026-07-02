// Package metrics exposes JSON on /metrics.json, Prometheus text on /metrics,
// and liveness on /healthz. Stdlib http only.
package metrics

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// sysMetrics holds per-compute-key counters.
type sysMetrics struct {
	Connections int   `json:"connections"`
	Active      int   `json:"active"`
	Wakes       int   `json:"wakes"`
	LastWakeMs  int64 `json:"last_wake_ms"`
}

// Metrics holds gateway counters, safe for concurrent use.
type Metrics struct {
	mu sync.Mutex

	ConnectionsTotal         int                    `json:"connections_total"`
	ActiveConnections        int                    `json:"active_connections"`
	WakesTotal               int                    `json:"wakes_total"`
	WakeFailuresTotal        int                    `json:"wake_failures_total"`
	SleepsTotal              int                    `json:"sleeps_total"`
	RejectedConnectionsTotal int                    `json:"rejected_connections_total"`
	WakeLatencyMsLast        int64                  `json:"wake_latency_ms_last"`
	WakeLatencyMs            []int64                `json:"wake_latency_ms"`
	PerSystem                map[string]*sysMetrics `json:"per_system"`
}

// NewMetrics constructs an empty Metrics.
func NewMetrics() *Metrics {
	return &Metrics{
		WakeLatencyMs: []int64{},
		PerSystem:     map[string]*sysMetrics{},
	}
}

// sys returns the per-system entry, creating it if needed. Caller holds the lock.
func (m *Metrics) sys(key string) *sysMetrics {
	s := m.PerSystem[key]
	if s == nil {
		s = &sysMetrics{}
		m.PerSystem[key] = s
	}
	return s
}

func (m *Metrics) ConnOpen(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ConnectionsTotal++
	m.ActiveConnections++
	s := m.sys(key)
	s.Connections++
	s.Active++
}

func (m *Metrics) ConnClose(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ActiveConnections--
	m.sys(key).Active--
}

func (m *Metrics) Wake(key string, ms int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.WakesTotal++
	m.WakeLatencyMsLast = ms
	m.WakeLatencyMs = append(m.WakeLatencyMs, ms)
	if len(m.WakeLatencyMs) > 100 {
		m.WakeLatencyMs = m.WakeLatencyMs[1:]
	}
	s := m.sys(key)
	s.Wakes++
	s.LastWakeMs = ms
}

func (m *Metrics) WakeFailure() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.WakeFailuresTotal++
}

// RejectConn counts a connection refused by the GW_MAX_CONNS cap.
func (m *Metrics) RejectConn() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.RejectedConnectionsTotal++
}

func (m *Metrics) Sleep() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.SleepsTotal++
}

// Thread-safe accessors (used by tests and callers).
func (m *Metrics) Connections() int  { m.mu.Lock(); defer m.mu.Unlock(); return m.ConnectionsTotal }
func (m *Metrics) Active() int       { m.mu.Lock(); defer m.mu.Unlock(); return m.ActiveConnections }
func (m *Metrics) Wakes() int        { m.mu.Lock(); defer m.mu.Unlock(); return m.WakesTotal }
func (m *Metrics) WakeFailures() int { m.mu.Lock(); defer m.mu.Unlock(); return m.WakeFailuresTotal }
func (m *Metrics) Sleeps() int       { m.mu.Lock(); defer m.mu.Unlock(); return m.SleepsTotal }
func (m *Metrics) Rejected() int     { m.mu.Lock(); defer m.mu.Unlock(); return m.RejectedConnectionsTotal }

// PromText renders the Prometheus text exposition.
func (m *Metrics) PromText() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	lines := []string{
		fmt.Sprintf("pggw_connections_total %d", m.ConnectionsTotal),
		fmt.Sprintf("pggw_active_connections %d", m.ActiveConnections),
		fmt.Sprintf("pggw_wakes_total %d", m.WakesTotal),
		fmt.Sprintf("pggw_wake_failures_total %d", m.WakeFailuresTotal),
		fmt.Sprintf("pggw_sleeps_total %d", m.SleepsTotal),
		fmt.Sprintf("pggw_rejected_connections_total %d", m.RejectedConnectionsTotal),
		fmt.Sprintf("pggw_wake_latency_ms_last %d", m.WakeLatencyMsLast),
	}
	keys := make([]string, 0, len(m.PerSystem))
	for k := range m.PerSystem {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		s := m.PerSystem[k]
		lines = append(lines,
			fmt.Sprintf("pggw_system_active_connections{system=%q} %d", k, s.Active),
			fmt.Sprintf("pggw_system_wakes_total{system=%q} %d", k, s.Wakes),
			fmt.Sprintf("pggw_system_last_wake_ms{system=%q} %d", k, s.LastWakeMs),
		)
	}
	return strings.Join(lines, "\n") + "\n"
}

// Handler serves /healthz, /metrics.json and /metrics.
func (m *Metrics) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
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
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(m.PromText()))
	})
	return mux
}
