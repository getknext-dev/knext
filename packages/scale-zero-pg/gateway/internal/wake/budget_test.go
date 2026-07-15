package wake

import (
	"context"
	"errors"
	"net"
	"strconv"
	"testing"
	"time"
)

// budgetFakeDriver counts Wake calls; TryConnect always fails (port 1 => refused)
// so ConnectWithWake always reaches the wake branch and consults the guard.
type budgetFakeDriver struct{ wakes int }

func (*budgetFakeDriver) Mode() string          { return "fake" }
func (*budgetFakeDriver) Resolve(string) Target { return Target{Host: "127.0.0.1", Port: 1, Key: "a"} }
func (d *budgetFakeDriver) Wake(context.Context, Target) error {
	d.wakes++
	return nil
}
func (*budgetFakeDriver) Sleep(context.Context, Target) error { return nil }
func (*budgetFakeDriver) CanSleep() bool                      { return true }

func TestWakeLimiter_BudgetExhaustionRefuses(t *testing.T) {
	l := NewWakeLimiter(3, time.Minute)
	base := time.Unix(0, 0)
	l.now = func() time.Time { return base }
	for i := 0; i < 3; i++ {
		if !l.Allow("app-a") {
			t.Fatalf("wake %d should be allowed within budget 3", i+1)
		}
	}
	if l.Allow("app-a") {
		t.Fatal("4th wake in the same instant must be refused (budget exhausted)")
	}
}

func TestWakeLimiter_RefillOverWindow(t *testing.T) {
	// budget 6 / 60s => 1 token per 10s.
	l := NewWakeLimiter(6, time.Minute)
	base := time.Unix(0, 0)
	now := base
	l.now = func() time.Time { return now }
	for i := 0; i < 6; i++ {
		if !l.Allow("a") {
			t.Fatalf("burst wake %d should pass within budget 6", i+1)
		}
	}
	if l.Allow("a") {
		t.Fatal("budget exhausted, next wake must be refused")
	}
	// Advance 25s => 2.5 tokens refilled at 1/10s => exactly 2 wakes, 3rd refused.
	now = base.Add(25 * time.Second)
	if !l.Allow("a") {
		t.Fatal("expected refill token 1 after 25s")
	}
	if !l.Allow("a") {
		t.Fatal("expected refill token 2 after 25s")
	}
	if l.Allow("a") {
		t.Fatal("only 2 tokens should have refilled in 25s at 1/10s")
	}
}

func TestWakeLimiter_PerAppIsolation(t *testing.T) {
	l := NewWakeLimiter(1, time.Minute)
	base := time.Unix(0, 0)
	l.now = func() time.Time { return base }
	if !l.Allow("a") {
		t.Fatal("app a first wake allowed")
	}
	if l.Allow("a") {
		t.Fatal("app a second wake refused (budget 1)")
	}
	// app b has its OWN bucket: a's exhaustion must not spill onto b (the whole
	// point of the per-app budget — one noisy tenant cannot starve another).
	if !l.Allow("b") {
		t.Fatal("app b first wake must be allowed (per-app isolation)")
	}
}

func TestWakeLimiter_DisabledAndNilAllowEverything(t *testing.T) {
	if NewWakeLimiter(0, time.Minute) != nil {
		t.Fatal("budget 0 => disabled => nil limiter (no regression for un-budgeted lanes)")
	}
	var l *WakeLimiter // nil
	for i := 0; i < 100; i++ {
		if !l.Allow("x") {
			t.Fatal("a nil limiter must allow every wake (budget off)")
		}
	}
}

func TestNewWakeLimiterFromEnv(t *testing.T) {
	if NewWakeLimiterFromEnv(Env{}) != nil {
		t.Fatal("no GW_WAKE_BUDGET => nil (disabled)")
	}
	l := NewWakeLimiterFromEnv(Env{"GW_WAKE_BUDGET": "2", "GW_WAKE_WINDOW_MS": "1000"})
	if l == nil {
		t.Fatal("GW_WAKE_BUDGET>0 => a limiter")
	}
	base := time.Unix(0, 0)
	l.now = func() time.Time { return base }
	if !l.Allow("a") || !l.Allow("a") {
		t.Fatal("2 wakes within budget 2 should pass")
	}
	if l.Allow("a") {
		t.Fatal("3rd wake must be refused")
	}
}

// The guard wired into ConnectWithWake must REFUSE the wake (return the sentinel)
// WITHOUT ever calling driver.Wake — so an over-budget burst cannot scale compute.
func TestConnectWithWake_GuardRefusesWithoutScaling(t *testing.T) {
	d := &budgetFakeDriver{}
	opts := Opts{
		ConnectTimeoutMs: 50,
		WakeTimeoutMs:    200,
		RetryMs:          10,
		WakeGuard:        func(string) error { return ErrWakeBudgetExceeded },
	}
	_, woke, _, err := ConnectWithWake(context.Background(), d, d.Resolve(""), opts, nil)
	if !errors.Is(err, ErrWakeBudgetExceeded) {
		t.Fatalf("expected ErrWakeBudgetExceeded, got %v", err)
	}
	if woke {
		t.Fatal("a budget-refused connect must not report a wake")
	}
	if d.wakes != 0 {
		t.Fatalf("guard refusal must NOT call driver.Wake, saw %d wake(s)", d.wakes)
	}
}

// warmFakeDriver resolves to a live (warm) listener whose address is fixed at
// construction. Its Wake must NEVER be called: a warm compute answers TryConnect,
// so ConnectWithWake returns at that first connect — before the wake branch, and
// therefore before the WakeGuard is ever consulted.
type warmFakeDriver struct {
	target Target
	wakes  int
}

func (*warmFakeDriver) Mode() string                         { return "fake-warm" }
func (d *warmFakeDriver) Resolve(string) Target              { return d.target }
func (d *warmFakeDriver) Wake(context.Context, Target) error { d.wakes++; return nil }
func (*warmFakeDriver) Sleep(context.Context, Target) error  { return nil }
func (*warmFakeDriver) CanSleep() bool                       { return true }

// A WARM app (compute already answering TryConnect) must connect even when its wake
// budget is fully exhausted. The budget gates only a cold 0->1 WAKE, never an
// existing-warm connect (issue #166, refs #116/ADR-0008). This is structurally
// guaranteed: ConnectWithWake tries TryConnect BEFORE consulting the WakeGuard, so a
// live target returns at that first connect and the always-refusing guard below is
// never reached. Regression lock — if the guard were ever hoisted above the connect,
// a warm app would be wrongly refused mid-traffic and this test would fail (err set,
// nil conn). Verified red by reordering the guard above TryConnect in wake.go.
func TestConnectWithWake_WarmAppNeverGatedAtZeroTokens(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	// Accept-and-close: TryConnect only needs the TCP handshake to succeed for the
	// compute to count as "warm" (a live compute answers; the gateway then pipes).
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			_ = c.Close()
		}
	}()

	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portStr)
	d := &warmFakeDriver{target: Target{Host: host, Port: port, Key: "warm-app"}}

	// A guard that ALWAYS refuses models a fully-exhausted bucket (0 tokens left).
	opts := Opts{
		ConnectTimeoutMs: 200,
		WakeTimeoutMs:    500,
		RetryMs:          10,
		WakeGuard:        func(string) error { return ErrWakeBudgetExceeded },
	}
	conn, woke, _, err := ConnectWithWake(context.Background(), d, d.Resolve(""), opts, nil)
	if err != nil {
		t.Fatalf("warm app must connect even with an exhausted wake budget, got err=%v", err)
	}
	if conn == nil {
		t.Fatal("warm app connect returned a nil conn")
	}
	_ = conn.Close()
	if woke {
		t.Fatal("a warm connect must not report a wake (no 0->1 scale happened)")
	}
	if d.wakes != 0 {
		t.Fatalf("warm connect must never call driver.Wake, saw %d", d.wakes)
	}
}

// A nil guard (budget off) leaves the wake path completely unchanged: the wake is
// issued exactly once. Regression guard for the un-budgeted lanes.
func TestConnectWithWake_NilGuardWakesOnce(t *testing.T) {
	d := &budgetFakeDriver{}
	opts := Opts{ConnectTimeoutMs: 20, WakeTimeoutMs: 60, RetryMs: 10} // no WakeGuard
	_, _, _, _ = ConnectWithWake(context.Background(), d, d.Resolve(""), opts, nil)
	if d.wakes != 1 {
		t.Fatalf("nil guard: wake should be issued exactly once, saw %d", d.wakes)
	}
}
