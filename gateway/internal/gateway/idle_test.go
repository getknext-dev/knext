package gateway

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// recordingDriver is a per-app driver whose Sleep records the target key, so the
// idle logic's per-app routing can be asserted without a cluster. Resolve keys
// by the system id (like template mode) so each app gets a distinct key.
type recordingDriver struct {
	mu    sync.Mutex
	slept []string
}

func (d *recordingDriver) Mode() string { return "recording" }
func (d *recordingDriver) Resolve(s string) wake.Target {
	return wake.Target{Host: "h", Port: 1, Key: s}
}
func (d *recordingDriver) Wake(context.Context, wake.Target) error { return nil }
func (d *recordingDriver) Sleep(_ context.Context, t wake.Target) error {
	d.mu.Lock()
	d.slept = append(d.slept, t.Key)
	d.mu.Unlock()
	return nil
}
func (d *recordingDriver) CanSleep() bool { return true }
func (d *recordingDriver) sleptKeys() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.slept...)
}

// Issue #75: with 2 gateway replicas, an app that is idle everywhere must scale
// to zero even while a DIFFERENT app is busy on a peer. The peer check is
// per-app, so app X sleeps while app Y (active on a peer) is held awake.
func TestIdleSleepIsPerAppNotFleetGlobal(t *testing.T) {
	gw, err := New(wake.Env{
		"GW_COMPUTE_MODE": "exec",
		"GW_TARGET":       "127.0.0.1:1",
		"GW_WAKE_CMD":     "true",
		"GW_SLEEP_CMD":    "true",
		"GW_IDLE_MS":      "40",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	rd := &recordingDriver{}
	gw.driver = rd
	// The fleet reports app "appy" busy on a peer; "appx" is quiet everywhere.
	gw.Peers = &fakePeers{byKey: map[string]int{"appy": 3}}

	tx := rd.Resolve("appx")
	ty := rd.Resolve("appy")
	gw.connStarted(tx)
	gw.connEnded(tx) // appx idle -> should sleep (no peer holds appx)
	gw.connStarted(ty)
	gw.connEnded(ty) // appy idle locally but a peer reports appy active -> hold

	deadline := time.Now().Add(2 * time.Second)
	for {
		slept := rd.sleptKeys()
		for _, k := range slept {
			if k == "appy" {
				t.Fatalf("appy slept while a peer reported it active (fleet-global regression)")
			}
		}
		if len(slept) == 1 && slept[0] == "appx" {
			return // exactly the idle app slept — per-app decision holds
		}
		if time.Now().After(deadline) {
			t.Fatalf("appx never slept independently (slept=%v)", slept)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// fakePeers reports a controllable active connection count. When byKey is set it
// answers per-app (issue #75); otherwise it returns the flat n for any key and
// records the last key it was asked about.
type fakePeers struct {
	n       int
	byKey   map[string]int
	lastKey string
}

func (f *fakePeers) ActiveConnections(_ context.Context, key string) (int, error) {
	f.lastKey = key
	if f.byKey != nil {
		return f.byKey[key], nil
	}
	return f.n, nil
}

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
