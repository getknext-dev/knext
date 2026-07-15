package gateway

import (
	"bytes"
	"fmt"
	"net"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// replStartup dials the apps-gateway, sends a REPLICATION StartupMessage
// (replication=database, the logical-replication walreceiver handshake), and
// returns the ErrorResponse SQLSTATE (or "" if the first reply was not an error).
func replStartup(t *testing.T, addr, user, db string) string {
	t.Helper()
	pc := dialGateway(t, addr)
	defer pc.c.Close()
	pc.c.Write(proto.BuildStartup(map[string]string{"user": user, "database": db, "replication": "database"}))
	b := pc.waitFor(t, func(b []byte) bool { return bytes.IndexByte(b, 'E') >= 0 && len(b) > 6 }, 5*time.Second)
	if i := bytes.IndexByte(b, 'E'); i >= 0 {
		b = b[i:]
	}
	return proto.ErrorCode(b)
}

// A subscriber's walreceiver connecting THROUGH the apps-gateway with the per-zone
// REPLICATION role must (a) be authorized and (b) wake the SAME per-zone compute a
// normal connect would (ADR-0007 §4c). We prove the wake TARGET resolves correctly
// by observing the scaler was asked to scale compute-<zone>. An app-role or
// cloud_admin replication startup is refused PRE-wake (the scaler is never asked).
func TestReplicationWakeResolvesPublisherCompute(t *testing.T) {
	scaler := &notFoundScaler{}
	_, addr := newAppsGatewayScaled(t, scaler, "10")

	// Wrong role on the replication path: refused pre-wake, uniform 28P01.
	if code := replStartup(t, addr, "app_zone-eu", "zone-eu"); code != "28P01" {
		t.Fatalf("app role on replication path: SQLSTATE=%q, want 28P01 (refused pre-wake)", code)
	}
	if code := replStartup(t, addr, "cloud_admin", "zone-eu"); code != "28P01" {
		t.Fatalf("cloud_admin replication: SQLSTATE=%q, want 28P01", code)
	}
	if got := scaler.scaledDeployments(); len(got) != 0 {
		t.Fatalf("a refused replication pair reached the wake path (scaled %v)", got)
	}

	// Correct per-zone repl role: authorized, so the wake path resolves + scales
	// compute-zone-eu — the publisher whose WAL the subscriber wants to stream.
	_ = replStartup(t, addr, "repl_zone-eu", "zone-eu")
	found := false
	for _, d := range scaler.scaledDeployments() {
		if d == "compute-zone-eu" {
			found = true
		}
	}
	if !found {
		t.Fatalf("repl_zone-eu/zone-eu did not wake compute-zone-eu; scaled=%v", scaler.scaledDeployments())
	}
}

// don't-sleep-while-replicating: a live replication stream (replCount>0) must hold
// the compute awake across MANY idle windows, and the publisher becomes
// sleep-eligible ONLY after the walreceiver disconnects (subscriber caught up and
// slept, or unsubscribed). This is the core ADR-0007 §4c idle-logic extension.
func TestReplicationConnectionHoldsPublisherAwake(t *testing.T) {
	gw, err := New(wake.Env{
		"GW_COMPUTE_MODE": "exec",
		"GW_TARGET":       "127.0.0.1:1",
		"GW_WAKE_CMD":     "true",
		"GW_SLEEP_CMD":    "true",
		"GW_IDLE_MS":      "25", // several windows elapse inside the assertion below
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	rd := &recordingDriver{}
	gw.driver = rd
	pub := rd.Resolve("zone-eu")

	// Subscriber's walreceiver connects (replication=true).
	gw.connStarted(pub, true)
	// A concurrent ordinary connection opens and closes — its end must NOT sleep
	// the publisher, because the replication stream is still live.
	gw.connStarted(pub, false)
	gw.connEnded(pub, false)

	// Ride out ~12 idle windows: a compute that ignored the replication hold would
	// have scaled to zero here.
	time.Sleep(300 * time.Millisecond)
	if got := rd.sleptKeys(); len(got) != 0 {
		t.Fatalf("publisher slept while a replication stream was live (slept=%v)", got)
	}

	// Walreceiver disconnects (caught up + subscriber slept): now sleep-eligible.
	gw.connEnded(pub, true)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if got := rd.sleptKeys(); len(got) >= 1 {
			if got[0] != "zone-eu" {
				t.Fatalf("unexpected key slept: %v", got)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("publisher never slept after the replication stream closed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// End-to-end through the real Serve/handle/proxy path: a replication startup while
// the compute is asleep WAKES it (gateway-mediated replication-wake), is counted as
// a replication stream, is held awake while open, and is scaled to zero once it
// closes and the idle window elapses. Proves the full 0->1 wake + hold + 1->0 loop.
func TestE2EReplicationWakeHoldAndSleep(t *testing.T) {
	dir := t.TempDir()
	flag := filepath.Join(dir, "compute-on")
	fc := &fakeCompute{port: freePort(t)}
	defer fc.stop()

	stopPoller := make(chan struct{})
	var starting int32
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopPoller:
				return
			case <-ticker.C:
				want := fileExists(flag)
				if want && !fc.running() && atomic.CompareAndSwapInt32(&starting, 0, 1) {
					go func() {
						time.Sleep(120 * time.Millisecond)
						if fileExists(flag) {
							fc.start()
						}
						atomic.StoreInt32(&starting, 0)
					}()
				} else if !want && fc.running() && atomic.LoadInt32(&starting) == 0 {
					fc.stop()
				}
			}
		}
	}()
	defer close(stopPoller)

	env := wake.Env{
		"GW_COMPUTE_MODE":       "exec",
		"GW_TARGET":             fmt.Sprintf("127.0.0.1:%d", fc.port),
		"GW_WAKE_CMD":           "touch " + flag,
		"GW_SLEEP_CMD":          "rm -f " + flag,
		"GW_IDLE_MS":            "300",
		"GW_WAKE_TIMEOUT_MS":    "5000",
		"GW_CONNECT_TIMEOUT_MS": "200",
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
	defer ln.Close()
	go gw.Serve(ln)
	addr := ln.Addr().String()

	if fileExists(flag) {
		t.Fatalf("compute should start OFF")
	}

	// 1. Replication startup while compute is down -> gateway wakes it, and the
	//    walsender handshake reply (AuthenticationOk 'R' + ReadyForQuery 'Z')
	//    pipes back through the same byte pump ordinary traffic uses.
	c := dialGateway(t, addr)
	c.c.Write(proto.BuildStartup(map[string]string{"user": "repl_z", "database": "z", "replication": "database"}))
	c.waitFor(t, func(b []byte) bool { return bytes.IndexByte(b, 0x52) >= 0 && bytes.IndexByte(b, 0x5a) >= 0 }, 5*time.Second)
	if !fileExists(flag) {
		t.Fatalf("replication connect did not wake compute")
	}
	if gw.Metrics().Wakes() != 1 {
		t.Fatalf("wakes_total = %d, want 1", gw.Metrics().Wakes())
	}
	if gw.Metrics().ReplicationConns() != 1 {
		t.Fatalf("replication_connections_total = %d, want 1 (startup not detected as replication)", gw.Metrics().ReplicationConns())
	}

	// 2. Hold: while the replication stream stays open, the publisher must NOT sleep
	//    even though the idle window elapses several times.
	time.Sleep(900 * time.Millisecond)
	if !fileExists(flag) || !fc.running() {
		t.Fatalf("publisher slept while the replication stream was live")
	}
	if gw.Metrics().Sleeps() != 0 {
		t.Fatalf("sleeps_total = %d during active replication, want 0", gw.Metrics().Sleeps())
	}

	// 3. Close the stream -> after the idle window the publisher scales to zero.
	c.c.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if !fileExists(flag) && !fc.running() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("publisher never slept after the replication stream closed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if gw.Metrics().Sleeps() != 1 {
		t.Fatalf("sleeps_total = %d after stream close + idle, want 1", gw.Metrics().Sleeps())
	}
}
