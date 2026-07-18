package appdb

import (
	"context"
	"errors"
	"testing"
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
	m := NewHoldManager(dsnReaderOK("app1"), dial)

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
	m := NewHoldManager(dsnReaderOK("app1"), dial)

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
	m := NewHoldManager(dsnReaderOK("app1"), dial)

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
	m := NewHoldManager(dsnReaderOK("app1"), dial)

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
	m := NewHoldManager(dsnReaderOK("app1"), dial)

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
	}, dial)

	if err := m.EnsureHold(context.Background(), "app1"); err == nil {
		t.Fatal("EnsureHold with a failing DSN reader: err = nil, want the read error")
	}
	if len(dial.dialed) != 0 {
		t.Fatalf("dialed %d times despite the DSN read failing, want 0", len(dial.dialed))
	}
}

func TestHoldManager_ReleaseCloses(t *testing.T) {
	dial := &fakeDialer{}
	m := NewHoldManager(dsnReaderOK("app1"), dial)

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
	m := NewHoldManager(dsnReaderOK("x"), dial)
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
