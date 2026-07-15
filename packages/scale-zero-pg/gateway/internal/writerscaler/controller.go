package writerscaler

import (
	"context"
	"fmt"
	"log"
)

// PodInfo is a writer compute pod plus its currently ACTUATED resources (read from
// status.containerStatuses[].resources — the live cgroup values, which may differ
// from the Deployment template after prior resizes) and its restart count (the
// zero-restart invariant is asserted against this live in the drill).
type PodInfo struct {
	Name          string
	App           string // "compute" or the app suffix for compute-<app>
	CPUReqMilli   int64
	CPULimMilli   int64
	MemReqBytes   int64
	MemLimBytes   int64
	RestartCount  int32
	BounceFlagged bool // the needs-bounce annotation is already present (avoid re-flag spam)
}

// Cluster is the Kubernetes surface the controller drives. Kept minimal so the
// RBAC stays tight: pods get/list, pods/resize patch (the in-place resize
// subresource), pods patch (the needs-bounce annotation), and read-only
// metrics.k8s.io pods for usage.
type Cluster interface {
	// Writers lists the writer compute pods to autoscale (Running only).
	Writers(ctx context.Context) ([]PodInfo, error)
	// Usage returns per-pod-name resource usage from metrics-server.
	Usage(ctx context.Context) (map[string]Usage, error)
	// ResizeCPU applies an in-place CPU request+limit resize (pods/resize).
	ResizeCPU(ctx context.Context, pod string, reqMilli, limMilli int64) error
	// ResizeMem applies an in-place memory request+limit resize (pods/resize).
	// It is a SEPARATE call from ResizeCPU on purpose: a combined cpu+mem resize
	// patch is rejected ("only cpu and memory resources are mutable") — see
	// docs/operations.md. Patch per resource.
	ResizeMem(ctx context.Context, pod string, reqBytes, limBytes int64) error
	// FlagBounce annotates the pod to request an operator maintenance-window bounce
	// (memory-bound at max; shared_buffers is boot-fixed). It NEVER restarts the pod.
	FlagBounce(ctx context.Context, pod, reason string) error
}

// Usage is one pod's observed CPU (millicores) and memory (bytes) from metrics-server.
type Usage struct {
	CPUMilli int64
	MemBytes int64
}

// Config is the controller's hysteresis + bounds wiring.
type Config struct {
	Bounds
	UpHold   int // consecutive Up ticks required before a scale-up fires (anti-flap)
	DownHold int // consecutive Down ticks required before a scale-down fires (anti-flap)
	Cooldown int // ticks after any resize during which no further resize fires (anti-flap)
}

// state is the per-pod hysteresis memory.
type state struct {
	cpuUp, cpuDown int
	memUp, memDown int
	cooldown       int
}

// Controller runs one Tick per poll interval. Single-goroutine by design.
type Controller struct {
	cl      Cluster
	cfg     Config
	metrics *Metrics
	logger  *log.Logger
	states  map[string]*state
}

// NewController wires a Controller. Holds (< 1) clamp to 1, Cooldown (< 0) to 0.
func NewController(cl Cluster, cfg Config, m *Metrics, logger *log.Logger) *Controller {
	if cfg.UpHold < 1 {
		cfg.UpHold = 1
	}
	if cfg.DownHold < 1 {
		cfg.DownHold = 1
	}
	if cfg.Cooldown < 0 {
		cfg.Cooldown = 0
	}
	return &Controller{cl: cl, cfg: cfg, metrics: m, logger: logger, states: map[string]*state{}}
}

// Metrics exposes the counter set.
func (c *Controller) Metrics() *Metrics { return c.metrics }

func (c *Controller) logf(format string, args ...any) {
	if c.logger != nil {
		c.logger.Printf("[writer-autoscaler] "+format, args...)
	}
}

// Tick performs one observe→decide→act pass over every writer pod. It returns the
// number of resizes actuated on this tick (0 on a quiet tick). Errors on a single
// pod are logged and counted, not fatal — one bad pod never stalls the fleet.
func (c *Controller) Tick(ctx context.Context) (int, error) {
	c.metrics.Check()

	pods, err := c.cl.Writers(ctx)
	if err != nil {
		return 0, fmt.Errorf("list writers: %w", err)
	}
	usage, err := c.cl.Usage(ctx)
	if err != nil {
		// Usage is the whole signal; without it we cannot decide. Surface it so the
		// caller logs, but don't crash — metrics-server may be briefly unavailable.
		return 0, fmt.Errorf("usage: %w", err)
	}

	// Garbage-collect state for pods that vanished (scaled to zero / re-provisioned)
	// so a re-woken pod starts fresh at baseline rather than inheriting stale counters.
	live := make(map[string]struct{}, len(pods))
	for i := range pods {
		live[pods[i].Name] = struct{}{}
	}
	for name := range c.states {
		if _, ok := live[name]; !ok {
			delete(c.states, name)
		}
	}

	resized := 0
	for i := range pods {
		u, ok := usage[pods[i].Name]
		if !ok {
			// No metrics sample for this pod this tick (metrics-server lag, or the pod
			// just woke and hasn't been scraped yet). NEVER treat missing data as zero
			// usage — that would spuriously scale a busy writer DOWN. Skip it; its
			// hysteresis counters are left untouched so no progress is lost or gained.
			c.metrics.NoSample()
			c.logf("no metrics sample for %s this tick — skipping (no resize on missing data)", pods[i].Name)
			continue
		}
		if c.evaluate(ctx, &pods[i], u) {
			resized++
		}
	}
	c.metrics.SetWriters(len(pods))
	return resized, nil
}

// evaluate applies the pure Decide plus hysteresis + cooldown for one pod, and
// actuates at most one CPU and one memory resize. Returns true if it actuated
// anything. This is the anti-flap heart: a resize fires only after UpHold/DownHold
// consecutive same-direction ticks, and never within Cooldown ticks of the last one.
func (c *Controller) evaluate(ctx context.Context, p *PodInfo, u Usage) bool {
	st := c.states[p.Name]
	if st == nil {
		st = &state{}
		c.states[p.Name] = st
	}
	// Capture the cooling state BEFORE decrementing so a Cooldown of N suppresses
	// exactly N subsequent ticks (the decrement-then-test order would suppress N-1).
	cooling := st.cooldown > 0
	if cooling {
		st.cooldown--
	}

	d := Decide(Sample{
		CPUUsageMilli: u.CPUMilli,
		MemUsageBytes: u.MemBytes,
		CPUReqMilli:   p.CPUReqMilli,
		CPULimMilli:   p.CPULimMilli,
		MemReqBytes:   p.MemReqBytes,
		MemLimBytes:   p.MemLimBytes,
	}, c.cfg.Bounds)

	// Never-bounce guard: a memory-bound writer at its max limit is FLAGGED for an
	// operator maintenance-window bounce, never bounced here. Idempotent: flag once.
	if d.NeedsBounce && !p.BounceFlagged {
		if err := c.cl.FlagBounce(ctx, p.Name, d.BounceReason); err != nil {
			c.logf("flag-bounce %s: %v", p.Name, err)
			c.metrics.Error()
		} else {
			c.metrics.NeedsBounce()
			c.logf("FLAGGED %s for maintenance-window bounce: %s", p.Name, d.BounceReason)
		}
	}

	// Advance the per-direction consecutive counters.
	tallyCPU(st, d.CPUDir)
	tallyMem(st, d.MemDir)

	// Cooldown suppresses actuation but NOT the counters/flagging above — so the
	// instant cooldown lifts we already know the sustained direction.
	if cooling {
		return false
	}

	acted := false

	// CPU: fire on a sustained, actionable direction.
	if d.ChangeCPU {
		if d.CPUDir == Up && st.cpuUp >= c.cfg.UpHold {
			c.actuateCPU(ctx, p, d, Up, st)
			acted = true
		} else if d.CPUDir == Down && st.cpuDown >= c.cfg.DownHold {
			c.actuateCPU(ctx, p, d, Down, st)
			acted = true
		}
	}

	// Memory: independent of CPU, but share the cooldown (one resize per pod per
	// cooldown window keeps the anti-flap simple and the kubelet calm).
	if !acted && d.ChangeMem {
		if d.MemDir == Up && st.memUp >= c.cfg.UpHold {
			c.actuateMem(ctx, p, d, Up, st)
			acted = true
		} else if d.MemDir == Down && st.memDown >= c.cfg.DownHold {
			c.actuateMem(ctx, p, d, Down, st)
			acted = true
		}
	}

	return acted
}

func (c *Controller) actuateCPU(ctx context.Context, p *PodInfo, d Decision, dir Direction, st *state) {
	if err := c.cl.ResizeCPU(ctx, p.Name, d.NewCPUReqMilli, d.NewCPULimMilli); err != nil {
		c.logf("resize-cpu %s: %v", p.Name, err)
		c.metrics.Error()
		return
	}
	c.metrics.Resize(dir, "cpu")
	c.logf("RESIZE %s cpu %s: limit %dm→%dm (req %dm fixed, no bounce, no restart)",
		p.Name, dir, p.CPULimMilli, d.NewCPULimMilli, d.NewCPUReqMilli)
	c.resetAndCool(st)
}

func (c *Controller) actuateMem(ctx context.Context, p *PodInfo, d Decision, dir Direction, st *state) {
	if err := c.cl.ResizeMem(ctx, p.Name, d.NewMemReqBytes, d.NewMemLimBytes); err != nil {
		c.logf("resize-mem %s: %v", p.Name, err)
		c.metrics.Error()
		return
	}
	c.metrics.Resize(dir, "memory")
	c.logf("RESIZE %s mem %s: limit %dMi→%dMi (req %dMi fixed, no bounce, no restart)",
		p.Name, dir, p.MemLimBytes>>20, d.NewMemLimBytes>>20, d.NewMemReqBytes>>20)
	c.resetAndCool(st)
}

func (c *Controller) resetAndCool(st *state) {
	st.cpuUp, st.cpuDown, st.memUp, st.memDown = 0, 0, 0, 0
	st.cooldown = c.cfg.Cooldown
}

func tallyCPU(st *state, dir Direction) {
	switch dir {
	case Up:
		st.cpuUp++
		st.cpuDown = 0
	case Down:
		st.cpuDown++
		st.cpuUp = 0
	default:
		st.cpuUp, st.cpuDown = 0, 0
	}
}

func tallyMem(st *state, dir Direction) {
	switch dir {
	case Up:
		st.memUp++
		st.memDown = 0
	case Down:
		st.memDown++
		st.memUp = 0
	default:
		st.memUp, st.memDown = 0, 0
	}
}
