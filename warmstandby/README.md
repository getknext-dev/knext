# Neon warm-standby wake prototype (iteration-3 evidence B)

*Namespace `scale-zero-pg`. This directory is self-contained: it never modifies
`deploy/`, `gateway/`, `bakeoff/` (except adding one results CSV), or `docs/`.
The production wake path is untouched — this adds a **separate** `compute-warm`
deployment, scaled 0/1 by the harness only, and restored to nothing when done.*

## The question

The ADR-0002 deferral asks: **how far can Neon's cold wake (measured p50 ≈ 3.7s
via `bakeoff/_measure.sh`) drop toward sub-second with a warm-standby?**

### The 3.7s cold-wake breakdown (known, from the task brief)

| Phase | ~cost | Removed by a warm pod? |
|---|---|---|
| kubelet pod sandbox + container start | ~2 s | **yes** — pod already running |
| init container (wait-timeline) | ~0.5–1 s | **yes** — already passed |
| compute_ctl attach (its own `total_startup_ms`) | ~150 ms | no — intrinsic |
| readiness probe period + gateway orchestration | rest | partly |

A warm-standby pays the pod-creation cost **once, up front**, and holds the pod
Running-but-not-attached. Wake then skips straight to the intrinsic floor:
compute_ctl attach + first probe.

## Design A: GATED POD (what this prototypes)

A separate `compute-warm` Deployment runs the **stock compute image** with one
change: a **gated entrypoint** (`10-compute-warm-files.yaml`). It renders the
compute spec exactly as the production entrypoint does, then prints a sentinel
(`WARM_GATE_WAITING`) and **blocks on a gate file** before exec'ing
`compute_ctl`. So the pod is fully scheduled and running — RAM reserved — but
postgres has **not** attached to the timeline. This is a **warm-RAM tier**, not
a zero tier.

**Wake** = create the gate file (`kubectl exec … touch /tmp/go`). The entrypoint
unblocks and `compute_ctl` attaches. All pod mechanics (sandbox, image pull,
init container) already happened, so they are excluded from the wake.

`config.json` is **reused** from the existing `compute-files` ConfigMap (mounted
at `/compute-files`) — the spec never drifts from `deploy/`. Only the entrypoint
is overlaid (mounted at `/warm`).

### Single-writer invariant (sacred)

Neon is single-writer per timeline. `compute` and `compute-warm` attach to the
**same** timeline, so they must **never** be attached simultaneously. The harness
enforces this:
- `assert_single_writer` verifies `deploy/compute` replicas == 0 **and** zero
  compute pods (Terminating included) **before every gate release**.
- The gated pod is safe while gated — `compute_ctl` is not running, so it holds
  no timeline lock until the gate opens.
- Between samples the warm pod is scaled to 0 and fully drained.

## Files

```
warmstandby/
  10-compute-warm-files.yaml   ConfigMap: gated entrypoint.sh (overlay only)
  20-compute-warm.yaml         Deployment compute-warm (replicas 0) + Service
  30-warm-client.yaml          in-cluster psql client pod
  _measure.sh                  wake harness: arm gate → release → time SELECT
  _cleanup.sh                  restore resting state (idempotent)
  README.md                    this file (+ results appended below)
```

## Reproduce

```sh
export PATH="$HOME/.orbstack/bin:$PATH"
kubectl apply -f warmstandby/10-compute-warm-files.yaml \
              -f warmstandby/20-compute-warm.yaml \
              -f warmstandby/30-warm-client.yaml
kubectl -n scale-zero-pg scale deploy/compute --replicas=0   # single-writer
N=20 sh warmstandby/_measure.sh
sh warmstandby/_cleanup.sh                                    # restore
sh deploy/_verify-wake.sh                                     # prove normal path still works
```

## Measurement method (honest accounting)

- **wake_ms (headline)** = host-timed from gate release (`kubectl exec touch`) to
  the first `psql SELECT` that returns, direct to the warm pod on `:55433` (no
  gateway — cleaner for the experiment). This **includes** the kubectl-exec
  trigger cost and the psql-poll granularity (0.1 s), which a production gate
  (design B, compute_ctl HTTP API) would avoid.
- **kubectl-exec baseline** = one round-trip `kubectl exec … true`, measured
  once, so wake_ms can be decomposed.
- **compute_ctl_startup_ms** = compute_ctl's own `total_startup_ms` log — the
  intrinsic, exec-overhead-free attach cost (the true floor of design A).

<!-- RESULTS_APPENDED_BELOW -->
