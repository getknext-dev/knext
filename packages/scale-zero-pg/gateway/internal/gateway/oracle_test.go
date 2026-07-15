package gateway

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// oracleDriver models the apps-gateway (template) front door for the
// existence-oracle test (issue #92). Wake either fails with a leaky k8s error
// (the app's Deployment does not exist) or succeeds against a fake backend that
// rejects the password exactly as PostgreSQL does (the app exists, wrong cred).
// It reports MaskConnectErrors()==true, so the gateway MUST collapse the
// nonexistent-app failure to the same generic 28P01 the backend emits for a
// wrong password — no tenant-existence oracle, no internal k8s object names.
type oracleDriver struct {
	target  wake.Target
	wakeErr error
}

func (d *oracleDriver) Mode() string                             { return "template" }
func (d *oracleDriver) Resolve(string) wake.Target               { return d.target }
func (d *oracleDriver) Wake(context.Context, wake.Target) error  { return d.wakeErr }
func (d *oracleDriver) Sleep(context.Context, wake.Target) error { return nil }
func (d *oracleDriver) CanSleep() bool                           { return true }

// Authorize makes this a systemAuthorizer — the signal the gateway uses to mark
// a tenant-facing front door whose connect failures must be masked. The pair is
// pre-authorized (well-formed), so the request proceeds to the wake path.
func (d *oracleDriver) Authorize(user, database string) error { return nil }

// gatewayWithDriver builds a Gateway then swaps in a controllable driver.
func gatewayWithDriver(t *testing.T, d wake.Driver) *Gateway {
	t.Helper()
	gw, err := New(wake.Env{
		"GW_COMPUTE_MODE":       "static",
		"GW_TARGET":             "127.0.0.1:1",
		"GW_WAKE_TIMEOUT_MS":    "300",
		"GW_CONNECT_TIMEOUT_MS": "50",
		"GW_RETRY_MS":           "50",
	}, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	gw.driver = d
	return gw
}

// clientResponse dials the gateway, sends a StartupMessage, and returns the raw
// first reply bytes exactly as the client would see them.
func clientResponse(t *testing.T, gw *Gateway, user, db string) []byte {
	t.Helper()
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
	_, _ = c.Write(proto.BuildStartup(map[string]string{"user": user, "database": db}))
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 512)
	n, _ := c.Read(buf)
	return append([]byte{}, buf[:n]...)
}

// wrongPasswordBackend is a minimal Postgres that, on any startup, replies with
// the exact 28P01 message a real PostgreSQL emits for a bad password.
func wrongPasswordBackend(t *testing.T, msg string) wake.Target {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				b := make([]byte, 4096)
				_, _ = c.Read(b) // consume the replayed startup
				_, _ = c.Write(proto.BuildErrorResponse("28P01", msg))
			}(conn)
		}
	}()
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portStr)
	return wake.Target{Host: host, Port: port, Key: "x"}
}

// TestAppsGatewayNoExistenceOracle asserts the client-visible response for a
// nonexistent app (wake fails with a leaky k8s error) is BYTE-IDENTICAL to the
// response for an existing app with a wrong password (backend rejects it), and
// leaks no internal object names. Issue #92.
func TestAppsGatewayNoExistenceOracle(t *testing.T) {
	const user, db = "app_x", "x"
	// The exact message PostgreSQL emits for a bad password (SQLSTATE 28P01).
	pgMsg := fmt.Sprintf("password authentication failed for user %q", user)

	// Case A: nonexistent app — Wake fails with the leaky k8s object name.
	absent := &oracleDriver{
		target:  wake.Target{Host: "127.0.0.1", Port: 1, Key: db}, // unreachable
		wakeErr: errors.New(`deployments.apps "compute-x" not found`),
	}
	respAbsent := clientResponse(t, gatewayWithDriver(t, absent), user, db)

	// Case B: existing app, wrong password — backend up, rejects the password.
	wrongPw := &oracleDriver{
		target:  wrongPasswordBackend(t, pgMsg),
		wakeErr: nil,
	}
	respWrongPw := clientResponse(t, gatewayWithDriver(t, wrongPw), user, db)

	if !bytes.Equal(respAbsent, respWrongPw) {
		t.Fatalf("existence oracle: absent=%q wrongpw=%q must be byte-identical", respAbsent, respWrongPw)
	}
	for _, leak := range []string{"compute-", "deployments", "not found", "57P03", "unavailable"} {
		if bytes.Contains(respAbsent, []byte(leak)) {
			t.Fatalf("client response leaked %q: %q", leak, respAbsent)
		}
	}
	if code := proto.ErrorCode(respAbsent); code != "28P01" {
		t.Fatalf("masked response SQLSTATE = %q, want 28P01", code)
	}
}

// TestNonMaskingDriverKeepsDiagnostic asserts the single-DB pggw (no masker)
// still returns its honest 57P03 diagnostic — masking is scoped to the tenant
// front door and must not regress the primary gateway's operability.
func TestNonMaskingDriverKeepsDiagnostic(t *testing.T) {
	gw, err := New(wake.Env{
		"GW_COMPUTE_MODE":       "exec",
		"GW_TARGET":             "127.0.0.1:1",
		"GW_WAKE_CMD":           "false", // wake fails
		"GW_WAKE_TIMEOUT_MS":    "300",
		"GW_CONNECT_TIMEOUT_MS": "50",
		"GW_RETRY_MS":           "50",
	}, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	resp := clientResponse(t, gw, "app", "testdb")
	if code := proto.ErrorCode(resp); code != "57P03" {
		t.Fatalf("single-DB gateway SQLSTATE = %q, want 57P03 (honest diagnostic)", code)
	}
}
