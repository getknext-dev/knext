package gateway

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// fakePeers reports a controllable fleet-wide active connection count.
type fakePeers struct{ n int }

func (f *fakePeers) ActiveConnections(context.Context) (int, error) { return f.n, nil }

// Running 2+ gateway replicas must not split-brain the idle decision: a
// gateway with zero local connections may only sleep the compute when the
// WHOLE fleet is at zero. With peers reporting activity, sleep is postponed;
// once they report zero, the next idle window sleeps as usual.
func TestIdleSleepDefersToPeers(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "slept")

	env := wake.Env{
		"GW_COMPUTE_MODE": "exec",
		"GW_TARGET":       "127.0.0.1:1", // never dialed in this test
		"GW_WAKE_CMD":     "true",
		"GW_SLEEP_CMD":    "touch " + marker,
		"GW_IDLE_MS":      "80",
	}
	gw, err := New(env, nil)
	if err != nil {
		t.Fatal(err)
	}
	peers := &fakePeers{n: 3}
	gw.Peers = peers

	target := gw.Driver().Resolve("testdb")
	gw.connStarted(target)
	gw.connEnded(target) // count hits 0 -> idle timer armed

	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("slept while peers had active connections (split-brain)")
	}

	peers.n = 0 // fleet went quiet; the rescheduled timer may now sleep
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break // slept, as it should
		}
		if time.Now().After(deadline) {
			t.Fatal("never slept after peers went quiet")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
