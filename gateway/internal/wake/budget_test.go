package wake

import (
	"context"
	"errors"
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
