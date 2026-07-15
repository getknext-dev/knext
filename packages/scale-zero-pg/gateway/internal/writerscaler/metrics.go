package writerscaler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
)

// Metrics holds the autoscaler's counters, safe for concurrent use (the HTTP
// server reads while the control loop writes).
type Metrics struct {
	mu sync.Mutex

	ChecksTotal        int `json:"checks_total"`
	ResizeUpCPUTotal   int `json:"resize_up_cpu_total"`
	ResizeDownCPUTotal int `json:"resize_down_cpu_total"`
	ResizeUpMemTotal   int `json:"resize_up_mem_total"`
	ResizeDownMemTotal int `json:"resize_down_mem_total"`
	NeedsBounceTotal   int `json:"needs_bounce_total"` // memory-bound-at-max flags (never a silent bounce)
	ErrorsTotal        int `json:"errors_total"`
	NoSampleTotal      int `json:"no_sample_total"` // ticks a writer pod had no metrics sample (skipped, not scaled)
	Writers            int `json:"writers"`         // last observed writer-pod count
}

// NewMetrics returns a zeroed metric set.
func NewMetrics() *Metrics { return &Metrics{} }

// Check counts one control-loop tick.
func (m *Metrics) Check() { m.mu.Lock(); m.ChecksTotal++; m.mu.Unlock() }

// Resize counts one actuated in-place resize by direction and resource.
func (m *Metrics) Resize(dir Direction, resource string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case dir == Up && resource == "cpu":
		m.ResizeUpCPUTotal++
	case dir == Down && resource == "cpu":
		m.ResizeDownCPUTotal++
	case dir == Up && resource == "memory":
		m.ResizeUpMemTotal++
	case dir == Down && resource == "memory":
		m.ResizeDownMemTotal++
	}
}

// NeedsBounce counts one writer flagged for an operator maintenance-window bounce.
func (m *Metrics) NeedsBounce() { m.mu.Lock(); m.NeedsBounceTotal++; m.mu.Unlock() }

// Error counts one failed cluster action (resize/flag).
func (m *Metrics) Error() { m.mu.Lock(); m.ErrorsTotal++; m.mu.Unlock() }

// NoSample counts one tick a writer pod had no metrics sample (skipped, not scaled).
func (m *Metrics) NoSample() { m.mu.Lock(); m.NoSampleTotal++; m.mu.Unlock() }

// SetWriters records the last observed writer-pod count.
func (m *Metrics) SetWriters(n int) { m.mu.Lock(); m.Writers = n; m.mu.Unlock() }

// Counters (used by tests).
func (m *Metrics) Checks() int        { m.mu.Lock(); defer m.mu.Unlock(); return m.ChecksTotal }
func (m *Metrics) ResizeUpCPU() int   { m.mu.Lock(); defer m.mu.Unlock(); return m.ResizeUpCPUTotal }
func (m *Metrics) ResizeDownCPU() int { m.mu.Lock(); defer m.mu.Unlock(); return m.ResizeDownCPUTotal }
func (m *Metrics) ResizeUpMem() int   { m.mu.Lock(); defer m.mu.Unlock(); return m.ResizeUpMemTotal }
func (m *Metrics) ResizeDownMem() int { m.mu.Lock(); defer m.mu.Unlock(); return m.ResizeDownMemTotal }
func (m *Metrics) NeedsBounces() int  { m.mu.Lock(); defer m.mu.Unlock(); return m.NeedsBounceTotal }
func (m *Metrics) Errors() int        { m.mu.Lock(); defer m.mu.Unlock(); return m.ErrorsTotal }

// PromText renders the Prometheus text exposition.
func (m *Metrics) PromText() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return fmt.Sprintf(
		"writer_autoscaler_checks_total %d\n"+
			"writer_autoscaler_resize_total{direction=\"up\",resource=\"cpu\"} %d\n"+
			"writer_autoscaler_resize_total{direction=\"down\",resource=\"cpu\"} %d\n"+
			"writer_autoscaler_resize_total{direction=\"up\",resource=\"memory\"} %d\n"+
			"writer_autoscaler_resize_total{direction=\"down\",resource=\"memory\"} %d\n"+
			"writer_autoscaler_needs_bounce_total %d\n"+
			"writer_autoscaler_errors_total %d\n"+
			"writer_autoscaler_no_sample_total %d\n"+
			"writer_autoscaler_writers %d\n",
		m.ChecksTotal, m.ResizeUpCPUTotal, m.ResizeDownCPUTotal,
		m.ResizeUpMemTotal, m.ResizeDownMemTotal, m.NeedsBounceTotal, m.ErrorsTotal, m.NoSampleTotal, m.Writers,
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
