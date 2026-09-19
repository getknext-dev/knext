package gateway

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// sleepFailDriver drives the idle-scale-down path with a Sleep that always
// errors, so the sleep-FAILURE observability path (a compute that will not scale
// to zero — a billable cost leak) can be exercised without a cluster.
type sleepFailDriver struct {
	mu       sync.Mutex
	attempts int
}

func (d *sleepFailDriver) Mode() string { return "sleepfail" }
func (d *sleepFailDriver) Resolve(s string) wake.Target {
	return wake.Target{Host: "h", Port: 1, Key: s}
}
func (d *sleepFailDriver) Wake(context.Context, wake.Target) error { return nil }
func (d *sleepFailDriver) Sleep(context.Context, wake.Target) error {
	d.mu.Lock()
	d.attempts++
	d.mu.Unlock()
	return errors.New("scale-to-zero API call failed")
}
func (d *sleepFailDriver) CanSleep() bool { return true }

// wakeBackFailDriver succeeds at Sleep but simulates a connection ARRIVING mid
// scale-down (the TOCTOU race), then FAILS the wake-back — the second log-only
// site. It bumps the gateway's own connection count from inside Sleep so the
// post-sleep "arrived" branch runs and calls Wake, which errors.
type wakeBackFailDriver struct {
	gw *Gateway
}

func (d *wakeBackFailDriver) Mode() string { return "wakebackfail" }
func (d *wakeBackFailDriver) Resolve(s string) wake.Target {
	return wake.Target{Host: "h", Port: 1, Key: s}
}
func (d *wakeBackFailDriver) Wake(context.Context, wake.Target) error {
	return errors.New("wake-back API call failed")
}
func (d *wakeBackFailDriver) Sleep(_ context.Context, t wake.Target) error {
	// A client connection races in while the (successful) sleep is in flight.
	d.gw.connStarted(t, false)
	return nil
}
func (d *wakeBackFailDriver) CanSleep() bool { return true }

// erroringPeers always fails the fleet idle check, exercising the peer-check
// failure path (a persistent peer-scrape failure pins every compute awake —
// another silent cost leak).
type erroringPeers struct{}

func (erroringPeers) ActiveConnections(context.Context, string) (int, error) {
	return 0, errors.New("peer scrape failed")
}

// A driver.Sleep failure must increment a scrapeable failure counter and must
// NOT be counted as a success (no double-count / no regression of SleepsTotal).
func TestSleepFailureIncrementsFailureMetric(t *testing.T) {
	gw, err := New(wake.Env{
		"GW_COMPUTE_TLS":  "false", // fake backends speak PLAINTEXT Postgres (F5 phase-3 backend TLS is covered in internal/wake + New's wiring test)
		"GW_COMPUTE_MODE": "exec",
		"GW_TARGET":       "127.0.0.1:1",
		"GW_WAKE_CMD":     "true",
		"GW_SLEEP_CMD":    "true",
		"GW_IDLE_MS":      "40",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	drv := &sleepFailDriver{}
	gw.driver = drv

	target := drv.Resolve("appx")
	gw.connStarted(target, false)
	gw.connEnded(target, false) // count -> 0, idle timer armed

	deadline := time.Now().Add(2 * time.Second)
	for {
		if gw.Metrics().SleepFailures() >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sleep-failure metric never moved (SleepFailures=%d, driver attempts>=%d)",
				gw.Metrics().SleepFailures(), 1)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The success counter must NOT have moved — a failed sleep is not a sleep.
	if got := gw.Metrics().Sleeps(); got != 0 {
		t.Fatalf("SleepsTotal moved on a FAILED sleep (got %d, want 0) — double-count/regression", got)
	}

	// It must be scrapeable on the Prometheus text plane.
	prom := gw.Metrics().PromText()
	if !strings.Contains(prom, "pggw_sleep_failures_total ") {
		t.Fatalf("pggw_sleep_failures_total absent from PromText:\n%s", prom)
	}
	if strings.Contains(prom, "pggw_sleep_failures_total 0") {
		t.Fatalf("pggw_sleep_failures_total still 0 after a failed sleep:\n%s", prom)
	}
}

// A wake-back failure after the sleep-race must increment its own failure counter.
func TestWakeBackFailureIncrementsFailureMetric(t *testing.T) {
	gw, err := New(wake.Env{
		"GW_COMPUTE_TLS":  "false", // fake backends speak PLAINTEXT Postgres (F5 phase-3 backend TLS is covered in internal/wake + New's wiring test)
		"GW_COMPUTE_MODE": "exec",
		"GW_TARGET":       "127.0.0.1:1",
		"GW_WAKE_CMD":     "true",
		"GW_SLEEP_CMD":    "true",
		"GW_IDLE_MS":      "40",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	drv := &wakeBackFailDriver{gw: gw}
	gw.driver = drv

	target := drv.Resolve("appx")
	gw.connStarted(target, false)
	gw.connEnded(target, false) // count -> 0, idle timer armed

	deadline := time.Now().Add(2 * time.Second)
	for {
		if gw.Metrics().WakeBackFailures() >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("wake-back-failure metric never moved (WakeBackFailures=%d)",
				gw.Metrics().WakeBackFailures())
		}
		time.Sleep(10 * time.Millisecond)
	}

	if !strings.Contains(gw.Metrics().PromText(), "pggw_wake_back_failures_total ") {
		t.Fatalf("pggw_wake_back_failures_total absent from PromText")
	}
}

// A peer idle-check failure must increment its own failure counter so a
// persistent peer-scrape outage (which pins the whole fleet awake) is alertable.
func TestPeerCheckFailureIncrementsFailureMetric(t *testing.T) {
	gw, err := New(wake.Env{
		"GW_COMPUTE_TLS":  "false", // fake backends speak PLAINTEXT Postgres (F5 phase-3 backend TLS is covered in internal/wake + New's wiring test)
		"GW_COMPUTE_MODE": "exec",
		"GW_TARGET":       "127.0.0.1:1",
		"GW_WAKE_CMD":     "true",
		"GW_SLEEP_CMD":    "true",
		"GW_IDLE_MS":      "40",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	rd := &recordingDriver{}
	gw.driver = rd
	gw.Peers = erroringPeers{}

	target := rd.Resolve("appx")
	gw.connStarted(target, false)
	gw.connEnded(target, false) // count -> 0, idle timer armed; peer check will error

	deadline := time.Now().Add(2 * time.Second)
	for {
		if gw.Metrics().PeerCheckFailures() >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("peer-check-failure metric never moved (PeerCheckFailures=%d)",
				gw.Metrics().PeerCheckFailures())
		}
		time.Sleep(10 * time.Millisecond)
	}

	// A peer-check failure postpones sleep — it must NOT be counted as a sleep.
	if got := gw.Metrics().Sleeps(); got != 0 {
		t.Fatalf("SleepsTotal moved despite a peer-check failure (got %d, want 0)", got)
	}
	if !strings.Contains(gw.Metrics().PromText(), "pggw_peer_check_failures_total ") {
		t.Fatalf("pggw_peer_check_failures_total absent from PromText")
	}
}
