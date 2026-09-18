// Package metrics exposes JSON on /metrics.json, Prometheus text on /metrics,
// and liveness on /healthz. Stdlib http only.
package metrics

import (
	"crypto/hmac"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// PeerAuth configures bearer-token auth for the /metrics.json peer idle-scrape
// (F6). It is fail-closed by construction — see ResolvePeerAuth.
type PeerAuth struct {
	token    string
	disabled bool
}

// Disabled reports whether peer-scrape auth was EXPLICITLY turned off via the
// dev opt-out (GW_PEER_AUTH_DISABLED=true). Boot logs a loud WARN in that case.
func (a PeerAuth) Disabled() bool { return a.disabled }

// ErrPeerAuthUnset is the fail-closed boot guard: an empty GW_PEER_TOKEN with no
// explicit GW_PEER_AUTH_DISABLED=true opt-out must abort startup rather than
// serve an open /metrics.json peer scrape.
var ErrPeerAuthUnset = errors.New(
	`GW_PEER_TOKEN is empty and GW_PEER_AUTH_DISABLED != "true": refusing to serve an unauthenticated /metrics.json peer idle-scrape. Set GW_PEER_TOKEN (from the pggw-peer-token Secret), or GW_PEER_AUTH_DISABLED=true for local dev only`)

// ResolvePeerAuth reads the peer-scrape auth config, fail-closed by construction:
// missing token without the explicit dev opt-out is a fatal error (never a
// silent open). getenv is injectable for tests (pass os.Getenv in main).
func ResolvePeerAuth(getenv func(string) string) (PeerAuth, error) {
	token := getenv("GW_PEER_TOKEN")
	disabled := getenv("GW_PEER_AUTH_DISABLED") == "true"
	if token == "" && !disabled {
		return PeerAuth{}, ErrPeerAuthUnset
	}
	return PeerAuth{token: token, disabled: disabled}, nil
}

// peerAuthOK constant-time-compares the Authorization header against the fleet
// token. Requires the "Bearer " scheme; any mismatch (including a missing or
// non-Bearer header) is a reject.
func peerAuthOK(header, token string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	return hmac.Equal([]byte(header[len(prefix):]), []byte(token))
}

// sysMetrics holds per-compute-key counters.
type sysMetrics struct {
	Connections int   `json:"connections"`
	Active      int   `json:"active"`
	Wakes       int   `json:"wakes"`
	LastWakeMs  int64 `json:"last_wake_ms"`
	// WakeBudgetExceeded counts wakes REFUSED for this app because it burned its
	// per-app wake budget (issue #116, ADR-0008). A nonzero value means a caller is
	// force-waking this app faster than GW_WAKE_BUDGET/GW_WAKE_WINDOW_MS allows and
	// the gateway declined to scale — a possible unauthenticated wake side-channel /
	// noisy-neighbour DoS. Per-app so the source tenant is identifiable.
	WakeBudgetExceeded int `json:"wake_budget_exceeded"`
}

// Metrics holds gateway counters, safe for concurrent use.
type Metrics struct {
	mu sync.Mutex

	ConnectionsTotal  int `json:"connections_total"`
	ActiveConnections int `json:"active_connections"`
	WakesTotal        int `json:"wakes_total"`
	WakeFailuresTotal int `json:"wake_failures_total"`
	// WakeRetriesTotal counts transient scale-call attempts that were RETRIED
	// (issue #190): an OKE apiserver blip (TLS handshake timeout / 5xx / throttle /
	// conflict) that the bounded backoff absorbed instead of failing the client's
	// cold wake. A rising WakeRetriesTotal with a flat WakeFailuresTotal is the
	// signal that retries are silently rescuing wakes the old path would have failed;
	// a rising WakeRetriesTotal that DOES drag WakeFailuresTotal up means the retries
	// are exhausting (a sustained apiserver outage) — the two together distinguish
	// 'retried-then-succeeded' from 'failed-after-retries'.
	WakeRetriesTotal int `json:"wake_retries_total"`
	SleepsTotal      int `json:"sleeps_total"`
	// SleepFailuresTotal counts scale-DOWN (driver.Sleep) attempts that ERRORED.
	// SleepsTotal counts successes only, so without this there is no denominator:
	// a compute that repeatedly fails to scale to zero (a phantom keepalive still
	// billing) is otherwise invisible on Prometheus. Sibling of WakeFailuresTotal
	// on the cost axis, mirroring WakeFailuresTotal on the latency axis.
	SleepFailuresTotal int `json:"sleep_failures_total"`
	// WakeBackFailuresTotal counts TOCTOU wake-back attempts that FAILED: a client
	// connection arrived while a (successful) sleep was in flight and the gateway
	// could not scale the compute back up. A rising value means clients are being
	// left pointed at a compute that was scaled to zero underneath them.
	WakeBackFailuresTotal int `json:"wake_back_failures_total"`
	// PeerCheckFailuresTotal counts fleet idle-check (peer scrape) errors that
	// POSTPONED a sleep. A persistent nonzero value means peer scrapes are failing
	// and every compute is being pinned awake fleet-wide — a silent cost leak.
	PeerCheckFailuresTotal   int `json:"peer_check_failures_total"`
	RejectedConnectionsTotal int `json:"rejected_connections_total"`
	// WakeBudgetExceededTotal counts wakes REFUSED across all apps because the
	// requesting app had exhausted its per-app wake budget (issue #116, ADR-0008).
	// It is NOT a wake FAILURE (a real cold-start error, WakeFailuresTotal) — it is a
	// deliberate refusal to scale, so the two never share an alert.
	WakeBudgetExceededTotal int `json:"wake_budget_exceeded_total"`
	// ReplicationConnectionsTotal counts REPLICATION (walreceiver) streams the
	// gateway has mediated — a subscriber connecting through the gateway to wake +
	// drain a publisher (ADR-0007 §4c). A nonzero value on a publisher's gateway is
	// the signal that a cross-zone slot is (or was) live and held it awake.
	ReplicationConnectionsTotal int                    `json:"replication_connections_total"`
	WakeLatencyMsLast           int64                  `json:"wake_latency_ms_last"`
	WakeLatencyMs               []int64                `json:"wake_latency_ms"`
	GateOpen                    int                    `json:"gate_open"`
	PerSystem                   map[string]*sysMetrics `json:"per_system"`
}

// SetGateOpen records the warm-pool gate state (1 = open/accepting, 0 = closed).
func (m *Metrics) SetGateOpen(open bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if open {
		m.GateOpen = 1
	} else {
		m.GateOpen = 0
	}
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

// WakeRetry counts one retried transient scale-call attempt (issue #190).
func (m *Metrics) WakeRetry() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.WakeRetriesTotal++
}

// RejectConn counts a connection refused by the GW_MAX_CONNS cap.
func (m *Metrics) RejectConn() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.RejectedConnectionsTotal++
}

// WakeBudgetExceeded counts a wake REFUSED because the app (key) had exhausted its
// per-app wake budget (issue #116, ADR-0008). Bumps both the fleet total and the
// per-app counter so an alert can page and an operator can name the offending app.
func (m *Metrics) WakeBudgetExceeded(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.WakeBudgetExceededTotal++
	m.sys(key).WakeBudgetExceeded++
}

// ReplicationConn counts a REPLICATION (walreceiver) stream mediated by the
// gateway — a subscriber waking + draining a publisher through the wake-on-connect
// path (ADR-0007 §4c).
func (m *Metrics) ReplicationConn() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ReplicationConnectionsTotal++
}

func (m *Metrics) Sleep() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.SleepsTotal++
}

// SleepFailure counts one driver.Sleep error (a compute that did not scale to
// zero). Distinct from Sleep() so a failed scale-down never counts as a success.
func (m *Metrics) SleepFailure() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.SleepFailuresTotal++
}

// WakeBackFailure counts one failed TOCTOU wake-back after a sleep race.
func (m *Metrics) WakeBackFailure() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.WakeBackFailuresTotal++
}

// PeerCheckFailure counts one fleet idle-check (peer scrape) error that
// postponed a sleep.
func (m *Metrics) PeerCheckFailure() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.PeerCheckFailuresTotal++
}

// Thread-safe accessors (used by tests and callers).
func (m *Metrics) Connections() int  { m.mu.Lock(); defer m.mu.Unlock(); return m.ConnectionsTotal }
func (m *Metrics) Active() int       { m.mu.Lock(); defer m.mu.Unlock(); return m.ActiveConnections }
func (m *Metrics) Wakes() int        { m.mu.Lock(); defer m.mu.Unlock(); return m.WakesTotal }
func (m *Metrics) WakeFailures() int { m.mu.Lock(); defer m.mu.Unlock(); return m.WakeFailuresTotal }
func (m *Metrics) WakeRetries() int  { m.mu.Lock(); defer m.mu.Unlock(); return m.WakeRetriesTotal }
func (m *Metrics) Sleeps() int       { m.mu.Lock(); defer m.mu.Unlock(); return m.SleepsTotal }
func (m *Metrics) SleepFailures() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.SleepFailuresTotal
}
func (m *Metrics) WakeBackFailures() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.WakeBackFailuresTotal
}
func (m *Metrics) PeerCheckFailures() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.PeerCheckFailuresTotal
}
func (m *Metrics) Rejected() int { m.mu.Lock(); defer m.mu.Unlock(); return m.RejectedConnectionsTotal }
func (m *Metrics) WakeBudgetExceededCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.WakeBudgetExceededTotal
}
func (m *Metrics) ReplicationConns() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ReplicationConnectionsTotal
}

// PromText renders the Prometheus text exposition.
func (m *Metrics) PromText() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	lines := []string{
		fmt.Sprintf("pggw_connections_total %d", m.ConnectionsTotal),
		fmt.Sprintf("pggw_active_connections %d", m.ActiveConnections),
		fmt.Sprintf("pggw_wakes_total %d", m.WakesTotal),
		fmt.Sprintf("pggw_wake_failures_total %d", m.WakeFailuresTotal),
		fmt.Sprintf("pggw_wake_retries_total %d", m.WakeRetriesTotal),
		fmt.Sprintf("pggw_sleeps_total %d", m.SleepsTotal),
		fmt.Sprintf("pggw_sleep_failures_total %d", m.SleepFailuresTotal),
		fmt.Sprintf("pggw_wake_back_failures_total %d", m.WakeBackFailuresTotal),
		fmt.Sprintf("pggw_peer_check_failures_total %d", m.PeerCheckFailuresTotal),
		fmt.Sprintf("pggw_rejected_connections_total %d", m.RejectedConnectionsTotal),
		fmt.Sprintf("pggw_wake_budget_exceeded_total %d", m.WakeBudgetExceededTotal),
		fmt.Sprintf("pggw_replication_connections_total %d", m.ReplicationConnectionsTotal),
		fmt.Sprintf("pggw_wake_latency_ms_last %d", m.WakeLatencyMsLast),
		fmt.Sprintf("pggw_gate_open %d", m.GateOpen),
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
			fmt.Sprintf("pggw_system_wake_budget_exceeded_total{system=%q} %d", k, s.WakeBudgetExceeded),
		)
	}
	return strings.Join(lines, "\n") + "\n"
}

// Handler serves /healthz, /metrics.json and /metrics with NO peer-scrape auth.
// Retained for the watcher sidecars (pswatcher, writer-autoscaler) that are not
// peer-scraped; the gateway uses HandlerWithPeerAuth (F6).
func (m *Metrics) Handler() http.Handler { return m.handler(nil) }

// HandlerWithPeerAuth serves the same endpoints but gates /metrics.json behind a
// bearer token (F6). /metrics (Prometheus text) and /healthz stay open.
func (m *Metrics) HandlerWithPeerAuth(auth PeerAuth) http.Handler {
	a := auth
	return m.handler(&a)
}

// handler builds the mux. When auth is non-nil and not disabled, /metrics.json
// requires Authorization: Bearer <auth.token> (constant-time compare) or 401.
func (m *Metrics) handler(auth *PeerAuth) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/metrics.json", func(w http.ResponseWriter, r *http.Request) {
		if auth != nil && !auth.disabled && !peerAuthOK(r.Header.Get("Authorization"), auth.token) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
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
