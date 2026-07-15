package wake

import (
	"context"
	"fmt"
)

// WarmOps is the Kubernetes surface the warmpool driver needs beyond scaling:
// read the cold deployment's desired replicas, count live pods by label
// (Terminating included), and delete pods by label (re-park the warm pod).
type WarmOps interface {
	Replicas(ctx context.Context, namespace, deployment string) (int32, error)
	CountPods(ctx context.Context, namespace, selector string) (int, error)
	DeletePods(ctx context.Context, namespace, selector string) (int, error)
}

// GateStateSink receives gate open/close transitions (satisfied by *metrics.Metrics).
type GateStateSink interface{ SetGateOpen(bool) }

// warmDriver productizes the warm-standby tier (ADR-0002, replacing the shell
// harness). The compute is a gated pod that blocks on the gateway's gate port
// before attaching compute_ctl; waking = open the gate, sleeping = close it and
// delete the warm pod so the Deployment respawns a freshly-parked one.
//
// Single-writer is enforced in-band: Wake REFUSES to open the gate unless the
// cold `compute` deployment is fully drained (0 desired replicas AND 0 pods,
// Terminating included). Two attached computes on one timeline = corruption, so
// the check fails safe (any error/doubt => refuse).
type warmDriver struct {
	t            Target
	namespace    string
	coldDeploy   string
	coldSelector string
	warmSelector string
	gate         gateCtl
	ops          WarmOps
}

func (d *warmDriver) Mode() string          { return "warmpool" }
func (d *warmDriver) Resolve(string) Target { return d.t }
func (d *warmDriver) CanSleep() bool        { return true }

// Wake enforces the single-writer invariant, then opens the gate so the parked
// warm pod attaches. The check fails safe: any error, non-zero cold replicas, or
// any lingering cold pod (Terminating included) REFUSES the gate — never risk two
// computes attached to one timeline.
func (d *warmDriver) Wake(ctx context.Context, _ Target) error {
	replicas, err := d.ops.Replicas(ctx, d.namespace, d.coldDeploy)
	if err != nil {
		return fmt.Errorf("warmpool single-writer check: reading %s replicas: %w", d.coldDeploy, err)
	}
	if replicas != 0 {
		return fmt.Errorf("warmpool refusing gate (single-writer): cold %s has replicas=%d, must be 0", d.coldDeploy, replicas)
	}
	pods, err := d.ops.CountPods(ctx, d.namespace, d.coldSelector)
	if err != nil {
		return fmt.Errorf("warmpool single-writer check: listing cold pods (%s): %w", d.coldSelector, err)
	}
	if pods != 0 {
		return fmt.Errorf("warmpool refusing gate (single-writer): %d cold %s pod(s) still present (Terminating holds the timeline)", pods, d.coldDeploy)
	}
	return d.gate.Open()
}

// Sleep closes the gate FIRST (a closed gate re-parks any respawned pod on its
// next probe, so it is the fail-safe even if the delete errors), then deletes
// the warm pod so the Deployment respawns a freshly-gated one.
func (d *warmDriver) Sleep(ctx context.Context, _ Target) error {
	if err := d.gate.Close(); err != nil {
		return fmt.Errorf("warmpool closing gate: %w", err)
	}
	if _, err := d.ops.DeletePods(ctx, d.namespace, d.warmSelector); err != nil {
		return fmt.Errorf("warmpool deleting warm pod (%s): %w", d.warmSelector, err)
	}
	return nil
}

// AttachMetrics wires the gate's open/close transitions to a gauge sink and
// pushes the current (closed) state immediately.
func (d *warmDriver) AttachMetrics(s GateStateSink) {
	d.gate.SetOnState(s.SetGateOpen)
	s.SetGateOpen(d.gate.IsOpen())
}

// newWarmDriver builds a warmpool driver from env with injected ops + gate.
func newWarmDriver(env Env, ops WarmOps, gate gateCtl) *warmDriver {
	ns := env.get("GW_K8S_NAMESPACE", "scale-zero-pg")
	warmDeploy := env.get("GW_WARM_DEPLOYMENT", "compute-warm")
	coldDeploy := env.get("GW_WARM_COLD_DEPLOYMENT", "compute")
	defPort := 55433
	host, port := ParseHostPort(env.get("GW_TARGET", fmt.Sprintf("%s.%s.svc:55433", warmDeploy, ns)), defPort)
	return &warmDriver{
		t:            Target{Host: host, Port: port, Key: ns + "/" + warmDeploy},
		namespace:    ns,
		coldDeploy:   coldDeploy,
		coldSelector: env.get("GW_WARM_COLD_SELECTOR", "app="+coldDeploy),
		warmSelector: env.get("GW_WARM_SELECTOR", "app="+warmDeploy),
		gate:         gate,
		ops:          ops,
	}
}
