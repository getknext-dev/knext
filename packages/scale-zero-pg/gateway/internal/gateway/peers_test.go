package gateway

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/metrics"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// The peer scrape must read the PER-APP active count from per_system, not the
// fleet-global active_connections scalar (issue #75). A peer busy with app "b"
// must report 0 for app "a".
func TestScrapeReadsPerSystemActiveNotGlobalScalar(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// active_connections (global) = 5, but per-app: a=0, b=5.
		_, _ = w.Write([]byte(`{"active_connections":5,"per_system":{"a":{"active":0},"b":{"active":5}}}`))
	}))
	defer srv.Close()

	host, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)
	p := &k8sPeers{metricsPort: port, http: &http.Client{Timeout: 2 * time.Second}}

	ctx := context.Background()
	if n, err := p.scrape(ctx, host, "a"); err != nil || n != 0 {
		t.Fatalf("scrape(a) = %d,%v; want 0 (idle app must not see the busy neighbour's count)", n, err)
	}
	if n, err := p.scrape(ctx, host, "b"); err != nil || n != 5 {
		t.Fatalf("scrape(b) = %d,%v; want 5", n, err)
	}
	if n, err := p.scrape(ctx, host, "absent"); err != nil || n != 0 {
		t.Fatalf("scrape(absent) = %d,%v; want 0 (no key -> 0, not error)", n, err)
	}
}

// F6 / C1 (load-bearing): a peer answering non-200 — even a 401 carrying a
// well-formed JSON body with active:0 — must make scrape return an ERROR, NOT a
// zero count. Decoding a 401 body would yield Active=0 and wrongly scale an
// active DB to zero. Reverting the resp.StatusCode check reds this test.
func TestScrape401WithBodyReturnsErrorNotZero(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		// A 401 that STILL carries a valid body with active:0 — the trap C1 avoids.
		_, _ = w.Write([]byte(`{"per_system":{"a":{"active":0}}}`))
	}))
	defer srv.Close()

	host, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)
	p := &k8sPeers{metricsPort: port, http: &http.Client{Timeout: 2 * time.Second}, peerToken: "reader-token"}

	n, err := p.scrape(context.Background(), host, "a")
	if err == nil {
		t.Fatalf("scrape against a 401 peer returned (%d, nil) — a non-200 must be an error, not a 0 count (C1 regression: would wrongly sleep an active DB)", n)
	}
}

// F6: the reader attaches Authorization: Bearer <peerToken>. A token MISMATCH
// during rotation (reader token != scrapee token) yields 401 from the real
// metrics handler -> scrape returns an error -> the idle caller postpones sleep.
func TestScrapeTokenMismatchDuringRotationYields401Error(t *testing.T) {
	m := metrics.NewMetrics()
	auth, err := metrics.ResolvePeerAuth(func(k string) string {
		if k == "GW_PEER_TOKEN" {
			return "new-token" // scrapee already rotated
		}
		return ""
	})
	if err != nil {
		t.Fatalf("ResolvePeerAuth: %v", err)
	}
	srv := httptest.NewServer(m.HandlerWithPeerAuth(auth))
	defer srv.Close()

	host, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)
	// Reader still holds the OLD token.
	p := &k8sPeers{metricsPort: port, http: &http.Client{Timeout: 2 * time.Second}, peerToken: "old-token"}

	if n, err := p.scrape(context.Background(), host, "a"); err == nil {
		t.Fatalf("rotation mismatch scrape = (%d, nil); want an error from the 401 so sleep is postponed, not a wrong 0", n)
	}

	// Same reader with the matching (new) token succeeds -> 0, no error.
	p.peerToken = "new-token"
	if n, err := p.scrape(context.Background(), host, "a"); err != nil || n != 0 {
		t.Fatalf("scrape with matching token = (%d, %v); want (0, nil)", n, err)
	}
}

// scrapePeer wraps the REAL k8sPeers.scrape (not a fake) as a single-peer
// PeerChecker so the idle caller's postpone-on-error path is exercised
// end-to-end against a live HTTP peer — the mutation surface for C1.
type scrapePeer struct {
	p         *k8sPeers
	host, key string
}

func (s *scrapePeer) ActiveConnections(ctx context.Context, key string) (int, error) {
	return s.p.scrape(ctx, s.host, key)
}

// F6 / C1 end-to-end: a peer returning 401 must POSTPONE the sleep (keep the
// compute awake), never scale it to zero. This is the load-bearing behaviour:
// reverting the resp.StatusCode check in scrape makes the 401 body decode to
// active:0 -> the gateway sleeps -> this test goes RED.
func TestIdleCallerPostponesSleepOnPeer401(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "slept")

	// A peer that always answers 401 with a benign active:0 body.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"per_system":{"testdb":{"active":0}}}`))
	}))
	defer srv.Close()
	host, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)

	env := wake.Env{
		"GW_COMPUTE_MODE": "exec",
		"GW_TARGET":       "127.0.0.1:1",
		"GW_WAKE_CMD":     "true",
		"GW_SLEEP_CMD":    "touch " + marker,
		"GW_IDLE_MS":      "40",
	}
	gw, err := New(env, nil)
	if err != nil {
		t.Fatal(err)
	}
	kp := &k8sPeers{metricsPort: port, http: &http.Client{Timeout: 2 * time.Second}, peerToken: "reader-token"}
	gw.Peers = &scrapePeer{p: kp, host: host}

	target := gw.Driver().Resolve("testdb")
	gw.connStarted(target, false)
	gw.connEnded(target, false) // count -> 0, idle timer armed

	// Ride out several idle windows: with C1, the 401 is an error -> postpone
	// forever; without C1, the body decodes to 0 -> sleep fires and touches marker.
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("compute slept despite a 401 peer scrape — C1 regression: an unauthenticated/mismatched peer wrongly scaled an active DB to zero")
	}
}
