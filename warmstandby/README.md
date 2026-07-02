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

## Results (run `20260702T202721`, N=20, orbstack)

Raw: [`bakeoff/results/neon-warmstandby-20260702T202721.csv`](../bakeoff/results/neon-warmstandby-20260702T202721.csv).
Every sample returned `count(*) FROM t = 3` — i.e. a **real lazy page-fetch
attach**, not just a TCP accept. `ok=20/20`.

### Headline: **sub-second reached — YES.**

| Metric | min | **p50** | p95 | p99 | max |
|---|---|---|---|---|---|
| **wake_ms** (gate release → first SELECT, incl. exec+poll overhead) | 206 | **413** | 558 | 586 | 593 |
| wake_ms − kubectl-exec baseline (115 ms) — est. floor incl. psql poll | — | ~298 | ~443 | — | — |
| **compute_ctl attach** (`total_startup_ms`, exec-overhead-free) | 110 | **165** | 309 | — | 314 |

Baseline for comparison: production **cold** wake p50 ≈ **3.7 s**
(`bakeoff/_measure.sh`); a same-session `deploy/_verify-wake.sh` cold wake right
after this run measured **3420 ms** gateway latency. Warm-standby p50 **413 ms**
is a **~9× reduction** and comfortably under 1 s at every percentile measured.

### The floor

The intrinsic floor of design A is **`compute_ctl` attach ≈ 150 ms p50**
(min 110 ms) + the client connect/probe. Everything above that in the 413 ms
headline is measurement overhead a production trigger would shed:
- kubectl-exec trigger (~115 ms, one round-trip to touch the gate file),
- psql poll granularity (0.1 s) + the client's own psql/TLS-decline connect.

So the **practical floor for this design is ~150–300 ms**; a
gateway-integrated trigger (design B's compute_ctl HTTP `/configure`, no
`kubectl exec`) would land nearer the ~150 ms attach cost. **Sub-100 ms is not
reachable** here — `compute_ctl` must still attach to the pageserver, open the
safekeeper connections, and start Postgres accepting.

## Honest trade-off table

| Axis | Cold scale-to-zero (`deploy/compute`) | **Warm-standby (design A, this dir)** |
|---|---|---|
| Wake p50 | ~3.7 s | **~413 ms** (floor ~150 ms) |
| Wake p95 | ~seconds | **558 ms** |
| RAM held while "asleep" | **0** (no pod) | **256 MiB reserved** (scheduler request); actual RSS gated ≈ **4.8 MiB** |
| CPU held while asleep | 0 | 250 m **reserved** (request); actual ≈ idle shell |
| True scale-to-**zero**? | **yes** | **no** — this is a warm-**RAM** tier |
| Cost model | pay per wake | pay to keep 1 pod parked 24/7 |
| Added complexity | none (base case) | +1 deployment, +1 gate mechanism, +arming/draining orchestration |
| Single-writer risk | low (Recreate, one deployment) | **elevated** — two deployments target one timeline; safe ONLY behind the `assert_single_writer` gate (compute==0 & drained before every release). A bug that releases the gate while `compute` is up = **two writers on one timeline = corruption**. |
| Multi-tenant future | n/a | design A is single-tenant (pod pre-bound to one tenant/timeline via env). A true pool needs **design B** (empty compute_ctl + attach-on-wake via HTTP). |

### Interpretation for ADR-0002

- Neon's wake is **not fundamentally 3.7 s** — ~3.5 s of it is pod-creation
  machinery, removable by parking a pod. The disaggregated storage attach itself
  is **~150 ms**. This is Neon's structural advantage: *size-independent*
  sub-second attach with no PVC to mount and no data to restore.
- The cost is a **warm-RAM tier**: 256 MiB + 250 m CPU reserved per parked pod,
  24/7. That is a genuine spend, not free scale-to-zero. It buys a ~9× faster
  wake for the *first* connection after idle.
- **Recommended framing:** offer scale-to-zero (cold, ~3.7 s, RAM=0) as default
  and warm-standby (~0.4 s, RAM=256 MiB) as an opt-in tier for latency-sensitive
  consumers — not a replacement. The single-writer gate is non-negotiable and
  belongs in the gateway if this is productionized.
- **Next step if pursued:** design B (attach-on-wake to a spec-less running
  compute_ctl via its `:3080` HTTP API) turns the parked pod into a true
  *multi-tenant pool* and removes the kubectl-exec trigger — the seam where SCS
  multi-tenancy returns. Not prototyped here (design A hit sub-second cleanly).

### Reversibility

`_cleanup.sh` deletes `compute-warm`, its ConfigMap, and `warm-client`, and
leaves `deploy/compute` at 0. Verified post-run: `deploy/_verify-wake.sh` passes
the full 0→1→0→1 loop (cold wake 3420 ms), so the production path is intact.

