package gateway

import (
	"context"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// Issue #132 — cold-boot role-apply race. compute_ctl opens the Postgres socket
// a beat BEFORE it (re)applies the per-app spec roles/passwords on a cold wake, so
// the very first connection during a 0->1 wake can transiently see 28P01 (it
// self-heals on the next request). The gateway closes the race by holding the
// client for a bounded role-apply settle window on a GENUINE cold wake of a
// per-app front door, BEFORE the single auth attempt. It is NOT an auth retry:
// a wrong password still fails on that one attempt (no masking), and steady-state
// (warm) connects are never delayed.

// reserveAddr grabs a free 127.0.0.1 port and releases it, so a coldWakeDriver can
// (re)bind it later from Wake — modelling a compute that is refused-then-listening.
func reserveAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

// coldWakeDriver models a per-app compute that is ASLEEP (TCP refused) until Wake,
// which starts a backend serving `handler`. It implements Authorize, so it is a
// systemAuthorizer (the per-app front door) — the path the settle gate applies to.
type coldWakeDriver struct {
	addr    string
	handler func(net.Conn)

	mu   sync.Mutex
	ln   net.Listener
	woke bool
}

func (d *coldWakeDriver) Mode() string { return "template" }
func (d *coldWakeDriver) Resolve(string) wake.Target {
	host, portStr, _ := net.SplitHostPort(d.addr)
	port, _ := strconv.Atoi(portStr)
	return wake.Target{Host: host, Port: port, Key: "x"}
}
func (d *coldWakeDriver) Authorize(_, _ string) error              { return nil } // systemAuthorizer
func (d *coldWakeDriver) Sleep(context.Context, wake.Target) error { return nil }
func (d *coldWakeDriver) CanSleep() bool                           { return true }
func (d *coldWakeDriver) Wake(context.Context, wake.Target) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", d.addr)
	if err != nil {
		return err
	}
	d.ln = ln
	d.woke = true
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go d.handler(c)
		}
	}()
	return nil
}
func (d *coldWakeDriver) didWake() bool { d.mu.Lock(); defer d.mu.Unlock(); return d.woke }

// authOkBackend replies AuthenticationOk + ReadyForQuery — a healthy handshake.
func authOkBackend(c net.Conn) {
	defer c.Close()
	b := make([]byte, 4096)
	_, _ = c.Read(b) // consume the replayed startup
	_, _ = c.Write([]byte{0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49})
	time.Sleep(100 * time.Millisecond)
}

// writeAuthOk sends AuthenticationOk + ReadyForQuery on an accepted backend conn.
func writeAuthOk(c net.Conn) {
	_, _ = c.Write([]byte{0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49})
	time.Sleep(50 * time.Millisecond)
}

// countingHandler returns a per-connection backend handler that records how many
// startup packets it has served (attempts) and invokes reply(n, c) with the
// 0-indexed attempt number, so a test can model "28P01 on the first attempt,
// AuthenticationOk on the second" — the compute_ctl cold-boot role-apply race the
// D7b bounded retry closes. It reads (and discards) the replayed startup first.
func countingHandler(attempts *int32, reply func(n int32, c net.Conn)) func(net.Conn) {
	return func(c net.Conn) {
		defer c.Close()
		b := make([]byte, 4096)
		_, _ = c.Read(b) // consume the replayed startup
		n := atomic.AddInt32(attempts, 1) - 1
		reply(n, c)
	}
}

// TestColdWake28P01Retry_SucceedsOnSecondAttempt is the D7b happy-path fix: on a
// genuine cold wake the first proxied auth can transiently 28P01 (compute_ctl
// applies the per-app role a beat after the socket opens). With NO blind pre-sleep
// (roleApplySettleMs=0), a single bounded retry after roleApplyRetryMs lets the role
// land and the client connects — it sees AuthenticationOk, never the transient
// 28P01. Exactly two backend attempts prove the retry fired once and only once.
func TestColdWake28P01Retry_SucceedsOnSecondAttempt(t *testing.T) {
	var attempts int32
	d := &coldWakeDriver{addr: reserveAddr(t), handler: countingHandler(&attempts, func(n int32, c net.Conn) {
		if n == 0 {
			_, _ = c.Write(proto.BuildErrorResponse("28P01", `password authentication failed for user "app_x"`))
			return
		}
		writeAuthOk(c)
	})}
	gw := gatewayWithDriver(t, d)
	gw.roleApplySettleMs = 0 // NO blind pre-sleep — the default hot path
	gw.roleApplyRetryMs = 80 // short bounded wait before the single retry
	gw.opts.WakeTimeoutMs = 5000

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go gw.Serve(ln)

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write(proto.BuildStartup(map[string]string{"user": "app_x", "database": "x"}))
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 64)
	n, _ := c.Read(buf)

	if !d.didWake() {
		t.Fatal("expected a genuine cold wake (driver.Wake called)")
	}
	if n == 0 || buf[0] != 0x52 { // AuthenticationOk
		t.Fatalf("cold-wake transient 28P01: got %q (code %q), want AuthenticationOk (0x52) after one bounded retry", buf[:n], proto.ErrorCode(buf[:n]))
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("backend saw %d startup attempts, want exactly 2 (one transient 28P01 + one retry)", got)
	}
}

// TestColdWake28P01Retry_WrongPasswordFastFailsBounded is the NON-NEGOTIABLE safety
// property (D7b property b): a genuinely WRONG password 28P01s on BOTH attempts, so
// the client must still get 28P01 — the retry must be a SINGLE bounded attempt, not
// a loop that holds the connection waiting for a role to appear. Exactly two backend
// attempts (never more) prove the retry is bounded to one, and the whole exchange
// fast-fails well inside the generous 5s wake budget.
func TestColdWake28P01Retry_WrongPasswordFastFailsBounded(t *testing.T) {
	var attempts int32
	d := &coldWakeDriver{addr: reserveAddr(t), handler: countingHandler(&attempts, func(_ int32, c net.Conn) {
		_, _ = c.Write(proto.BuildErrorResponse("28P01", `password authentication failed for user "app_x"`))
	})}
	gw := gatewayWithDriver(t, d)
	gw.roleApplySettleMs = 0
	gw.roleApplyRetryMs = 80
	gw.opts.WakeTimeoutMs = 5000

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go gw.Serve(ln)

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t0 := time.Now()
	_, _ = c.Write(proto.BuildStartup(map[string]string{"user": "app_x", "database": "x"}))
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 512)
	n, _ := c.Read(buf)
	elapsed := time.Since(t0)

	if !d.didWake() {
		t.Fatal("expected a genuine cold wake (driver.Wake called)")
	}
	if code := proto.ErrorCode(buf[:n]); code != "28P01" {
		t.Fatalf("cold-wake wrong password: SQLSTATE %q, want 28P01 (must not be masked)", code)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("backend saw %d startup attempts, want exactly 2 (a wrong password gets ONE bounded retry, not a loop)", got)
	}
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("wrong password took %v — looks like a retry loop; it must fast-fail after one bounded retry", elapsed)
	}
}

// TestColdWake28P01Retry_HappyPathPaysNoRetryWait proves property a: when the first
// auth SUCCEEDS on a cold wake (role already applied), the client is NOT held for
// the retry wait at all — the retry cost is paid ONLY when a 28P01 is actually seen.
// A deliberately huge roleApplyRetryMs would dominate the deadline if it were paid
// blindly; the reply must arrive well before it, and the backend sees one attempt.
func TestColdWake28P01Retry_HappyPathPaysNoRetryWait(t *testing.T) {
	var attempts int32
	d := &coldWakeDriver{addr: reserveAddr(t), handler: countingHandler(&attempts, func(_ int32, c net.Conn) {
		writeAuthOk(c)
	})}
	gw := gatewayWithDriver(t, d)
	gw.roleApplySettleMs = 0   // no blind pre-sleep
	gw.roleApplyRetryMs = 5000 // huge — must NOT be paid on the happy path
	gw.opts.WakeTimeoutMs = 8000

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go gw.Serve(ln)

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t0 := time.Now()
	_, _ = c.Write(proto.BuildStartup(map[string]string{"user": "app_x", "database": "x"}))
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 64)
	n, _ := c.Read(buf)
	elapsed := time.Since(t0)

	if n == 0 || buf[0] != 0x52 {
		t.Fatalf("cold-wake valid creds: got %q, want AuthenticationOk (0x52)", buf[:n])
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("backend saw %d startup attempts, want exactly 1 (no retry when the first auth succeeds)", got)
	}
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("first reply arrived in %v — the retry wait must NOT be paid on the happy path", elapsed)
	}
}

// TestSettleColdWake_FiresOnlyOnColdWakePerAppFrontDoor asserts the discriminator:
// the settle gate holds ONLY on a genuine cold wake (woke==true) of a per-app front
// door (a systemAuthorizer driver). A warm connect (woke==false) and the base
// single-DB path (no authorizer) are never delayed.
func TestSettleColdWake_FiresOnlyOnColdWakePerAppFrontDoor(t *testing.T) {
	const settleMs = 120

	front := gatewayWithDriver(t, &oracleDriver{target: wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}})
	front.roleApplySettleMs = settleMs

	// Cold wake of a per-app front door MUST hold ~settleMs.
	t0 := time.Now()
	front.settleColdWake(true, wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}, t0)
	if d := time.Since(t0); d < settleMs*time.Millisecond {
		t.Fatalf("cold-wake settle held %v, want >= %dms", d, settleMs)
	}

	// Warm connect (woke==false) MUST NOT hold — steady state is unchanged.
	t1 := time.Now()
	front.settleColdWake(false, wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}, t1)
	if d := time.Since(t1); d > 30*time.Millisecond {
		t.Fatalf("warm connect held %v, want ~0 (gate must not fire on woke==false)", d)
	}

	// Base single-DB path (no systemAuthorizer) MUST NOT hold, even on a cold wake:
	// cloud_admin's password is not a per-app role compute_ctl re-applies here.
	base, err := New(wake.Env{"GW_COMPUTE_TLS": "false", // fake backends speak PLAINTEXT Postgres (F5 phase-3 backend TLS is covered in internal/wake + New's wiring test)
		"GW_COMPUTE_MODE": "static", "GW_TARGET": "127.0.0.1:1"}, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	base.roleApplySettleMs = settleMs
	t2 := time.Now()
	base.settleColdWake(true, wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}, t2)
	if d := time.Since(t2); d > 30*time.Millisecond {
		t.Fatalf("base single-DB path held %v on cold wake, want ~0 (no per-app role apply)", d)
	}
}

// TestSettleColdWake_ClampedToWakeDeadline asserts the settle never pushes a
// connection past GW_WAKE_TIMEOUT_MS: with no remaining budget it is skipped.
func TestSettleColdWake_ClampedToWakeDeadline(t *testing.T) {
	gw := gatewayWithDriver(t, &oracleDriver{target: wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}})
	// gatewayWithDriver sets GW_WAKE_TIMEOUT_MS=300; a start 400ms ago leaves no budget.
	gw.roleApplySettleMs = 5000
	t0 := time.Now()
	gw.settleColdWake(true, wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}, time.Now().Add(-400*time.Millisecond))
	if d := time.Since(t0); d > 50*time.Millisecond {
		t.Fatalf("settle past the wake deadline held %v, want ~0 (must clamp)", d)
	}
}

// TestColdWakeValidCreds_HeldThenAuthOk asserts the fix: on a cold wake with VALID
// creds the client is held for the settle window and then sees a clean
// AuthenticationOk — never a transient 28P01.
func TestColdWakeValidCreds_HeldThenAuthOk(t *testing.T) {
	const settleMs = 120
	d := &coldWakeDriver{addr: reserveAddr(t), handler: authOkBackend}
	gw := gatewayWithDriver(t, d)
	gw.roleApplySettleMs = settleMs
	gw.opts.WakeTimeoutMs = 5000

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go gw.Serve(ln)

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t0 := time.Now()
	_, _ = c.Write(proto.BuildStartup(map[string]string{"user": "app_x", "database": "x"}))
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 64)
	n, _ := c.Read(buf)
	elapsed := time.Since(t0)

	if !d.didWake() {
		t.Fatal("expected a genuine cold wake (driver.Wake called)")
	}
	if n == 0 || buf[0] != 0x52 { // AuthenticationOk
		t.Fatalf("cold-wake valid creds: got %q, want AuthenticationOk (0x52)", buf[:n])
	}
	if elapsed < settleMs*time.Millisecond {
		t.Fatalf("first reply arrived in %v, before the %dms settle — settle not applied", elapsed, settleMs)
	}
}

// TestColdWakeWrongPassword_FastFailsAfterSingleSettle is the NON-NEGOTIABLE
// safety test: on a cold wake, a WRONG password must still fail promptly with a
// real 28P01 — the settle gate must NOT retry auth or mask a bad credential. The
// generous 5s wake deadline lets us prove the failure is bounded (one settle +
// one auth attempt), not a retry loop grinding to the deadline.
func TestColdWakeWrongPassword_FastFailsAfterSingleSettle(t *testing.T) {
	const settleMs = 120
	d := &coldWakeDriver{addr: reserveAddr(t), handler: func(c net.Conn) {
		defer c.Close()
		b := make([]byte, 4096)
		_, _ = c.Read(b) // consume the replayed startup
		_, _ = c.Write(proto.BuildErrorResponse("28P01", `password authentication failed for user "app_x"`))
	}}
	gw := gatewayWithDriver(t, d)
	gw.roleApplySettleMs = settleMs
	gw.opts.WakeTimeoutMs = 5000

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go gw.Serve(ln)

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t0 := time.Now()
	_, _ = c.Write(proto.BuildStartup(map[string]string{"user": "app_x", "database": "x"}))
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 512)
	n, _ := c.Read(buf)
	elapsed := time.Since(t0)
	resp := buf[:n]

	if !d.didWake() {
		t.Fatal("expected a genuine cold wake (driver.Wake called)")
	}
	if code := proto.ErrorCode(resp); code != "28P01" {
		t.Fatalf("cold-wake wrong password: SQLSTATE %q, want 28P01 (must not be masked)", code)
	}
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("wrong password took %v — looks like an auth-retry loop; it must fast-fail", elapsed)
	}
}

// TestWarmWrongPassword_FastFailsNoSettle asserts steady-state safety: a warm
// (already-awake) compute with a wrong password fails with 28P01 IMMEDIATELY — the
// settle gate never fires on woke==false, so even a large settle adds no latency.
func TestWarmWrongPassword_FastFailsNoSettle(t *testing.T) {
	const settleMs = 500
	target := wrongPasswordBackend(t, `password authentication failed for user "app_x"`)
	gw := gatewayWithDriver(t, &oracleDriver{target: target})
	gw.roleApplySettleMs = settleMs

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go gw.Serve(ln)

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t0 := time.Now()
	_, _ = c.Write(proto.BuildStartup(map[string]string{"user": "app_x", "database": "x"}))
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 512)
	n, _ := c.Read(buf)
	elapsed := time.Since(t0)

	if code := proto.ErrorCode(buf[:n]); code != "28P01" {
		t.Fatalf("warm wrong password: SQLSTATE %q, want 28P01", code)
	}
	if elapsed > 200*time.Millisecond {
		t.Fatalf("warm wrong password took %v with settle=%dms — the gate must NOT fire on a warm connect", elapsed, settleMs)
	}
}
