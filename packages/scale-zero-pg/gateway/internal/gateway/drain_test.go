package gateway

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// newDrainGateway stands up a gateway in static mode in front of an always-on
// fakeCompute and returns the gateway plus its listen address. Static mode never
// sleeps, so no idle timers interfere with the drain assertions.
func newDrainGateway(t *testing.T) (*Gateway, string, *fakeCompute) {
	t.Helper()
	fc := &fakeCompute{port: freePort(t)}
	if err := fc.start(); err != nil {
		t.Fatalf("start fake compute: %v", err)
	}
	t.Cleanup(fc.stop)

	env := wake.Env{
		"GW_COMPUTE_TLS":        "false", // fake backends speak PLAINTEXT Postgres (F5 phase-3 backend TLS is covered in internal/wake + New's wiring test)
		"GW_COMPUTE_MODE":       "static",
		"GW_TARGET":             fmt.Sprintf("127.0.0.1:%d", fc.port),
		"GW_WAKE_TIMEOUT_MS":    "5000",
		"GW_CONNECT_TIMEOUT_MS": "500",
		"GW_RETRY_MS":           "50",
	}
	gw, err := New(env, func(string) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go gw.Serve(ln)
	return gw, ln.Addr().String(), fc
}

// establishLive opens a client, completes the handshake, and returns once the
// gateway reports the connection as active. A connection is enrolled for drain at
// handle-entry (wg.Add under g.mu, BEFORE the wake/handshake), so wg registration
// happens strictly earlier than Active(); Active()>=1 (ConnOpen, at the top of
// proxy) is therefore a sufficient — if conservative — signal that the connection
// is both wg-registered AND has advanced into piping. Tests that need the earlier
// accept->wg window itself gate on a mid-handshake backend signal instead (see
// slowAuthCompute), because Active() fires too late to exercise it.
func establishLive(t *testing.T, gw *Gateway, addr string) *pgConn {
	t.Helper()
	c := dialGateway(t, addr)
	c.c.Write(proto.BuildSSLRequest())
	c.waitFor(t, func(b []byte) bool { return len(b) >= 1 }, 5*time.Second)
	c.c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"}))
	c.waitFor(t, func(b []byte) bool { return bytes.IndexByte(b, 0x5a) >= 0 }, 5*time.Second)
	// Wait until the gateway counts it live (pipes started; wg was registered at
	// handle-entry, strictly before this).
	deadline := time.Now().Add(2 * time.Second)
	for gw.Metrics().Active() < 1 {
		if time.Now().After(deadline) {
			t.Fatalf("connection never became active")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return c
}

// slowAuthCompute is an always-on backend that accepts TCP immediately but, per
// connection, signals acceptance and then holds `delay` before sending
// AuthenticationOk+ReadyForQuery. That reproduces the cold-wake / handshake window
// the gateway sits in AFTER TryConnect succeeds but BEFORE the session is piping —
// the exact accept->wg gap the drain fix must cover.
type slowAuthCompute struct {
	ln       net.Listener
	accepted chan struct{}
	delay    time.Duration
}

func startSlowAuthCompute(t *testing.T, delay time.Duration) *slowAuthCompute {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen slow compute: %v", err)
	}
	sc := &slowAuthCompute{ln: ln, accepted: make(chan struct{}, 16), delay: delay}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				b := make([]byte, 4096)
				// Consume the replayed StartupMessage, then announce that the
				// gateway is now blocked waiting for our (delayed) AuthOk.
				_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
				_, _ = c.Read(b)
				_ = c.SetReadDeadline(time.Time{})
				select {
				case sc.accepted <- struct{}{}:
				default:
				}
				time.Sleep(sc.delay) // simulate a slow cold-boot readiness
				// AuthenticationOk + ReadyForQuery(Idle)
				_, _ = c.Write([]byte{0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49})
				for {
					n, err := c.Read(b)
					_ = n
					if err != nil {
						return
					}
				}
			}(conn)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return sc
}

// newDrainGatewayTo stands up a static-mode gateway pointed at an arbitrary
// always-on target address (used to front a slowAuthCompute).
func newDrainGatewayTo(t *testing.T, target string) (*Gateway, string) {
	t.Helper()
	env := wake.Env{
		"GW_COMPUTE_TLS":        "false", // fake backends speak PLAINTEXT Postgres (F5 phase-3 backend TLS is covered in internal/wake + New's wiring test)
		"GW_COMPUTE_MODE":       "static",
		"GW_TARGET":             target,
		"GW_WAKE_TIMEOUT_MS":    "5000",
		"GW_CONNECT_TIMEOUT_MS": "500",
		"GW_RETRY_MS":           "50",
	}
	gw, err := New(env, func(string) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go gw.Serve(ln)
	return gw, ln.Addr().String()
}

// dialMidWake opens a client, declines SSL, sends the StartupMessage, then blocks
// until the backend reports the gateway is mid-handshake (accepted, AuthOk still
// pending). At that instant the connection is past accept but not yet piping — the
// window the fix must already track for drain.
func dialMidWake(t *testing.T, sc *slowAuthCompute, addr string) *pgConn {
	t.Helper()
	c := dialGateway(t, addr)
	c.c.Write(proto.BuildSSLRequest())
	c.waitFor(t, func(b []byte) bool { return len(b) >= 1 }, 5*time.Second) // 'N'
	c.c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"}))
	select {
	case <-sc.accepted:
	case <-time.After(3 * time.Second):
		t.Fatal("gateway never reached the backend handshake")
	}
	return c
}

// AC-midwake-1: a connection accepted but still WAKING/HANDSHAKING (before it is
// piping) must be visible to Drain. The pre-fix code registered wg only AFTER the
// handshake, so Drain saw wg==0 and returned nil instantly — resetting a session
// that was still coming up. Drain must instead BLOCK until the session finishes.
func TestDrainWaitsForMidWakeConnection(t *testing.T) {
	sc := startSlowAuthCompute(t, 1500*time.Millisecond)
	gw, addr := newDrainGatewayTo(t, sc.ln.Addr().String())
	c := dialMidWake(t, sc, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- gw.Drain(ctx) }()

	// Drain MUST still be blocking while the session is mid-wake/handshake.
	select {
	case <-done:
		t.Fatal("Drain returned while a connection was mid-wake/handshake — the accept->wg window is unguarded, that session would be reset")
	case <-time.After(500 * time.Millisecond):
	}

	// Handshake completes (~1500ms), session pipes, client leaves -> Drain unblocks.
	c.waitFor(t, func(b []byte) bool { return bytes.IndexByte(b, 0x5a) >= 0 }, 5*time.Second)
	c.c.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Drain returned error after clean drain: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Drain did not complete after the mid-wake session closed")
	}
}

// AC-midwake-2: with a deadline SHORTER than the wake, Drain must force-close /
// abort the in-progress wake within bound — cancel the wake context and close the
// conns so the handshake goroutine unblocks and reaches wg.Done. The pre-fix code
// returned nil immediately (wg==0), leaving the waking session to be reset with no
// bound honored.
func TestDrainForceClosesMidWakeConnection(t *testing.T) {
	sc := startSlowAuthCompute(t, 3*time.Second)
	gw, addr := newDrainGatewayTo(t, sc.ln.Addr().String())
	_ = dialMidWake(t, sc, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- gw.Drain(ctx) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Drain returned nil while a session was mid-wake; expected it to block then force-close with a deadline error")
		}
		if el := time.Since(start); el > 2*time.Second {
			t.Fatalf("Drain took %v — the in-progress wake/handshake was not aborted on the deadline", el)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Drain hung — mid-wake force-close (cancel wake ctx + close conns) is missing")
	}
}

// build57P03 constructs a Postgres ErrorResponse ('E') carrying SQLSTATE 57P03
// ("the database system is starting up" / crash recovery), the exact FATAL the
// gateway's handshakeUntilReady loop absorbs and retries on.
func build57P03() []byte {
	body := []byte{'C'}
	body = append(body, []byte("57P03")...)
	body = append(body, 0) // terminate the 'C' field
	body = append(body, 0) // terminate the field list
	msg := []byte{'E', 0, 0, 0, 0}
	binary.BigEndian.PutUint32(msg[1:5], uint32(4+len(body)))
	return append(msg, body...)
}

// crashRecoveryCompute is an always-on backend that ACCEPTS TCP immediately and,
// on every handshake attempt, replies with a FATAL 57P03 then closes — mimicking a
// Postgres that is up enough to answer TCP but still in crash recovery. That keeps
// the gateway spinning inside handshakeUntilReady's 57P03 retry loop until the wake
// deadline, which is the loop the drain-cancellation fix must break out of.
type crashRecoveryCompute struct {
	ln       net.Listener
	accepted chan struct{}
}

func startCrashRecoveryCompute(t *testing.T) *crashRecoveryCompute {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen crash-recovery compute: %v", err)
	}
	cc := &crashRecoveryCompute{ln: ln, accepted: make(chan struct{}, 64)}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				b := make([]byte, 4096)
				_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
				_, _ = c.Read(b) // consume the replayed StartupMessage
				_ = c.SetReadDeadline(time.Time{})
				select {
				case cc.accepted <- struct{}{}:
				default:
				}
				_, _ = c.Write(build57P03()) // FATAL 57P03, then close -> gateway retries
			}(conn)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return cc
}

// AC-57P03-drain: a connection stuck in handshakeUntilReady's 57P03 crash-recovery
// retry loop must observe a drain force-close PROMPTLY. That branch closes the
// backend, checks only the WAKE deadline (not ctx), sleeps, and reconnects via
// ConnectWithWake — whose early-success path returns WITHOUT observing ctx (a
// backend in crash recovery still accepts TCP). So if the force-close lands during
// the retry sleep, without a ctx check the loop spins until GW_WAKE_TIMEOUT_MS,
// blocking Drain's post-deadline wg.Wait() long past its own deadline and the pod's
// terminationGracePeriodSeconds — the co-draining reset #1016 exists to prevent.
// Drain must instead force the loop to abort and return within a bound close to its
// deadline, and the stuck goroutine must reach cleanup (wg -> 0).
func TestDrainAbortsMidWake57P03RetryLoop(t *testing.T) {
	cc := startCrashRecoveryCompute(t)
	gw, addr := newDrainGatewayTo(t, cc.ln.Addr().String())

	// Drive a client until the gateway is looping on 57P03 (past accept -> wg
	// registered at handle-entry, deep inside handshakeUntilReady).
	c := dialGateway(t, addr)
	c.c.Write(proto.BuildSSLRequest())
	c.waitFor(t, func(b []byte) bool { return len(b) >= 1 }, 5*time.Second) // 'N'
	c.c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"}))
	select {
	case <-cc.accepted:
	case <-time.After(3 * time.Second):
		t.Fatal("gateway never reached the backend handshake")
	}

	// Deadline SHORTER than GW_WAKE_TIMEOUT_MS (5000ms) and short vs the retry
	// cadence (50ms) so the force-close reliably lands during a retry sleep.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- gw.Drain(ctx) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Drain returned nil while a session was stuck in the 57P03 retry loop; expected a deadline error")
		}
		if el := time.Since(start); el > 2*time.Second {
			t.Fatalf("Drain took %v — the 57P03 retry loop ignored ctx cancellation and spun until the wake deadline", el)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Drain hung — the 57P03 retry loop never observed the drain force-close (ctx ignored on the reconnect path)")
	}

	// Drain's deadline path returns only AFTER wg.Wait(), so a bounded return already
	// implies the stuck goroutine ran cleanup (wg -> 0). Confirm belt-and-suspenders:
	// a second Drain finds nothing live and returns immediately.
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := gw.Drain(ctx2); err != nil {
		t.Fatalf("second Drain returned error — the 57P03 goroutine was not cleaned up (wg != 0): %v", err)
	}
}

// A connection that arrives AFTER the gateway is closed (draining) is refused new
// work: no wake is started and the client conn is closed. Guards the closed-check
// under g.mu in registerConn (also the Add-from-zero race fix).
func TestClosedGatewayRejectsNewConnection(t *testing.T) {
	sc := startSlowAuthCompute(t, 200*time.Millisecond)
	gw, addr := newDrainGatewayTo(t, sc.ln.Addr().String())

	// Drain a gateway with nothing in flight -> returns immediately, marks closed.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := gw.Drain(ctx); err != nil {
		t.Fatalf("Drain (empty) returned error: %v", err)
	}

	// A new connection now must be refused: the gateway closes it without waking.
	c := dialGateway(t, addr)
	c.c.Write(proto.BuildSSLRequest())
	c.c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"}))
	// No backend handshake must ever start for a rejected connection.
	select {
	case <-sc.accepted:
		t.Fatal("closed gateway started a backend wake for a new connection — reject-under-lock is missing")
	case <-time.After(600 * time.Millisecond):
	}
}

// AC1: Drain blocks until an in-flight proxied connection closes — it must not
// return instantly (which is what the old non-draining Close() did).
func TestDrainWaitsForInflightConnection(t *testing.T) {
	gw, addr, _ := newDrainGateway(t)
	c := establishLive(t, gw, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- gw.Drain(ctx) }()

	// Drain must still be blocking while the connection is live.
	select {
	case <-done:
		t.Fatal("Drain returned while an in-flight connection was still open — it drained nothing")
	case <-time.After(300 * time.Millisecond):
	}

	// Client goes away -> the pipe cleanup fires -> Drain unblocks.
	c.c.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Drain returned error after clean drain: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Drain did not complete after the in-flight connection closed")
	}
}

// AC2: Drain is bounded — a connection that never closes is force-closed after
// the context deadline, and Drain returns (does not hang forever).
func TestDrainForceClosesAfterDeadline(t *testing.T) {
	gw, addr, _ := newDrainGateway(t)
	_ = establishLive(t, gw, addr) // never closed by the test

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- gw.Drain(ctx) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Drain returned nil for a stuck connection; expected a deadline error")
		}
		if elapsed := time.Since(start); elapsed > 3*time.Second {
			t.Fatalf("Drain took %v — deadline not honored", elapsed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Drain hung past the deadline — force-close of the stuck connection is missing")
	}
}

// Drain with nothing in flight returns promptly and cleanly.
func TestDrainNoInflightReturnsImmediately(t *testing.T) {
	gw, _, _ := newDrainGateway(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if err := gw.Drain(ctx); err != nil {
		t.Fatalf("Drain with no in-flight conns returned error: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Drain with no in-flight conns took %v", elapsed)
	}
}
