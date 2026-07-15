package wake

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeGate is an in-memory gateCtl: no real socket, records transitions.
type fakeGate struct {
	open              bool
	opens, closes     int
	openErr, closeErr error
	onState           func(bool)
}

func (f *fakeGate) Open() error {
	if f.openErr != nil {
		return f.openErr
	}
	f.open = true
	f.opens++
	if f.onState != nil {
		f.onState(true)
	}
	return nil
}
func (f *fakeGate) Close() error {
	if f.closeErr != nil {
		return f.closeErr
	}
	f.open = false
	f.closes++
	if f.onState != nil {
		f.onState(false)
	}
	return nil
}
func (f *fakeGate) IsOpen() bool             { return f.open }
func (f *fakeGate) SetOnState(fn func(bool)) { f.onState = fn }

// fakeOps is an in-memory WarmOps (also a Scaler so it can flow through
// MakeDriverWithScaler). pods is keyed by label selector.
type fakeOps struct {
	replicas    int32
	replicasErr error
	pods        map[string]int
	podsErr     error
	deleted     map[string]int
	deleteErr   error
}

func (f *fakeOps) Scale(context.Context, string, string, int32) error { return nil }
func (f *fakeOps) Replicas(context.Context, string, string) (int32, error) {
	return f.replicas, f.replicasErr
}
func (f *fakeOps) CountPods(_ context.Context, _, selector string) (int, error) {
	if f.podsErr != nil {
		return 0, f.podsErr
	}
	return f.pods[selector], nil
}
func (f *fakeOps) DeletePods(_ context.Context, _, selector string) (int, error) {
	if f.deleteErr != nil {
		return 0, f.deleteErr
	}
	n := f.pods[selector]
	if f.deleted == nil {
		f.deleted = map[string]int{}
	}
	f.deleted[selector] += n
	f.pods[selector] = 0
	return n, nil
}

func newFakeOps() *fakeOps { return &fakeOps{pods: map[string]int{}} }

func warmEnv() Env { return Env{"GW_COMPUTE_MODE": "warmpool"} }

func TestWarmDriverResolveAndCanSleep(t *testing.T) {
	d := newWarmDriver(warmEnv(), newFakeOps(), &fakeGate{})
	if d.Mode() != "warmpool" {
		t.Fatalf("Mode = %s, want warmpool", d.Mode())
	}
	got := d.Resolve("ignored")
	want := Target{Host: "compute-warm.scale-zero-pg.svc", Port: 55433, Key: "scale-zero-pg/compute-warm"}
	if got != want {
		t.Fatalf("Resolve = %+v, want %+v", got, want)
	}
	if !d.CanSleep() {
		t.Fatal("warmpool CanSleep = false, want true")
	}
}

// NEGATIVE TEST (mandatory): the gate must NOT open while the cold compute
// deployment still has desired replicas — two attached computes on one timeline
// is corruption.
func TestWarmWakeRefusesWhenColdReplicasNonZero(t *testing.T) {
	ops := newFakeOps()
	ops.replicas = 1 // cold compute is up
	g := &fakeGate{}
	d := newWarmDriver(warmEnv(), ops, g)

	err := d.Wake(context.Background(), d.Resolve(""))
	if err == nil {
		t.Fatal("Wake opened the gate while cold compute has replicas=1")
	}
	if !strings.Contains(err.Error(), "single-writer") {
		t.Fatalf("error %q should mention single-writer", err.Error())
	}
	if g.opens != 0 || g.IsOpen() {
		t.Fatal("gate was opened despite the single-writer refusal")
	}
}

// NEGATIVE TEST: replicas may read 0 (just scaled down) but a Terminating pod
// still holds the timeline — refuse until pods reach zero too.
func TestWarmWakeRefusesWhenColdPodsPresent(t *testing.T) {
	ops := newFakeOps()
	ops.replicas = 0
	ops.pods["app=compute"] = 1 // a draining cold pod
	g := &fakeGate{}
	d := newWarmDriver(warmEnv(), ops, g)

	err := d.Wake(context.Background(), d.Resolve(""))
	if err == nil {
		t.Fatal("Wake opened the gate while a cold compute pod is still present")
	}
	if !strings.Contains(err.Error(), "single-writer") {
		t.Fatalf("error %q should mention single-writer", err.Error())
	}
	if g.opens != 0 || g.IsOpen() {
		t.Fatal("gate opened despite a draining cold pod")
	}
}

func TestWarmWakeOpensGateWhenColdDrained(t *testing.T) {
	ops := newFakeOps() // replicas 0, no pods
	g := &fakeGate{}
	d := newWarmDriver(warmEnv(), ops, g)

	if err := d.Wake(context.Background(), d.Resolve("")); err != nil {
		t.Fatalf("Wake on drained cold: %v", err)
	}
	if g.opens != 1 || !g.IsOpen() {
		t.Fatalf("gate not opened after a clean single-writer check (opens=%d open=%v)", g.opens, g.IsOpen())
	}
}

// Fail-safe: any error resolving the cold state must refuse the gate, never
// open it optimistically.
func TestWarmWakeFailsSafeOnApiErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		mut  func(*fakeOps)
	}{
		{"replicas error", func(o *fakeOps) { o.replicasErr = errors.New("api down") }},
		{"pod list error", func(o *fakeOps) { o.podsErr = errors.New("api down") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ops := newFakeOps()
			tc.mut(ops)
			g := &fakeGate{}
			d := newWarmDriver(warmEnv(), ops, g)
			if err := d.Wake(context.Background(), d.Resolve("")); err == nil {
				t.Fatal("Wake should refuse on a single-writer check error")
			}
			if g.opens != 0 || g.IsOpen() {
				t.Fatal("gate opened despite a failed single-writer check")
			}
		})
	}
}

func TestWarmSleepClosesGateAndDeletesWarmPod(t *testing.T) {
	ops := newFakeOps()
	ops.pods["app=compute-warm"] = 1
	g := &fakeGate{open: true}
	d := newWarmDriver(warmEnv(), ops, g)

	if err := d.Sleep(context.Background(), d.Resolve("")); err != nil {
		t.Fatalf("Sleep: %v", err)
	}
	if g.IsOpen() {
		t.Fatal("gate still open after Sleep")
	}
	if ops.deleted["app=compute-warm"] != 1 {
		t.Fatalf("warm pod not deleted (deleted=%v)", ops.deleted)
	}
}

// Even if the pod delete fails, the gate must already be closed (fail-safe: a
// closed gate re-parks the pod on its next probe regardless).
func TestWarmSleepClosesGateEvenIfDeleteFails(t *testing.T) {
	ops := newFakeOps()
	ops.deleteErr = errors.New("delete forbidden")
	g := &fakeGate{open: true}
	d := newWarmDriver(warmEnv(), ops, g)

	if err := d.Sleep(context.Background(), d.Resolve("")); err == nil {
		t.Fatal("Sleep should surface the delete error")
	}
	if g.IsOpen() {
		t.Fatal("gate must be closed before the pod delete is attempted")
	}
}

// recordSink captures gate-state gauge writes.
type recordSink struct{ states []bool }

func (r *recordSink) SetGateOpen(open bool) { r.states = append(r.states, open) }

func TestWarmAttachMetricsWiresGaugeAndInitialState(t *testing.T) {
	ops := newFakeOps()
	g := &fakeGate{}
	d := newWarmDriver(warmEnv(), ops, g)

	sink := &recordSink{}
	d.AttachMetrics(sink)
	// Initial push reflects the closed gate.
	if len(sink.states) != 1 || sink.states[0] != false {
		t.Fatalf("AttachMetrics initial states = %v, want [false]", sink.states)
	}
	if err := d.Wake(context.Background(), d.Resolve("")); err != nil {
		t.Fatalf("Wake: %v", err)
	}
	if len(sink.states) != 2 || sink.states[1] != true {
		t.Fatalf("after Wake states = %v, want last true", sink.states)
	}
	if err := d.Sleep(context.Background(), d.Resolve("")); err != nil {
		t.Fatalf("Sleep: %v", err)
	}
	if sink.states[len(sink.states)-1] != false {
		t.Fatalf("after Sleep last state = %v, want false", sink.states[len(sink.states)-1])
	}
}

func TestMakeWarmpoolDriverFromEnv(t *testing.T) {
	d, err := MakeDriverWithScaler(Env{"GW_COMPUTE_MODE": "warmpool", "GW_GATE_PORT": "9091"}, newFakeOps())
	if err != nil {
		t.Fatalf("MakeDriverWithScaler warmpool: %v", err)
	}
	if d.Mode() != "warmpool" {
		t.Fatalf("Mode = %s, want warmpool", d.Mode())
	}
	if !d.CanSleep() {
		t.Fatal("warmpool CanSleep = false")
	}
	if got := d.Resolve("x"); got.Port != 55433 {
		t.Fatalf("Resolve port = %d, want 55433", got.Port)
	}
}
