package gateway

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// Issue #174 — DETERMINISTIC cold-boot readiness gate. #132 ships a BLIND,
// time-based settle (hold GW_ROLE_APPLY_SETTLE_MS on a cold wake so compute_ctl
// applies the per-app role first). This is a heuristic buffer: if the apply
// window ever exceeds the settle (heavy load) the transient 28P01 can recur. The
// deterministic fix polls compute_ctl's /status endpoint (port 3080) until it
// reports the compute is "running" (spec/role apply DONE) instead of sleeping a
// fixed delay. It is OPT-IN (GW_STATUS_PORT>0 + a JWT): when unconfigured — the
// current deployment, where 3080 is neither Service-exposed nor NetworkPolicy-
// allowed — the gateway falls back to the bounded settle, byte-for-byte unchanged.
// Either way total added latency is clamped to GW_WAKE_TIMEOUT_MS.

// statusServer spins up a fake compute_ctl /status endpoint. `bodyFor` returns the
// (httpStatus, jsonBody) for the Nth poll (0-indexed) so a test can model "init,
// init, running". It also records the bearer token of the last request seen.
type statusServer struct {
	srv       *httptest.Server
	polls     int32
	lastToken string
}

func newStatusServer(t *testing.T, bodyFor func(n int) (int, string)) *statusServer {
	t.Helper()
	s := &statusServer{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(atomic.AddInt32(&s.polls, 1)) - 1
		s.lastToken = r.Header.Get("Authorization")
		code, body := bodyFor(n)
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(s.srv.Close)
	return s
}

// port returns the httptest server's port, which the probe combines with the
// target host to build the /status URL.
func (s *statusServer) port(t *testing.T) int {
	t.Helper()
	_, portStr, err := net.SplitHostPort(s.srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	p, _ := strconv.Atoi(portStr)
	return p
}

// running always reports ready; initThenRunning reports init for the first
// `initPolls` calls then running.
func running(int) (int, string)    { return 200, `{"status":"running"}` }
func alwaysInit(int) (int, string) { return 200, `{"status":"init"}` }
func initThenRunning(initPolls int) func(int) (int, string) {
	return func(n int) (int, string) {
		if n < initPolls {
			return 200, `{"status":"init"}`
		}
		return 200, `{"status":"running"}`
	}
}

// TestStatusProbe_AwaitReady_ProceedsWhenReady: the probe polls and returns true
// the moment /status reports "running" — deterministic, and far faster than a
// large blind settle would take.
func TestStatusProbe_AwaitReady_ProceedsWhenReady(t *testing.T) {
	s := newStatusServer(t, initThenRunning(2))
	p := newStatusProbe(s.port(t), "jwt-abc", "running", 10, 500)

	t0 := time.Now()
	ok := p.awaitReady("127.0.0.1", t0.Add(3*time.Second), func(string) {}, "x")
	if !ok {
		t.Fatal("awaitReady returned false, want true once /status reports running")
	}
	if got := atomic.LoadInt32(&s.polls); got < 3 {
		t.Fatalf("polled %d times, want >= 3 (init,init,running)", got)
	}
	if s.lastToken != "Bearer jwt-abc" {
		t.Fatalf("Authorization header = %q, want %q", s.lastToken, "Bearer jwt-abc")
	}
	if d := time.Since(t0); d > 2*time.Second {
		t.Fatalf("awaitReady took %v, expected to return promptly once ready", d)
	}
}

// TestStatusProbe_AwaitReady_RespectsDeadline: a compute stuck in "init" must not
// wedge the wake — awaitReady returns false at the deadline, not beyond it.
func TestStatusProbe_AwaitReady_RespectsDeadline(t *testing.T) {
	s := newStatusServer(t, alwaysInit)
	p := newStatusProbe(s.port(t), "jwt", "running", 10, 200)

	t0 := time.Now()
	deadline := t0.Add(200 * time.Millisecond)
	ok := p.awaitReady("127.0.0.1", deadline, func(string) {}, "x")
	if ok {
		t.Fatal("awaitReady returned true for an always-init compute, want false at deadline")
	}
	if d := time.Since(t0); d > 500*time.Millisecond {
		t.Fatalf("awaitReady overran the deadline by too much: %v (deadline was 200ms)", d)
	}
}

// TestStatusProbe_AwaitReady_TokenRejectedGivesUpFast: a 401 means the JWT is
// wrong — no amount of polling fixes that, so the probe gives up promptly (and the
// caller falls back to the bounded settle) instead of burning the wake budget.
func TestStatusProbe_AwaitReady_TokenRejectedGivesUpFast(t *testing.T) {
	s := newStatusServer(t, func(int) (int, string) { return 401, `{"error":"invalid authorization token"}` })
	p := newStatusProbe(s.port(t), "bad", "running", 10, 200)

	t0 := time.Now()
	ok := p.awaitReady("127.0.0.1", t0.Add(3*time.Second), func(string) {}, "x")
	if ok {
		t.Fatal("awaitReady returned true on a 401, want false")
	}
	if d := time.Since(t0); d > 500*time.Millisecond {
		t.Fatalf("awaitReady took %v on a 401 — must give up fast, not poll to the deadline", d)
	}
}

// TestStatusProbe_AwaitReady_UnreachableBoundedByDeadline: if /status is
// unreachable (port not exposed) the probe keeps trying — transient during boot —
// but stays bounded by the deadline and then falls back.
func TestStatusProbe_AwaitReady_UnreachableBoundedByDeadline(t *testing.T) {
	// Reserve then release a port so nothing is listening.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, portStr, _ := net.SplitHostPort(ln.Addr().String())
	_ = ln.Close()
	port, _ := strconv.Atoi(portStr)
	p := newStatusProbe(port, "jwt", "running", 10, 100)

	t0 := time.Now()
	ok := p.awaitReady("127.0.0.1", t0.Add(200*time.Millisecond), func(string) {}, "x")
	if ok {
		t.Fatal("awaitReady returned true against a closed port, want false")
	}
	if d := time.Since(t0); d > 700*time.Millisecond {
		t.Fatalf("awaitReady against a closed port took %v — must stay bounded by the deadline", d)
	}
}

// TestGateColdWake_DeterministicSkipsBlindSettle: with the probe configured and a
// ready compute, the cold-wake gate returns the moment /status says running — it
// does NOT sleep the (deliberately huge) blind settle.
func TestGateColdWake_DeterministicSkipsBlindSettle(t *testing.T) {
	s := newStatusServer(t, running)
	gw := gatewayWithDriver(t, &oracleDriver{target: wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}})
	gw.opts.WakeTimeoutMs = 5000
	gw.roleApplySettleMs = 5000 // huge blind settle — must be skipped
	gw.statusProbe = newStatusProbe(s.port(t), "jwt", "running", 10, 500)

	t0 := time.Now()
	gw.gateColdWake(true, wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}, t0)
	if d := time.Since(t0); d > 1*time.Second {
		t.Fatalf("deterministic gate held %v, want prompt return (blind settle must be skipped when /status is ready)", d)
	}
	if atomic.LoadInt32(&s.polls) == 0 {
		t.Fatal("expected the /status probe to be polled on a cold wake")
	}
}

// TestGateColdWake_FallsBackToSettleWhenUnconfigured: with no probe (the DEFAULT /
// current deployment) the gate behaves exactly like the #132 bounded settle.
func TestGateColdWake_FallsBackToSettleWhenUnconfigured(t *testing.T) {
	const settleMs = 120
	gw := gatewayWithDriver(t, &oracleDriver{target: wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}})
	gw.opts.WakeTimeoutMs = 5000
	gw.roleApplySettleMs = settleMs
	gw.statusProbe = nil

	t0 := time.Now()
	gw.gateColdWake(true, wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}, t0)
	if d := time.Since(t0); d < settleMs*time.Millisecond {
		t.Fatalf("unconfigured gate held %v, want >= %dms (bounded settle fallback)", d, settleMs)
	}
}

// TestGateColdWake_UnreachableFallsBackToSettle: probe configured but /status
// unreachable — the gate must degrade to the bounded settle (belt-and-suspenders),
// never proceed instantly and never wedge.
func TestGateColdWake_UnreachableFallsBackToSettle(t *testing.T) {
	const settleMs = 120
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, portStr, _ := net.SplitHostPort(ln.Addr().String())
	_ = ln.Close()
	port, _ := strconv.Atoi(portStr)

	gw := gatewayWithDriver(t, &oracleDriver{target: wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}})
	gw.opts.WakeTimeoutMs = 5000
	gw.roleApplySettleMs = settleMs
	gw.statusProbe = newStatusProbe(port, "jwt", "running", 10, 60)
	gw.statusProbe.timeoutMs = 200 // GW_STATUS_TIMEOUT_MS: bail the probe fast, then settle

	t0 := time.Now()
	gw.gateColdWake(true, wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}, t0)
	// unreachable probe returns false at its (capped) deadline, then the settle runs.
	d := time.Since(t0)
	if d < settleMs*time.Millisecond {
		t.Fatalf("unreachable-probe gate held %v, want >= %dms settle fallback", d, settleMs)
	}
	if d > 1500*time.Millisecond {
		t.Fatalf("unreachable-probe gate held %v — GW_STATUS_TIMEOUT_MS must bound the probe well under the 5s wake budget", d)
	}
}

// TestStatusProbe_ProbeDeadline_CapsToTimeoutButNeverExceedsWake asserts the
// GW_STATUS_TIMEOUT_MS cap tightens the deterministic poll when smaller than the
// wake budget, and is ignored (never extends) when larger — the poll can never
// push a connection past GW_WAKE_TIMEOUT_MS.
func TestStatusProbe_ProbeDeadline_CapsToTimeoutButNeverExceedsWake(t *testing.T) {
	start := time.Now()
	wakeDL := start.Add(5 * time.Second)

	p := newStatusProbe(3080, "jwt", "running", 10, 500)
	if got := p.probeDeadline(start, wakeDL); !got.Equal(wakeDL) {
		t.Fatalf("timeoutMs=0 should use the full wake deadline")
	}

	p.timeoutMs = 2000
	if got := p.probeDeadline(start, wakeDL); got.After(start.Add(2100 * time.Millisecond)) {
		t.Fatalf("timeoutMs=2000 should cap the poll to ~2s, got deadline %v after start", got.Sub(start))
	}

	p.timeoutMs = 999999 // larger than the wake budget: must NOT extend past it
	if got := p.probeDeadline(start, wakeDL); got.After(wakeDL) {
		t.Fatalf("a timeoutMs beyond the wake budget must not extend the deadline past GW_WAKE_TIMEOUT_MS")
	}
}

// TestGateColdWake_FiresOnlyOnColdWakePerAppFrontDoor: the deterministic gate,
// like the settle, fires ONLY on woke==true of a systemAuthorizer driver. A warm
// connect and the base single-DB path are never probed and never held.
func TestGateColdWake_FiresOnlyOnColdWakePerAppFrontDoor(t *testing.T) {
	s := newStatusServer(t, alwaysInit) // never ready — would hold to deadline if wrongly fired
	// base single-DB path (no systemAuthorizer).
	base, err := New(wake.Env{"GW_COMPUTE_MODE": "static", "GW_TARGET": "127.0.0.1:1"}, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	base.opts.WakeTimeoutMs = 5000
	base.roleApplySettleMs = 500
	base.statusProbe = newStatusProbe(s.port(t), "jwt", "running", 10, 100)

	t2 := time.Now()
	base.gateColdWake(true, wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}, t2)
	if d := time.Since(t2); d > 50*time.Millisecond {
		t.Fatalf("base single-DB path held %v on cold wake, want ~0 (gate must not fire without a systemAuthorizer)", d)
	}
	if atomic.LoadInt32(&s.polls) != 0 {
		t.Fatal("base path probed /status, want no probe (no per-app role apply)")
	}

	// warm connect (woke==false) of a per-app front door.
	front := gatewayWithDriver(t, &oracleDriver{target: wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}})
	front.opts.WakeTimeoutMs = 5000
	front.roleApplySettleMs = 500
	front.statusProbe = newStatusProbe(s.port(t), "jwt", "running", 10, 100)
	t1 := time.Now()
	front.gateColdWake(false, wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}, t1)
	if d := time.Since(t1); d > 50*time.Millisecond {
		t.Fatalf("warm connect held %v, want ~0 (gate must not fire on woke==false)", d)
	}
}

// TestNewStatusProbeFromEnv: opt-in wiring — the probe is nil unless GW_STATUS_PORT
// (+ a token) is set, so the default/current deployment is unchanged.
func TestNewStatusProbeFromEnv(t *testing.T) {
	if p := newStatusProbeFromEnv(wake.Env{}); p != nil {
		t.Fatal("no GW_STATUS_PORT -> probe should be nil (opt-in, backward-compatible)")
	}
	if p := newStatusProbeFromEnv(wake.Env{"GW_STATUS_PORT": "3080"}); p != nil {
		t.Fatal("GW_STATUS_PORT without a token -> probe should be nil (a JWT is required)")
	}
	p := newStatusProbeFromEnv(wake.Env{"GW_STATUS_PORT": "3080", "GW_STATUS_TOKEN": "jwt"})
	if p == nil {
		t.Fatal("GW_STATUS_PORT + GW_STATUS_TOKEN -> probe should be non-nil")
	}
	if p.port != 3080 || p.token != "jwt" || p.ready != "running" {
		t.Fatalf("probe = %+v, want port 3080, token jwt, ready running", p)
	}
}
