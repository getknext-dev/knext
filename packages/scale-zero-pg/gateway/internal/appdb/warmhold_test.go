package appdb

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// Unit tests for the warm-hold manager (#388, ADR-0030 addendum). The manager is
// the actuator behind the WarmHolds port: while a window is active it holds ONE
// real authenticated connection per app through the apps-gateway (the DSN comes
// from the operator-minted app-db-<app> Secret), so the gateway's idle sleep never
// arms and the compute stays warm for the whole window. All I/O is behind fakes
// here; the lib/pq adapter is a thin production shell over the same HoldConn.

type fakeHoldConn struct {
	pings    int
	pingErr  error
	closed   bool
	closeCnt int
}

func (c *fakeHoldConn) Ping(context.Context) error {
	c.pings++
	return c.pingErr
}
func (c *fakeHoldConn) Close() error {
	c.closed = true
	c.closeCnt++
	return nil
}

type fakeDialer struct {
	dialed []string        // DSNs passed to Dial
	conns  []*fakeHoldConn // returned in order
	err    error           // if set, Dial always fails
}

func (d *fakeDialer) Dial(_ context.Context, dsn string) (HoldConn, error) {
	d.dialed = append(d.dialed, dsn)
	if d.err != nil {
		return nil, d.err
	}
	c := &fakeHoldConn{}
	d.conns = append(d.conns, c)
	return c, nil
}

func dsnReaderOK(app string) func(context.Context, string) (string, error) {
	return func(context.Context, string) (string, error) {
		return "postgres://app_" + app + ":pw@pggw-apps.scale-zero-pg.svc:55432/" + app + "?sslmode=disable", nil
	}
}

func TestHoldManager_EnsureDialsAndHolds(t *testing.T) {
	dial := &fakeDialer{}
	m := NewHoldManager(dsnReaderOK("app1"), dial, 0)

	if err := m.EnsureHold(context.Background(), "app1"); err != nil {
		t.Fatalf("EnsureHold: %v", err)
	}
	if len(dial.dialed) != 1 {
		t.Fatalf("dialed %d times, want 1", len(dial.dialed))
	}
	wantDSN := "postgres://app_app1:pw@pggw-apps.scale-zero-pg.svc:55432/app1?sslmode=disable"
	if dial.dialed[0] != wantDSN {
		t.Fatalf("dialed DSN = %q, want %q (the Secret's DATABASE_URL, not a reconstruction)", dial.dialed[0], wantDSN)
	}
	if dial.conns[0].pings != 1 {
		t.Fatalf("fresh hold pinged %d times, want 1 (a hold is verified at establish)", dial.conns[0].pings)
	}
	if !m.Held()["app1"] {
		t.Fatal("Held() does not report app1 after EnsureHold")
	}
}

func TestHoldManager_EnsureIdempotentWhileHealthy(t *testing.T) {
	dial := &fakeDialer{}
	m := NewHoldManager(dsnReaderOK("app1"), dial, 0)

	for i := 0; i < 3; i++ {
		if err := m.EnsureHold(context.Background(), "app1"); err != nil {
			t.Fatalf("EnsureHold pass %d: %v", i, err)
		}
	}
	if len(dial.dialed) != 1 {
		t.Fatalf("dialed %d times across 3 passes, want 1 (idempotent — the hold is persistent)", len(dial.dialed))
	}
	if dial.conns[0].pings != 3 {
		t.Fatalf("hold pinged %d times across 3 passes, want 3 (each pass verifies liveness)", dial.conns[0].pings)
	}
	if dial.conns[0].closed {
		t.Fatal("healthy hold was closed between passes")
	}
}

func TestHoldManager_DeadHoldIsRedialed(t *testing.T) {
	dial := &fakeDialer{}
	m := NewHoldManager(dsnReaderOK("app1"), dial, 0)

	if err := m.EnsureHold(context.Background(), "app1"); err != nil {
		t.Fatalf("EnsureHold: %v", err)
	}
	// The compute restarts (or the gateway dropped us): the next pass's ping fails
	// and the manager must close the corpse and re-dial — a dead hold left in the
	// map would silently stop warming while reporting held.
	dial.conns[0].pingErr = errors.New("connection reset")
	if err := m.EnsureHold(context.Background(), "app1"); err != nil {
		t.Fatalf("EnsureHold after ping failure: %v", err)
	}
	if len(dial.dialed) != 2 {
		t.Fatalf("dialed %d times, want 2 (dead hold re-established)", len(dial.dialed))
	}
	if !dial.conns[0].closed {
		t.Fatal("dead hold was not closed before redial")
	}
	if !m.Held()["app1"] {
		t.Fatal("Held() lost app1 after redial")
	}
}

func TestHoldManager_DialFailureSurfacesAndDoesNotHold(t *testing.T) {
	dial := &fakeDialer{err: errors.New("connection refused")}
	m := NewHoldManager(dsnReaderOK("app1"), dial, 0)

	if err := m.EnsureHold(context.Background(), "app1"); err == nil {
		t.Fatal("EnsureHold with a failing dialer: err = nil, want the dial error")
	}
	if m.Held()["app1"] {
		t.Fatal("Held() reports app1 after a failed dial")
	}
	// A later pass retries (the compute may simply still be waking).
	dial.err = nil
	if err := m.EnsureHold(context.Background(), "app1"); err != nil {
		t.Fatalf("EnsureHold retry: %v", err)
	}
	if !m.Held()["app1"] {
		t.Fatal("Held() does not report app1 after the retry succeeded")
	}
}

func TestHoldManager_FreshDialPingFailureCloses(t *testing.T) {
	// A freshly-dialed hold is verified with a ping BEFORE it counts as held; a
	// verification failure (e.g. the role is not applied yet on a cold boot) must
	// surface as an error, close the connection, and leave nothing held — the next
	// pass retries from scratch.
	pre := &fakeHoldConn{pingErr: errors.New("28P01")}
	dial := dialerFunc(func(context.Context, string) (HoldConn, error) { return pre, nil })
	m := NewHoldManager(dsnReaderOK("app1"), dial, 0)

	if err := m.EnsureHold(context.Background(), "app1"); err == nil {
		t.Fatal("EnsureHold whose verification ping fails: err = nil, want the ping error")
	}
	if !pre.closed {
		t.Fatal("a hold that failed verification was not closed")
	}
	if m.Held()["app1"] {
		t.Fatal("Held() reports app1 after verification failure")
	}
}

type dialerFunc func(context.Context, string) (HoldConn, error)

func (f dialerFunc) Dial(ctx context.Context, dsn string) (HoldConn, error) { return f(ctx, dsn) }

func TestHoldManager_DSNReadFailureDoesNotDial(t *testing.T) {
	dial := &fakeDialer{}
	m := NewHoldManager(func(context.Context, string) (string, error) {
		return "", errors.New("secret app-db-app1 not found")
	}, dial, 0)

	if err := m.EnsureHold(context.Background(), "app1"); err == nil {
		t.Fatal("EnsureHold with a failing DSN reader: err = nil, want the read error")
	}
	if len(dial.dialed) != 0 {
		t.Fatalf("dialed %d times despite the DSN read failing, want 0", len(dial.dialed))
	}
}

func TestHoldManager_ReleaseCloses(t *testing.T) {
	dial := &fakeDialer{}
	m := NewHoldManager(dsnReaderOK("app1"), dial, 0)

	if err := m.EnsureHold(context.Background(), "app1"); err != nil {
		t.Fatalf("EnsureHold: %v", err)
	}
	m.ReleaseHold("app1")
	if !dial.conns[0].closed {
		t.Fatal("ReleaseHold did not close the held connection")
	}
	if m.Held()["app1"] {
		t.Fatal("Held() still reports app1 after ReleaseHold")
	}
	// Idempotent: releasing an unheld app is a no-op (window-end + delete paths both
	// call it; a second call must not panic or error).
	m.ReleaseHold("app1")
	if dial.conns[0].closeCnt != 1 {
		t.Fatalf("held connection closed %d times, want exactly 1", dial.conns[0].closeCnt)
	}
}

func TestHoldManager_HeldSnapshot(t *testing.T) {
	dial := &fakeDialer{}
	m := NewHoldManager(dsnReaderOK("x"), dial, 0)
	for _, app := range []string{"appa", "appb"} {
		if err := m.EnsureHold(context.Background(), app); err != nil {
			t.Fatalf("EnsureHold %s: %v", app, err)
		}
	}
	snap := m.Held()
	if len(snap) != 2 || !snap["appa"] || !snap["appb"] {
		t.Fatalf("Held() = %v, want appa+appb (the /metrics gauge reads this snapshot)", snap)
	}
	m.ReleaseHold("appa")
	snap = m.Held()
	if len(snap) != 1 || !snap["appb"] {
		t.Fatalf("Held() after release = %v, want only appb", snap)
	}
}

// ---- bounded dial/ping (review finding #1, #388) ---------------------------
//
// reconcileAll runs Reconcile for every AppDatabase SEQUENTIALLY on the
// controller's long-lived signal context (no deadline). A hung Dial/Ping for
// one app must not stall reconciliation of every other app for tens of
// seconds (the OS TCP connect timeout) — EnsureHold must bound its own I/O
// with a per-call timeout regardless of what the caller's ctx allows.

// blockingDialer's Dial (and the conns it returns) block until the ctx passed
// to them is cancelled/expires, then return ctx.Err() — exactly how a
// context-aware production dial/ping behaves when starved past a deadline.
type blockingDialer struct{}

func (blockingDialer) Dial(ctx context.Context, _ string) (HoldConn, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

type blockingHoldConn struct{}

func (blockingHoldConn) Ping(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}
func (blockingHoldConn) Close() error { return nil }

func TestHoldManager_FreshDialBoundedByTimeout(t *testing.T) {
	const timeout = 50 * time.Millisecond
	m := NewHoldManager(dsnReaderOK("app1"), blockingDialer{}, timeout)

	start := time.Now()
	// The caller's ctx has NO deadline (mirrors the controller's signal
	// context) — only HoldManager's own timeout may bound the call.
	err := m.EnsureHold(context.Background(), "app1")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("EnsureHold against a hanging dialer: err = nil, want a timeout error")
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("EnsureHold blocked %s against a hanging dialer with a %s timeout — the dial/ping is not bounded", elapsed, timeout)
	}
}

func TestHoldManager_LivenessPingBoundedByTimeout(t *testing.T) {
	// A hold that is ALREADY established (the common, steady-state resync
	// case) re-verifies liveness with a Ping every pass. If the compute is
	// black-holed mid-window that Ping must be bounded too, not just the
	// fresh-dial verification path.
	const timeout = 50 * time.Millisecond
	dial := dialerFunc(func(context.Context, string) (HoldConn, error) {
		return &hangAfterFirstPingConn{}, nil
	})
	m := NewHoldManager(dsnReaderOK("app1"), dial, timeout)
	if err := m.EnsureHold(context.Background(), "app1"); err != nil {
		t.Fatalf("initial EnsureHold: %v", err)
	}

	start := time.Now()
	// Whatever the outcome (the stale ping times out and a same-pass re-dial
	// self-heals, or the whole pass surfaces an error) — it must come back
	// within roughly one timeout window, never hang on the liveness ping.
	_ = m.EnsureHold(context.Background(), "app1")
	elapsed := time.Since(start)
	if elapsed > 500*time.Millisecond {
		t.Fatalf("EnsureHold blocked %s against a hanging liveness ping with a %s timeout — the ping is not bounded", elapsed, timeout)
	}
}

// hangAfterFirstPingConn answers the FIRST Ping immediately (so EnsureHold's
// initial establish succeeds and the conn is stored as held), then hangs on
// every subsequent Ping until its ctx is cancelled — simulating a compute
// that goes black-holed after the hold was already established.
type hangAfterFirstPingConn struct{ pings int }

func (c *hangAfterFirstPingConn) Ping(ctx context.Context) error {
	c.pings++
	if c.pings == 1 {
		return nil
	}
	<-ctx.Done()
	return ctx.Err()
}
func (c *hangAfterFirstPingConn) Close() error { return nil }

func TestHoldManager_ReconcileOfOtherAppsNotStarved(t *testing.T) {
	// Two apps share a HoldManager the way the controller's single Deps.Holds
	// does. app1's dial hangs forever (black-holed compute); app2 must still
	// get its EnsureHold call serviced within roughly one timeout window, not
	// stalled for the OS TCP connect timeout (tens of seconds).
	const timeout = 50 * time.Millisecond
	dial := &selectiveBlockDialer{blockApp: "app1", fast: &fakeDialer{}}
	m := NewHoldManager(func(_ context.Context, app string) (string, error) {
		return "postgres://app_" + app + ":pw@pggw-apps.scale-zero-pg.svc:55432/" + app + "?sslmode=disable", nil
	}, dial, timeout)

	start := time.Now()
	_ = m.EnsureHold(context.Background(), "app1") // hangs, then times out
	err2 := m.EnsureHold(context.Background(), "app2")
	elapsed := time.Since(start)

	if err2 != nil {
		t.Fatalf("EnsureHold(app2) after app1 hung: %v", err2)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("reconciling app1 then app2 took %s — app1's hung dial starved app2's reconcile", elapsed)
	}
}

// selectiveBlockDialer hangs on Dial for one app (until ctx is done) and
// dials normally (via a fast fake) for every other app.
type selectiveBlockDialer struct {
	blockApp string
	fast     *fakeDialer
}

func (d *selectiveBlockDialer) Dial(ctx context.Context, dsn string) (HoldConn, error) {
	if strings.Contains(dsn, "/"+d.blockApp+"?") {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return d.fast.Dial(ctx, dsn)
}

// ---- SQLDialer connect_timeout (review finding #1, deeper root cause) -----
//
// database/sql's LEGACY connector path (what lib/pq uses — it implements only
// driver.Driver, not driver.DriverContext/OpenConnector) calls
// driver.Open(dsn) SYNCHRONOUSLY with NO context at all for a brand-new
// connection (see database/sql's dsnConnector.Connect, which discards its ctx
// argument). A context.WithTimeout around Dial/Ping therefore does NOT bound
// lib/pq's own raw TCP connect for a fresh dial — only the DSN's
// connect_timeout parameter does (lib/pq reads it and calls
// net.Dialer.DialTimeout internally). SQLDialer must inject one.

func TestSQLDialer_AppendsConnectTimeoutToDSN(t *testing.T) {
	dsn := "postgres://app_x:pw@pggw-apps.scale-zero-pg.svc:55432/x?sslmode=disable"
	got := appendConnectTimeout(dsn, 5)
	want := "postgres://app_x:pw@pggw-apps.scale-zero-pg.svc:55432/x?sslmode=disable&connect_timeout=5"
	if got != want {
		t.Fatalf("appendConnectTimeout = %q, want %q", got, want)
	}
}

func TestSQLDialer_AppendConnectTimeoutHandlesNoExistingQuery(t *testing.T) {
	dsn := "postgres://app_x:pw@pggw-apps.scale-zero-pg.svc:55432/x"
	got := appendConnectTimeout(dsn, 5)
	want := "postgres://app_x:pw@pggw-apps.scale-zero-pg.svc:55432/x?connect_timeout=5"
	if got != want {
		t.Fatalf("appendConnectTimeout = %q, want %q", got, want)
	}
}

func TestSQLDialer_AppendConnectTimeoutIdempotent(t *testing.T) {
	// A DSN that already declares connect_timeout (an owner override) must be
	// left alone — never doubled up into an invalid/conflicting DSN.
	dsn := "postgres://app_x:pw@pggw-apps.scale-zero-pg.svc:55432/x?sslmode=disable&connect_timeout=30"
	got := appendConnectTimeout(dsn, 5)
	if got != dsn {
		t.Fatalf("appendConnectTimeout overrode an explicit connect_timeout: got %q, want unchanged %q", got, dsn)
	}
}

func TestSQLDialer_UsesConfiguredConnectTimeout(t *testing.T) {
	// SQLDialer must derive the DSN it hands to sql.Open with a bounded
	// connect_timeout rather than passing the raw (unbounded) Secret DSN
	// through unmodified.
	dialer := SQLDialer{ConnectTimeout: 7 * time.Second}
	got := dialer.dsnWithTimeout("postgres://app_x:pw@h:55432/x?sslmode=disable")
	want := "postgres://app_x:pw@h:55432/x?sslmode=disable&connect_timeout=7"
	if got != want {
		t.Fatalf("SQLDialer.dsnWithTimeout = %q, want %q", got, want)
	}
}

func TestSQLDialer_DefaultsConnectTimeoutWhenUnset(t *testing.T) {
	// The zero-value SQLDialer{} (as constructed by main.go before this fix)
	// must still bound the connect — never silently fall back to "no
	// timeout" just because ConnectTimeout was left unconfigured.
	dialer := SQLDialer{}
	got := dialer.dsnWithTimeout("postgres://app_x:pw@h:55432/x?sslmode=disable")
	if !strings.Contains(got, "connect_timeout=") {
		t.Fatalf("SQLDialer{}.dsnWithTimeout = %q, want a connect_timeout to be applied by default", got)
	}
}
