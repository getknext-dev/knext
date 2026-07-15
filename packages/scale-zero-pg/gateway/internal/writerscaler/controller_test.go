package writerscaler

import (
	"context"
	"log"
	"testing"
)

const Mi = 1 << 20

// fakeCluster records actions and never restarts/deletes anything — the drill and
// these tests both assert the never-bounce invariant by construction: there is no
// delete/bounce path here at all.
type fakeCluster struct {
	pod    PodInfo
	usage  Usage
	cpuOps [][2]int64 // {req,lim} per ResizeCPU call
	memOps [][2]int64 // {req,lim} per ResizeMem call
	flags  []string   // reasons per FlagBounce call
}

func (f *fakeCluster) Writers(context.Context) ([]PodInfo, error) {
	return []PodInfo{f.pod}, nil
}
func (f *fakeCluster) Usage(context.Context) (map[string]Usage, error) {
	return map[string]Usage{f.pod.Name: f.usage}, nil
}
func (f *fakeCluster) ResizeCPU(_ context.Context, _ string, req, lim int64) error {
	f.cpuOps = append(f.cpuOps, [2]int64{req, lim})
	// reflect the actuation back into the pod so subsequent ticks see it (as the
	// real controller reads live status.containerStatuses[].resources).
	f.pod.CPUReqMilli, f.pod.CPULimMilli = req, lim
	return nil
}
func (f *fakeCluster) ResizeMem(_ context.Context, _ string, req, lim int64) error {
	f.memOps = append(f.memOps, [2]int64{req, lim})
	f.pod.MemReqBytes, f.pod.MemLimBytes = req, lim
	return nil
}
func (f *fakeCluster) FlagBounce(_ context.Context, _, reason string) error {
	f.flags = append(f.flags, reason)
	f.pod.BounceFlagged = true
	return nil
}

func newCtrl(cl Cluster, upHold, downHold, cooldown int) *Controller {
	cfg := Config{Bounds: stdBounds(), UpHold: upHold, DownHold: downHold, Cooldown: cooldown}
	return NewController(cl, cfg, NewMetrics(), log.New(log.Writer(), "", 0))
}

// A single hot tick must NOT resize when UpHold=3 — hysteresis requires sustained
// pressure before actuating.
func TestHysteresisRequiresSustainedPressure(t *testing.T) {
	cl := &fakeCluster{
		pod:   PodInfo{Name: "compute", CPUReqMilli: 250, CPULimMilli: 500, MemReqBytes: 256 * Mi, MemLimBytes: 512 * Mi},
		usage: Usage{CPUMilli: 490, MemBytes: 100 * Mi}, // cpu 0.98 hot
	}
	c := newCtrl(cl, 3, 3, 5)

	if _, err := c.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(cl.cpuOps) != 0 {
		t.Fatalf("tick 1 resized too early: %v", cl.cpuOps)
	}
	// tick 2: still nothing (2 < 3)
	_, _ = c.Tick(context.Background())
	if len(cl.cpuOps) != 0 {
		t.Fatalf("tick 2 resized too early: %v", cl.cpuOps)
	}
	// tick 3: threshold reached -> exactly one resize up
	_, _ = c.Tick(context.Background())
	if len(cl.cpuOps) != 1 {
		t.Fatalf("tick 3 should resize once, got %v", cl.cpuOps)
	}
	if cl.cpuOps[0] != [2]int64{250, 750} { // req stays at baseline 250m; only the LIMIT grows 500m->750m
		t.Fatalf("resize target = %v, want {250,750} (limit-only resize)", cl.cpuOps[0])
	}
	if c.Metrics().ResizeUpCPU() != 1 {
		t.Fatalf("metric resize_up_cpu = %d, want 1", c.Metrics().ResizeUpCPU())
	}
}

// Oscillating pressure (hot, idle, hot, idle...) must NEVER resize: counters reset
// each time the direction flips, so neither hold threshold is ever reached.
func TestNoFlappingOnOscillation(t *testing.T) {
	cl := &fakeCluster{
		pod: PodInfo{Name: "compute", CPUReqMilli: 500, CPULimMilli: 1000, MemReqBytes: 256 * Mi, MemLimBytes: 512 * Mi},
	}
	c := newCtrl(cl, 3, 3, 5)
	hot := Usage{CPUMilli: 950, MemBytes: 100 * Mi}
	idle := Usage{CPUMilli: 50, MemBytes: 100 * Mi}
	for i := 0; i < 10; i++ {
		if i%2 == 0 {
			cl.usage = hot
		} else {
			cl.usage = idle
		}
		_, _ = c.Tick(context.Background())
	}
	if len(cl.cpuOps) != 0 {
		t.Fatalf("oscillation caused resizes (flapping): %v", cl.cpuOps)
	}
}

// After a resize, the cooldown must suppress a further resize even under sustained
// pressure, until it elapses — preventing rapid successive resizes.
func TestCooldownSuppressesRapidResize(t *testing.T) {
	cl := &fakeCluster{
		pod:   PodInfo{Name: "compute", CPUReqMilli: 250, CPULimMilli: 500, MemReqBytes: 256 * Mi, MemLimBytes: 512 * Mi},
		usage: Usage{CPUMilli: 490, MemBytes: 100 * Mi},
	}
	c := newCtrl(cl, 1, 1, 3) // UpHold=1 -> fires immediately; Cooldown=3
	_, _ = c.Tick(context.Background())
	if len(cl.cpuOps) != 1 {
		t.Fatalf("want 1 resize after first hot tick, got %v", cl.cpuOps)
	}
	// keep hot: cooldown must swallow the next 3 ticks
	// cl.usage stays hot but the pod's limit grew, keep usage proportionally hot:
	cl.usage = Usage{CPUMilli: cl.pod.CPULimMilli - 10, MemBytes: 100 * Mi}
	for i := 0; i < 3; i++ {
		_, _ = c.Tick(context.Background())
	}
	if len(cl.cpuOps) != 1 {
		t.Fatalf("cooldown failed to suppress resizes: %v", cl.cpuOps)
	}
	// one more tick: cooldown elapsed -> a second resize is allowed
	cl.usage = Usage{CPUMilli: cl.pod.CPULimMilli - 10, MemBytes: 100 * Mi}
	_, _ = c.Tick(context.Background())
	if len(cl.cpuOps) != 2 {
		t.Fatalf("want 2nd resize after cooldown elapsed, got %v", cl.cpuOps)
	}
}

// NEVER-BOUNCE-SILENTLY: a writer memory-bound at its max limit is flagged for an
// operator bounce, and the controller issues ZERO memory resizes and ZERO restarts
// (the fake has no restart path — asserting flags without resize proves the guard).
func TestNeverBounceSilently_FlagsInsteadOfResizing(t *testing.T) {
	cl := &fakeCluster{
		pod: PodInfo{
			Name: "compute", CPUReqMilli: 500, CPULimMilli: 1000,
			MemReqBytes: 1024 * Mi, MemLimBytes: 1024 * Mi, // AT max
		},
		usage: Usage{CPUMilli: 100, MemBytes: 1000 * Mi}, // mem 0.98 hot, at max
	}
	c := newCtrl(cl, 1, 1, 5)
	for i := 0; i < 3; i++ {
		_, _ = c.Tick(context.Background())
	}
	if len(cl.memOps) != 0 {
		t.Fatalf("memory resized despite being at max: %v", cl.memOps)
	}
	if len(cl.flags) != 1 {
		t.Fatalf("want exactly one bounce flag (idempotent), got %d: %v", len(cl.flags), cl.flags)
	}
	if c.Metrics().NeedsBounces() != 1 {
		t.Fatalf("needs_bounce metric = %d, want 1", c.Metrics().NeedsBounces())
	}
}

// Sustained low usage scales the writer back DOWN (the idle half of the cycle),
// within the min bound and never below observed usage (no OOM).
func TestScaleDownUnderSustainedIdle(t *testing.T) {
	cl := &fakeCluster{
		pod:   PodInfo{Name: "compute", CPUReqMilli: 1000, CPULimMilli: 2000, MemReqBytes: 512 * Mi, MemLimBytes: 1024 * Mi},
		usage: Usage{CPUMilli: 50, MemBytes: 50 * Mi}, // both idle
	}
	c := newCtrl(cl, 3, 2, 100) // DownHold=2
	_, _ = c.Tick(context.Background())
	if len(cl.cpuOps) != 0 {
		t.Fatalf("scaled down too early: %v", cl.cpuOps)
	}
	_, _ = c.Tick(context.Background()) // 2nd consecutive idle -> fire once (cpu wins, shares cooldown)
	if len(cl.cpuOps) != 1 {
		t.Fatalf("want 1 down-resize at DownHold=2, got %v", cl.cpuOps)
	}
	if cl.cpuOps[0] != [2]int64{1000, 1750} { // req stays 1000m; only the LIMIT shrinks 2000m->1750m
		t.Fatalf("down target = %v, want {1000,1750} (limit-only resize)", cl.cpuOps[0])
	}
	if c.Metrics().ResizeDownCPU() != 1 {
		t.Fatalf("resize_down_cpu = %d, want 1", c.Metrics().ResizeDownCPU())
	}
}

// Per-pod state is garbage-collected when a pod disappears (scale-to-zero), so a
// re-woken pod of the same name starts fresh (no inherited hot counters).
func TestStateGCOnVanishedPod(t *testing.T) {
	cl := &fakeCluster{
		pod:   PodInfo{Name: "compute", CPUReqMilli: 250, CPULimMilli: 500, MemReqBytes: 256 * Mi, MemLimBytes: 512 * Mi},
		usage: Usage{CPUMilli: 490, MemBytes: 100 * Mi},
	}
	c := newCtrl(cl, 3, 3, 5)
	_, _ = c.Tick(context.Background()) // cpuUp=1
	_, _ = c.Tick(context.Background()) // cpuUp=2

	// pod vanishes
	vanish := &vanishCluster{}
	c.cl = vanish
	_, _ = c.Tick(context.Background()) // GC removes state
	if len(c.states) != 0 {
		t.Fatalf("state not GC'd on vanish: %v", c.states)
	}
}

// noMetricsCluster returns writers but an EMPTY usage map — metrics-server has no
// sample for the pod yet (just woke / scrape lag).
type noMetricsCluster struct{ ops int }

func (n *noMetricsCluster) Writers(context.Context) ([]PodInfo, error) {
	return []PodInfo{{Name: "compute", CPUReqMilli: 1000, CPULimMilli: 2000, MemReqBytes: 512 * Mi, MemLimBytes: 1024 * Mi}}, nil
}
func (n *noMetricsCluster) Usage(context.Context) (map[string]Usage, error) {
	return map[string]Usage{}, nil // no sample for "compute"
}
func (n *noMetricsCluster) ResizeCPU(context.Context, string, int64, int64) error {
	n.ops++
	return nil
}
func (n *noMetricsCluster) ResizeMem(context.Context, string, int64, int64) error {
	n.ops++
	return nil
}
func (n *noMetricsCluster) FlagBounce(context.Context, string, string) error { return nil }

// A pod with NO metrics sample must be SKIPPED — never treated as zero usage (which
// would spuriously scale a busy writer down). Regression test for the live-drill bug.
func TestMissingMetricsNeverScalesDown(t *testing.T) {
	cl := &noMetricsCluster{}
	c := newCtrl(cl, 1, 1, 0) // DownHold=1 -> would fire immediately if usage were read as 0
	for i := 0; i < 5; i++ {
		if _, err := c.Tick(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if cl.ops != 0 {
		t.Fatalf("resized on missing metrics (%d ops) — must skip, never treat as zero usage", cl.ops)
	}
	if c.Metrics().NoSampleTotal != 5 {
		t.Fatalf("no_sample_total = %d, want 5", c.Metrics().NoSampleTotal)
	}
}

type vanishCluster struct{}

func (v *vanishCluster) Writers(context.Context) ([]PodInfo, error) { return nil, nil }
func (v *vanishCluster) Usage(context.Context) (map[string]Usage, error) {
	return map[string]Usage{}, nil
}
func (v *vanishCluster) ResizeCPU(context.Context, string, int64, int64) error { return nil }
func (v *vanishCluster) ResizeMem(context.Context, string, int64, int64) error { return nil }
func (v *vanishCluster) FlagBounce(context.Context, string, string) error      { return nil }
