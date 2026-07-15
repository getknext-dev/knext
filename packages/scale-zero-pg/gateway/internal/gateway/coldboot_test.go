package gateway

import (
	"context"
	"net"
	"strconv"
	"sync"
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
	base, err := New(wake.Env{"GW_COMPUTE_MODE": "static", "GW_TARGET": "127.0.0.1:1"}, func(string) {})
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
