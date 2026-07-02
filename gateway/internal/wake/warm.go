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

// Wake enforces single-writer, then opens the gate. STUB.
func (d *warmDriver) Wake(ctx context.Context, _ Target) error {
	return fmt.Errorf("warmpool Wake: not implemented")
}

// Sleep closes the gate and deletes the warm pod (re-park). STUB.
func (d *warmDriver) Sleep(ctx context.Context, _ Target) error {
	return fmt.Errorf("warmpool Sleep: not implemented")
}

// AttachMetrics wires the gate's state gauge. STUB.
func (d *warmDriver) AttachMetrics(s GateStateSink) {}

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
