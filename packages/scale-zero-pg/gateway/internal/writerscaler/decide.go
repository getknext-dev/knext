// Package writerscaler is the writer vertical-autoscaler (issue #103). It watches
// each writer compute's CPU+memory pressure and applies the proven #67 in-place
// pod resize (the `pods/resize` subresource) within operator-configured min/max
// bounds — growing/shrinking a RUNNING Postgres writer with ZERO restart.
//
// Why vertical, not horizontal: a Neon timeline has exactly one writer (single-
// writer is intrinsic; the safekeeper quorum enforces it — CLAUDE.md rule 3). The
// only way to give a hot writer more headroom without sharding is a bigger writer.
// #67 proved CPU and memory limits actuate live on k8s 1.33 (cgroup cpu.max /
// memory.max update, pg_postmaster_start_time() unchanged); this controller
// automates that primitive.
//
// The resize TIERS (documented in docs/operations.md):
//   - CPU request/limit:    LIVE  — cgroup cpu.max updates, no restart.
//   - memory request/limit: LIVE  — cgroup memory.max updates, no restart.
//   - shared_buffers:       BOOT-FIXED — grows only with a compute restart. The
//     autoscaler NEVER bounces a live writer to grow it; instead, when a writer is
//     memory-bound AT its max limit (where a larger buffer cache would help but
//     can't be actuated live), it FLAGS the pod with an annotation for an operator
//     maintenance-window bounce. Never-bounce-silently is a hard invariant.
package writerscaler

// Direction is the desired change for one resource on one tick.
type Direction int

const (
	// Hold: pressure is within the comfortable band — do nothing.
	Hold Direction = iota
	// Up: pressure is at/over the scale-up ratio — grow the resource.
	Up
	// Down: pressure is at/under the scale-down ratio — shrink the resource.
	Down
)

func (d Direction) String() string {
	switch d {
	case Up:
		return "up"
	case Down:
		return "down"
	default:
		return "hold"
	}
}

// Sample is one instantaneous observation of a writer's usage vs its currently
// ACTUATED requests/limits (the live cgroup values, read from the pod's
// containerStatuses, not the Deployment template).
type Sample struct {
	CPUUsageMilli int64 // observed CPU usage, millicores
	MemUsageBytes int64 // observed memory working set, bytes
	CPUReqMilli   int64 // current CPU request, millicores
	CPULimMilli   int64 // current CPU limit, millicores
	MemReqBytes   int64 // current memory request, bytes
	MemLimBytes   int64 // current memory limit, bytes
}

// Bounds is the operator's static wiring: the min/max envelope a writer may be
// resized within, the step per resize, and the pressure ratios.
type Bounds struct {
	MinCPUMilli  int64   // never resize CPU below this
	MaxCPUMilli  int64   // never resize CPU above this (the vertical ceiling)
	CPUStepMilli int64   // per-resize CPU increment/decrement
	MinMemBytes  int64   // never resize memory below this
	MaxMemBytes  int64   // never resize memory above this
	MemStepBytes int64   // per-resize memory increment/decrement
	UpRatio      float64 // usage/limit at/above which we scale up (e.g. 0.80)
	DownRatio    float64 // usage/limit at/below which we scale down (e.g. 0.30)
}

// Decision is the pure, deterministic outcome of comparing one Sample to Bounds.
// It carries the desired direction per resource and the clamped target values.
// It performs NO I/O and holds NO history — hysteresis lives in the Controller.
type Decision struct {
	CPUDir         Direction
	MemDir         Direction
	NewCPUReqMilli int64
	NewCPULimMilli int64
	NewMemReqBytes int64
	NewMemLimBytes int64
	ChangeCPU      bool // the clamped CPU target differs from current
	ChangeMem      bool // the clamped memory target differs from current
	// NeedsBounce is set ONLY when the writer is memory-bound at its max limit:
	// a larger shared_buffers would help but is boot-fixed, so it needs an operator
	// maintenance-window bounce. The controller flags (annotates) — never bounces.
	NeedsBounce  bool
	BounceReason string
}

func clamp(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ratio returns usage/limit, or 0 when the limit is non-positive (unbounded /
// unknown — treated as no pressure so we never scale a limitless container).
func ratio(usage, limit int64) float64 {
	if limit <= 0 {
		return 0
	}
	return float64(usage) / float64(limit)
}

// Decide compares a Sample to Bounds and returns the desired per-resource change.
// Pure and total: same input → same output, no clock, no I/O.
func Decide(s Sample, b Bounds) Decision {
	d := Decision{
		NewCPUReqMilli: s.CPUReqMilli,
		NewCPULimMilli: s.CPULimMilli,
		NewMemReqBytes: s.MemReqBytes,
		NewMemLimBytes: s.MemLimBytes,
	}

	// The autoscaler moves the LIMIT (the cgroup ceiling — burst headroom) and leaves
	// the REQUEST at the manifest baseline. This is deliberate: a limit-only in-place
	// resize actuates IMMEDIATELY (the kubelet writes cpu.max/memory.max), whereas a
	// REQUEST increase can be DEFERRED on a node without spare allocatable (#67's
	// "PodResizePending: Deferred"). Keeping requests fixed means a resize never needs
	// node re-admission and always actuates, even on a busy node. Raising guaranteed
	// floors is a manifest change, not an autoscaler action.

	// --- CPU --- (an unset/zero limit is unbounded, not idle: never scale it)
	if s.CPULimMilli > 0 {
		switch cr := ratio(s.CPUUsageMilli, s.CPULimMilli); {
		case cr >= b.UpRatio:
			d.CPUDir = Up
			d.NewCPULimMilli = clamp(s.CPULimMilli+b.CPUStepMilli, b.MinCPUMilli, b.MaxCPUMilli)
		case cr <= b.DownRatio:
			d.CPUDir = Down
			d.NewCPULimMilli = clamp(s.CPULimMilli-b.CPUStepMilli, b.MinCPUMilli, b.MaxCPUMilli)
		}
	}
	// Never let the limit fall below the (fixed) request — req <= lim is an invariant.
	if d.NewCPULimMilli < s.CPUReqMilli {
		d.NewCPULimMilli = s.CPULimMilli
		d.CPUDir = Hold
	}
	d.ChangeCPU = d.NewCPULimMilli != s.CPULimMilli

	// --- Memory --- (an unset/zero limit is unbounded, not idle: never scale it)
	if s.MemLimBytes <= 0 {
		return d
	}
	switch mr := ratio(s.MemUsageBytes, s.MemLimBytes); {
	case mr >= b.UpRatio:
		d.MemDir = Up
		d.NewMemLimBytes = clamp(s.MemLimBytes+b.MemStepBytes, b.MinMemBytes, b.MaxMemBytes)
		// Never-bounce guard: memory-bound but already AT the max limit. We cannot
		// actuate more buffer cache live (shared_buffers is boot-fixed), so flag for
		// an operator maintenance-window bounce rather than silently bouncing.
		if s.MemLimBytes >= b.MaxMemBytes {
			d.NeedsBounce = true
			d.BounceReason = "memory at max limit under sustained pressure; a larger shared_buffers is boot-fixed and needs a maintenance-window bounce"
		}
	case mr <= b.DownRatio:
		d.MemDir = Down
		d.NewMemLimBytes = clamp(s.MemLimBytes-b.MemStepBytes, b.MinMemBytes, b.MaxMemBytes)
		// Safety: never shrink the memory limit below current usage (would risk an
		// immediate OOM). Hold the limit at/above the observed working set.
		if d.NewMemLimBytes < s.MemUsageBytes {
			d.NewMemLimBytes = s.MemLimBytes
			d.MemDir = Hold
		}
	}
	// Keep the memory limit at/above the (fixed) request — req <= lim invariant.
	if d.NewMemLimBytes < s.MemReqBytes {
		d.NewMemLimBytes = s.MemLimBytes
		d.MemDir = Hold
	}
	d.ChangeMem = d.NewMemLimBytes != s.MemLimBytes

	return d
}
