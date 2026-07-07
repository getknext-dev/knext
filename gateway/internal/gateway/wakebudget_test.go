package gateway

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/metrics"
	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// countingScaler records every Scale(replicas>0) as a wake. It implements the
// wake.Scaler interface so a template-mode gateway drives it instead of the real
// k8s API — letting us assert exactly how many 0->1 scales a connection storm
// produces under a wake budget.
type countingScaler struct {
	mu    sync.Mutex
	wakes int
}

func (s *countingScaler) Scale(_ context.Context, _, _ string, replicas int32) error {
	if replicas > 0 {
		s.mu.Lock()
		s.wakes++
		s.mu.Unlock()
	}
	return nil
}
func (s *countingScaler) count() int { s.mu.Lock(); defer s.mu.Unlock(); return s.wakes }

// A burst of startup packets for ONE app must not force unbounded 0->1 churn: the
// gateway wakes up to GW_WAKE_BUDGET times, then REFUSES the rest with a clean
// 53400 and counts them in the wake-budget metric — the compute is never scaled
// past the budget. This is the #116 control (a foreign/unauth pod cannot exceed the
// per-app wake budget). The target resolves to a dead address so every attempt hits
// the wake branch (compute "asleep") deterministically.
func TestWakeBudgetCapsChurnAndRefusesCleanly(t *testing.T) {
	scaler := &countingScaler{}
	drv, err := wake.MakeDriverWithScaler(wake.Env{
		"GW_COMPUTE_MODE":            "template",
		"GW_K8S_DEPLOYMENT_TEMPLATE": "compute-{system}",
		// Point every app at a black-hole target so TryConnect always fails fast and
		// the wake path (and thus the budget) is always exercised. 203.0.113.0/24 is
		// TEST-NET-3 (RFC 5737) — guaranteed unroutable.
		"GW_TARGET_TEMPLATE": "203.0.113.1:55433",
		"GW_APP_ROLE_PREFIX": "app_",
		"GW_WAKE_BUDGET":     "3",
		"GW_WAKE_WINDOW_MS":  "600000", // 10min: no refill during the test
	}, scaler)
	if err != nil {
		t.Fatal(err)
	}
	gw := &Gateway{
		driver:  drv,
		metrics: metrics.NewMetrics(),
		opts:    wake.Opts{ConnectTimeoutMs: 50, WakeTimeoutMs: 120, RetryMs: 20},
		active:  map[string]*activeEntry{},
		log:     func(string) {},
	}
	// Wire the budget exactly as New() does.
	lim := wake.NewWakeLimiterFromEnv(wake.Env{"GW_WAKE_BUDGET": "3", "GW_WAKE_WINDOW_MS": "600000"})
	gw.wakeLimiter = lim
	gw.opts.WakeGuard = func(key string) error {
		if lim.Allow(key) {
			return nil
		}
		return wake.ErrWakeBudgetExceeded
	}
	gw.floorMs = 0

	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	go gw.Serve(front)

	// Fire a burst of 8 startups for the SAME app; each connection sits in the wake
	// retry loop until its wake deadline or a budget refusal, so drive them serially
	// to read the refusal codes deterministically.
	refusals := 0
	for i := 0; i < 8; i++ {
		c, derr := net.Dial("tcp", front.Addr().String())
		if derr != nil {
			t.Fatal(derr)
		}
		_, _ = c.Write(proto.BuildStartup(map[string]string{"user": "app_appx", "database": "appx"}))
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		buf := make([]byte, 256)
		n, _ := c.Read(buf)
		if n > 0 && buf[0] == 'E' && proto.ErrorCode(buf[:n]) == wakeBudgetSQLSTATE {
			refusals++
		}
		_ = c.Close()
	}

	// Exactly 3 wakes (the budget); the remaining 5 refused with a clean 53400.
	if got := scaler.count(); got != 3 {
		t.Fatalf("wake budget 3: expected exactly 3 scale-ups (0->1), got %d — churn not capped", got)
	}
	if refusals != 5 {
		t.Fatalf("expected 5 clean 53400 wake-budget refusals, got %d", refusals)
	}
	if got := gw.Metrics().WakeBudgetExceededCount(); got != 5 {
		t.Fatalf("wake_budget_exceeded_total = %d, want 5", got)
	}
}

// A SECOND app is unaffected by the first app's exhausted budget: per-app isolation
// end-to-end (one hostile tenant cannot starve another's wake path).
func TestWakeBudgetPerAppIsolationEndToEnd(t *testing.T) {
	scaler := &countingScaler{}
	drv, err := wake.MakeDriverWithScaler(wake.Env{
		"GW_COMPUTE_MODE":            "template",
		"GW_K8S_DEPLOYMENT_TEMPLATE": "compute-{system}",
		"GW_TARGET_TEMPLATE":         "203.0.113.1:55433",
		"GW_APP_ROLE_PREFIX":         "app_",
	}, scaler)
	if err != nil {
		t.Fatal(err)
	}
	gw := &Gateway{
		driver:  drv,
		metrics: metrics.NewMetrics(),
		opts:    wake.Opts{ConnectTimeoutMs: 50, WakeTimeoutMs: 120, RetryMs: 20},
		active:  map[string]*activeEntry{},
		log:     func(string) {},
	}
	lim := wake.NewWakeLimiter(1, 10*time.Minute)
	gw.wakeLimiter = lim
	gw.opts.WakeGuard = func(key string) error {
		if lim.Allow(key) {
			return nil
		}
		return wake.ErrWakeBudgetExceeded
	}

	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	go gw.Serve(front)

	dial := func(user, db string) byte {
		c, _ := net.Dial("tcp", front.Addr().String())
		defer c.Close()
		_, _ = c.Write(proto.BuildStartup(map[string]string{"user": user, "database": db}))
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		buf := make([]byte, 128)
		n, _ := c.Read(buf)
		if n > 0 && buf[0] == 'E' {
			if proto.ErrorCode(buf[:n]) == wakeBudgetSQLSTATE {
				return 'B' // budget-refused
			}
		}
		return '?'
	}

	// app A: first wake spends its only token; second is budget-refused.
	_ = dial("app_appa", "appa")
	if dial("app_appa", "appa") != 'B' {
		t.Fatal("appa 2nd wake should be budget-refused")
	}
	// app B: its independent bucket is full — its first wake must NOT be refused.
	if dial("app_appb", "appb") == 'B' {
		t.Fatal("appb wake refused — per-app isolation broken (appa's exhaustion leaked to appb)")
	}
}
