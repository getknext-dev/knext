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
	gw.connStarted(tx, false)
	gw.connEnded(tx, false) // appx idle -> should sleep (no peer holds appx)
	gw.connStarted(ty, false)
	gw.connEnded(ty, false) // appy idle locally but a peer reports appy active -> hold

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

// Issue #93(c) — cross-replica idle thrash. With the 2-replica apps-gateway and a
// connection SPLIT across replicas (this pod local-idle, a PEER still holding the
// app), the app must NOT oscillate 0<->1: the idle timer must keep RE-ARMING and
// deferring across MANY windows (never a premature 1->0 flap), then scale to zero
// EXACTLY ONCE when the peer finally drops. This is the direct evidence backing the
// docs/operations.md "Cross-replica idle thrash" assessment (no code fix required —
// the peer-aware idle in scheduleSleep already closes the window).
func TestSplitConnectionsDoNotThrashAcrossWindows(t *testing.T) {
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
	// A peer replica holds one live connection for appx the whole time.
	peers := &fakePeers{byKey: map[string]int{"appx": 1}}
	gw.Peers = peers

	tx := rd.Resolve("appx")
	gw.connStarted(tx, false)
	gw.connEnded(tx, false) // local count -> 0; idle timer armed, but the peer holds appx

	// Ride out ~12 idle windows: a thrashing gateway would sleep (1->0) here.
	time.Sleep(300 * time.Millisecond)
	if got := rd.sleptKeys(); len(got) != 0 {
		t.Fatalf("appx scaled to zero while a peer still held it — cross-replica thrash (slept=%v)", got)
	}

	// Peer drops the split connection; the re-armed timer may now sleep — ONCE.
	peers.setByKey("appx", 0)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if got := rd.sleptKeys(); len(got) >= 1 {
			if got[0] != "appx" {
				t.Fatalf("unexpected key slept: %v", got)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("appx never slept after the peer went quiet")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// And it must not keep flapping: no second scale-to-zero for the same idle app.
	time.Sleep(150 * time.Millisecond)
	if got := rd.sleptKeys(); len(got) != 1 {
		t.Fatalf("appx slept more than once (0<->1 oscillation): slept=%v", got)
	}
}

// fakePeers reports a controllable active connection count. When byKey is set it
// answers per-app (issue #75); otherwise it returns the flat n for any key and
// records the last key it was asked about.
//
// ActiveConnections runs on the gateway's idle-timer goroutine while a test
// goroutine may concurrently flip the fleet count (e.g. peers.setN(0) once the
// fleet goes quiet). Guard the mutable fields with mu so `go test -race` is clean
// (#141 — test-mock only; production PeerChecker impls are already race-free).
type fakePeers struct {
	mu      sync.Mutex
	n       int
	byKey   map[string]int
	lastKey string
}

func (f *fakePeers) ActiveConnections(_ context.Context, key string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastKey = key
	if f.byKey != nil {
		return f.byKey[key], nil
	}
	return f.n, nil
}

// setN updates the flat fleet count under the lock, so a test goroutine can flip
// it while the idle-timer goroutine is reading via ActiveConnections.
func (f *fakePeers) setN(v int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n = v
}

// setByKey updates a per-app count under the lock, so a test goroutine can drop a
// peer's connection while the idle-timer goroutine reads byKey via
// ActiveConnections.
func (f *fakePeers) setByKey(key string, v int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byKey[key] = v
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
	gw.connStarted(target, false)
	gw.connEnded(target, false) // count hits 0 -> idle timer armed

	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("slept while peers had active connections (split-brain)")
	}

	peers.setN(0) // fleet went quiet; the rescheduled timer may now sleep
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
