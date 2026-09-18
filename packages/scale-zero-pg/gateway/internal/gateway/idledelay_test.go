package gateway

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// windowDriver is a per-app driver (like template mode) that ALSO implements the
// idleWindowSource capability: its IdleDelayMs returns a settable per-app window,
// so the gateway's #779 idle-arm read can be exercised without a cluster.
type windowDriver struct {
	mu       sync.Mutex
	slept    []string
	windowMs int
	present  bool
}

func (d *windowDriver) Mode() string { return "window" }
func (d *windowDriver) Resolve(s string) wake.Target {
	return wake.Target{Host: "h", Port: 1, Key: s}
}
func (d *windowDriver) Wake(context.Context, wake.Target) error { return nil }
func (d *windowDriver) Sleep(_ context.Context, t wake.Target) error {
	d.mu.Lock()
	d.slept = append(d.slept, t.Key)
	d.mu.Unlock()
	return nil
}
func (d *windowDriver) CanSleep() bool { return true }
func (d *windowDriver) IdleDelayMs(_ context.Context, _ wake.Target) (int, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.windowMs, d.present
}
func (d *windowDriver) setWindow(ms int, present bool) {
	d.mu.Lock()
	d.windowMs, d.present = ms, present
	d.mu.Unlock()
}
func (d *windowDriver) sleptKeys() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.slept...)
}

func newGatewayWithDriver(t *testing.T, idleMs string, d wake.Driver) *Gateway {
	t.Helper()
	gw, err := New(wake.Env{
		"GW_COMPUTE_MODE": "exec",
		"GW_TARGET":       "127.0.0.1:1",
		"GW_WAKE_CMD":     "true",
		"GW_SLEEP_CMD":    "true",
		"GW_IDLE_MS":      idleMs,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	gw.driver = d
	return gw
}

// A per-app idleDelay annotation is HONORED over the fleet default: the fleet
// default is huge, but the app's own window is short, so it sleeps quickly.
// Mutation-prove: if the gateway ignored the annotation it would wait the fleet
// default and this test would time out.
func TestIdleWindow_PerAppAnnotationHonored(t *testing.T) {
	d := &windowDriver{windowMs: 30, present: true}
	gw := newGatewayWithDriver(t, "10000", d) // fleet default 10s; per-app 30ms

	tx := d.Resolve("shop")
	gw.connStarted(tx, false)
	gw.connEnded(tx, false)

	deadline := time.Now().Add(2 * time.Second)
	for {
		if len(d.sleptKeys()) == 1 {
			return // slept on the 30ms per-app window, not the 10s fleet default
		}
		if time.Now().After(deadline) {
			t.Fatal("compute never slept on its per-app idleDelay (fleet default was used instead)")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Absent/unreadable annotation ⇒ FLEET DEFAULT: the driver reports no override, so
// the short GW_IDLE_MS governs and the compute sleeps.
func TestIdleWindow_FallsBackToFleetDefault(t *testing.T) {
	d := &windowDriver{present: false} // no per-app override
	gw := newGatewayWithDriver(t, "30", d)

	tx := d.Resolve("shop")
	gw.connStarted(tx, false)
	gw.connEnded(tx, false)

	deadline := time.Now().Add(2 * time.Second)
	for {
		if len(d.sleptKeys()) == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("compute never slept on the fleet default when no per-app override was present")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// An idleDelay change takes effect on the NEXT arm and does NOT cancel/shorten an
// in-flight timer: arm with a long window, flip to a short one mid-flight, and the
// compute must still wait out the original long window (no early sleep).
func TestIdleWindow_ChangeAppliesOnNextArmNotInFlight(t *testing.T) {
	d := &windowDriver{windowMs: 400, present: true}
	gw := newGatewayWithDriver(t, "10000", d)

	tx := d.Resolve("shop")
	gw.connStarted(tx, false)
	gw.connEnded(tx, false) // arm 1: 400ms window in flight

	// Operator shrinks idleDelay to 10ms mid-flight.
	d.setWindow(10, true)

	// The in-flight 400ms timer must NOT be shortened to 10ms.
	time.Sleep(200 * time.Millisecond)
	if got := d.sleptKeys(); len(got) != 0 {
		t.Fatalf("in-flight timer was shortened by a mid-flight idleDelay change: slept=%v", got)
	}

	// It still sleeps once the ORIGINAL 400ms window elapses.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if len(d.sleptKeys()) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("compute never slept on the original in-flight window")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The NEXT arm reads the new (short) window: a fresh conn cycle sleeps fast.
	gw.connStarted(tx, false)
	gw.connEnded(tx, false)
	deadline = time.Now().Add(2 * time.Second)
	for {
		if len(d.sleptKeys()) == 2 {
			return // arm 2 honored the freshly-read 10ms window
		}
		if time.Now().After(deadline) {
			t.Fatal("next arm did not pick up the changed idleDelay")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
