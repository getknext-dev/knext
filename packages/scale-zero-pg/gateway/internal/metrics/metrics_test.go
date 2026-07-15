package metrics

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCountersTrackConnectionsWakesSleeps(t *testing.T) {
	m := NewMetrics()
	m.ConnOpen("db/compute")
	m.ConnOpen("db/compute")
	if m.Connections() != 2 || m.Active() != 2 {
		t.Fatalf("connections=%d active=%d, want 2/2", m.Connections(), m.Active())
	}
	m.Wake("db/compute", 321)
	if m.Wakes() != 1 {
		t.Fatalf("wakes = %d, want 1", m.Wakes())
	}
	m.ConnClose("db/compute")
	if m.Active() != 1 {
		t.Fatalf("active = %d, want 1", m.Active())
	}
	m.Sleep()
	if m.Sleeps() != 1 {
		t.Fatalf("sleeps = %d, want 1", m.Sleeps())
	}
	m.WakeFailure()
	if m.WakeFailures() != 1 {
		t.Fatalf("wake_failures = %d, want 1", m.WakeFailures())
	}
	// Wake-scale retry counter (issue #190): each retried transient blip bumps it.
	m.WakeRetry()
	m.WakeRetry()
	if m.WakeRetries() != 2 {
		t.Fatalf("wake_retries = %d, want 2", m.WakeRetries())
	}
	if !strings.Contains(m.PromText(), "pggw_wake_retries_total 2") {
		t.Fatalf("PromText missing pggw_wake_retries_total 2:\n%s", m.PromText())
	}
	// Warm-pool gate gauge: 0 by default, 1 when open, surfaced in Prometheus
	// text so operators can alarm on a stuck-open gate.
	if !strings.Contains(m.PromText(), "pggw_gate_open 0") {
		t.Fatalf("PromText missing pggw_gate_open 0:\n%s", m.PromText())
	}
	m.SetGateOpen(true)
	if !strings.Contains(m.PromText(), "pggw_gate_open 1") {
		t.Fatalf("after SetGateOpen(true), PromText missing pggw_gate_open 1:\n%s", m.PromText())
	}
	m.SetGateOpen(false)
	if !strings.Contains(m.PromText(), "pggw_gate_open 0") {
		t.Fatalf("after SetGateOpen(false), PromText missing pggw_gate_open 0")
	}
}

func TestPromTextHasExpectedSeries(t *testing.T) {
	m := NewMetrics()
	m.ConnOpen("db/compute")
	m.Wake("db/compute", 300)
	txt := m.PromText()
	for _, want := range []string{
		"pggw_connections_total 1",
		"pggw_active_connections 1",
		"pggw_wakes_total 1",
		"pggw_wake_failures_total 0",
		"pggw_wake_retries_total 0",
		"pggw_sleeps_total 0",
		"pggw_wake_latency_ms_last 300",
		`pggw_system_active_connections{system="db/compute"} 1`,
		`pggw_system_wakes_total{system="db/compute"} 1`,
		`pggw_system_last_wake_ms{system="db/compute"} 300`,
	} {
		if !strings.Contains(txt, want) {
			t.Fatalf("prom text missing %q\n%s", want, txt)
		}
	}
}

func TestHTTPEndpoints(t *testing.T) {
	m := NewMetrics()
	m.ConnOpen("s")
	m.Wake("s", 42)
	srv := httptest.NewServer(m.Handler())
	defer srv.Close()

	get := func(path string) (int, string) {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	if code, body := get("/healthz"); code != 200 || !strings.Contains(body, "ok") {
		t.Fatalf("/healthz = %d %q", code, body)
	}

	code, body := get("/metrics.json")
	if code != 200 {
		t.Fatalf("/metrics.json code = %d", code)
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(body), &data); err != nil {
		t.Fatalf("/metrics.json not JSON: %v", err)
	}
	for _, k := range []string{
		"connections_total", "active_connections", "wakes_total",
		"wake_failures_total", "sleeps_total", "wake_latency_ms_last", "per_system",
	} {
		if _, ok := data[k]; !ok {
			t.Fatalf("/metrics.json missing field %q", k)
		}
	}

	if code, body := get("/metrics"); code != 200 || !strings.Contains(body, "pggw_wakes_total") {
		t.Fatalf("/metrics = %d %q", code, body)
	}
}
