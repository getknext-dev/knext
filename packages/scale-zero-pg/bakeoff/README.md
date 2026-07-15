# Foundation bake-off: self-hosted Neon vs CloudNativePG-hibernation

*Phase 3B of `docs/plan-phase3.md`. Owner: architect-reviewer. Scope is confined
to this directory and the k8s namespace `bakeoff-cnpg`. The Neon foundation
(namespace `scale-zero-pg`) is read-only here — we only point the harness at its
gateway.*

## Why this exists

The architect review found the storage foundation was **"decided by inheritance"**
from the original architecture doc — self-hosted Neon's disaggregated storage
plane was adopted without a measured comparison against the lighter path that is,
notably, the consumer platform (knext)'s **own default**: CloudNativePG. This
bake-off replaces that inheritance with numbers. It stands the **same gateway
binary** in front of a CNPG cluster and measures both foundations on one ruler.

The claim under test (from the review): *the same Go wake-gateway fronts either
foundation; only the storage substrate — and its wake mechanism — changes.*

## The two foundations

| | **Neon (incumbent)** | **CNPG-hibernation (candidate)** |
|---|---|---|
| Namespace | `scale-zero-pg` (read-only here) | `bakeoff-cnpg` |
| Storage | Disaggregated: safekeeper ×3 + pageserver + broker + MinIO | One PVC attached to the primary pod |
| Compute | Stateless Neon compute Deployment `replicas 0↔1` | CNPG-managed Postgres pod, hibernated 0↔1 |
| Wake means | scale 0→1 + **attach + lazy page fetch** (no restore) | un-hibernate = pod (re)schedule + **PVC attach** + PG start |
| Sleep means | gateway scales Deployment → 0 | gateway sets `cnpg.io/hibernation: on` → operator deletes pod, keeps PVC |
| Gateway mode | `kubectl` (scale subresource) | `exec` (`kubectl annotate` toggles hibernation) |
| Gateway image | `scale-zero-pg/gateway:dev` (distroless) | `scale-zero-pg/gateway-exec:dev` — **byte-identical `/gateway`** re-based to add `sh`+`kubectl` (see `gateway-exec.Dockerfile`) |

## Measurement protocol

### Ruler (identical for both — `_measure.sh`)
One in-cluster psql client pod times `connect + SELECT` through the gateway DSN.
Same timer, same probe query, same client pod, same percentile math for both
foundations. The **only** per-foundation difference is the `COLD_CMD` that forces
a cold target — because "how you go cold" is intrinsic to each foundation, not to
the measurement.

- **Neon** cold: wait for the gateway's idle window to scale compute to 0
  (`kubectl -n scale-zero-pg get deploy compute` → `replicas 0`), then connect.
- **CNPG** cold: `kubectl -n bakeoff-cnpg annotate cluster/pg cnpg.io/hibernation=on`,
  wait for `pods=0`, then connect (the gateway un-hibernates on connect).

### Latency dimensions (target: **20+ samples each** for the full run)
1. **Cold wake** — target at zero → first `connect+SELECT` returns. The headline.
2. **Warm** — target already up → `connect+SELECT`. Isolates steady-state overhead.
3. **Reconnect-after-drain** — connect, let it go cold, reconnect. Models a
   bursty app (knext pool idling below `GW_IDLE_MS`).

Report `min / p50 / p95 / p99 / max` in ms per dimension per foundation. Raw
samples are written to `bakeoff/results/<label>-<stamp>.csv` so runs are auditable.

### Failure drills (data survival — the reliability axis)
- **CNPG:** hibernate (pod deleted, PVC kept) → un-hibernate → row count intact.
  Also: delete the primary pod outright → operator reschedules on the same PVC →
  rows intact.
- **Neon:** kill the compute pod (no volume) → fresh pod re-attaches to
  tenant/timeline → rows intact (already proven in `deploy/_verify-storage.sh`).
- Pass = the seeded one-table dataset (`t`, 3 rows) survives every cycle with no
  restore step.

### Ops-mass inventory (the "easy to host/maintain" axis)
For each foundation, count what you must operate:

| Axis | Neon | CNPG |
|---|---|---|
| Distinct workloads on the data path | compute + safekeeper×3 + pageserver + broker + MinIO + storage-init Job | 1 CNPG operator + 1 Cluster (1 pod) |
| Container images to track/pin | ≥3 (compute-node, neon, minio) + version-compat matrix | 2 (operator, postgresql) |
| PVCs | pageserver + safekeepers + MinIO | 1 (per instance) |
| Bespoke wiring | storage-init Job, compute ConfigMaps, CoreDNS negative-cache fix | operator-managed; declarative hibernation annotation |
| Upgrade unit | compute/pageserver/safekeeper protocol compat (Rust internals) | operator handles rolling PG upgrades |
| Expertise needed | operate a disaggregated Rust storage system | operate a widely-run PG operator |

### What each foundation *loses* (be honest)
- **CNPG loses:** Neon's size-independent sub-second lazy-fetch wake (it pays pod
  reschedule + PVC attach every cold start); free copy-on-write **branching**;
  native **PITR**-to-any-LSN; cheap read replicas that share one pageserver.
- **Neon loses:** simplicity. It trades a single well-understood PVC for a
  distributed storage cluster its sole consumer's docs call *"unsupported for
  production"*; it carries a compute/storage version-compat matrix and needs
  Rust/Neon-internals skill to debug.

## Layout

```
bakeoff/
  README.md                     this protocol
  _measure.sh                   the ruler (both foundations)
  _verify-wake.sh               end-to-end gate: cold wake through the gateway returns rows
  gateway-exec.Dockerfile       byte-identical gateway binary + sh + kubectl
  gateway-exec-mode.yaml        SA/Role/Deployment/Service — gateway in exec mode
  cnpg/
    operator-cnpg-1.29.2.yaml   vendored CNPG operator (pinned)
    cluster.yaml                1-instance Cluster + 1Gi PVC
    app-secret.yaml             dev creds app/app
  results/                      raw sample CSVs
```

## Reproduce

```sh
export PATH="$HOME/.orbstack/bin:$PATH"   # OrbStack ships kubectl/docker

# 1. CNPG operator + cluster + seed
kubectl create namespace bakeoff-cnpg
kubectl apply --server-side -f bakeoff/cnpg/operator-cnpg-1.29.2.yaml
kubectl apply -f bakeoff/cnpg/app-secret.yaml -f bakeoff/cnpg/cluster.yaml

# 2. exec-mode gateway (identical binary, re-based)
docker build -f bakeoff/gateway-exec.Dockerfile -t scale-zero-pg/gateway-exec:dev .
kubectl apply -f bakeoff/gateway-exec-mode.yaml

# 3. gate + measure
sh bakeoff/_verify-wake.sh
LABEL=cnpg COLD_CMD='kubectl -n bakeoff-cnpg annotate --overwrite cluster/pg cnpg.io/hibernation=on; \
  for i in $(seq 1 30); do [ "$(kubectl -n bakeoff-cnpg get pods -l cnpg.io/cluster=pg --no-headers|grep -c .)" = 0 ] && break; sleep 1; done' \
  N=20 sh bakeoff/_measure.sh
```

## Status

Scaffold proven (initial 5-sample iteration): see `results/` and the completion
note in the phase-3B section of `docs/plan-phase3.md`. Full 20+ sample runs and
the warm / reconnect-after-drain dimensions are the next iteration.
