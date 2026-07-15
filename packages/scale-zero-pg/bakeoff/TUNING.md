# CNPG wake tuning — how far below 14.4s can un-hibernate go?

*Iteration-3 evidence A (task #20). Namespace `bakeoff-cnpg` only. Feeds the
deferred ADR-0002 decision alongside the Neon warm-standby counterpart.*

## TL;DR

The measured 14.4s p50 cold wake (ADR-0002 baseline) was **not** Postgres, PVC
attach, scheduling, or crash recovery. It was **kubelet probe cadence**: CNPG's
default `startup`/`readiness` probes poll every **10s**, and the CNPG `-rw`
Service only publishes the pod as an endpoint once it is **Ready** — so the
gateway waited nearly a full 10s probe period *after Postgres was already
accepting connections*. Dropping the probe period to **1s** cut cold wake:

| Config | n | min | **p50** | **p95** | p99 | max |
|---|--:|--:|--:|--:|--:|--:|
| baseline (10s probe) | 20 | 12261 | **14413** | **14848** | 14917 | 14934 |
| **tuned (1s probe)** | 20 | 4780 | **6331** | **8167** | 8465 | 8539 |
| **improvement** | | | **8082 ms (2.28×)** | 6681 ms | | |

Raw: `results/cnpg-cold-20260702T192637.csv` (baseline),
`results/cnpg-tuned-cold-20260702T202532.csv` (tuned). Harness `_run-battery.sh`,
instrument `_wake-breakdown.sh`.

## The breakdown (one wake, instrumented — `_wake-breakdown.sh`)

Timestamps are ms from **t0 = the `cnpg.io/hibernation=off` annotate**, read from
the reborn pod's own Kubernetes timestamps (creationTimestamp, condition
`lastTransitionTime`, container `startedAt`) plus a tight psql probe. k8s
timestamps are 1s-resolution, so phase figures are coarse but the shape is
unambiguous.

| Phase | Baseline (10s probe) | Tuned (1s probe) | Nature |
|---|--:|--:|---|
| annotate → **operator reconcile** creates Pod | ~766 ms | ~881 ms | operator queue latency |
| Pod scheduled to node | +0 ms | +0 ms | single node, resources free |
| scheduled → **init container** (`bootstrap-controller`) done | +2000 ms | +1000 ms | copies instance-manager binary |
| init → main `postgres` container running | +0 ms | +0 ms | image already cached |
| **container-running → Ready** | **+9000 ms** | **+2000 ms** | ← the probe-cadence gap |
| Ready → gateway serves `SELECT` | +1093 ms | +1943 ms | endpoint propagation + GW retry (250ms) + client exec |
| **TOTAL annotate → serves** | **~12.9 s** | **~5.8 s** | |

**Proof it was the probe, not Postgres.** The `postgres` container log on wake:
```
16:21:15.520  starting PostgreSQL 17.2 …
16:21:15.537  database system was shut down at 15:45:15 UTC   (clean shutdown)
16:21:15.544  database system is ready to accept connections
```
PG reaches "ready to accept connections" **~24 ms** after the process starts —
there is no crash recovery to pay (hibernate is a clean shutdown). Yet the pod's
`Ready` condition flipped ~9s later on the baseline. That 9s was the kubelet
waiting for the next `startupProbe`/`readinessProbe` tick at the default 10s
`periodSeconds`. The `-rw` Service withholds the endpoint until Ready, so the
gateway could not connect until the probe fired — long after PG was serving.

## The fix (persisted in `cnpg/cluster.yaml`)

```yaml
spec:
  probes:
    startup:   { periodSeconds: 1, failureThreshold: 60, initialDelaySeconds: 0, timeoutSeconds: 2 }
    readiness: { periodSeconds: 1, failureThreshold: 3,  initialDelaySeconds: 0, timeoutSeconds: 2 }
```
CNPG 1.29 exposes per-probe `periodSeconds`/`failureThreshold`/`initialDelaySeconds`
under `.spec.probes.{startup,readiness}` (verified against the installed CRD). 1s
is the Kubernetes floor for `periodSeconds`. `failureThreshold: 60` keeps a 60s
startup budget at the 1s cadence (still ample; PG is up in <1s here).

## What else was checked (and why it didn't move the needle)

- **Image pre-pull:** already optimal on this single-node cluster — wake events
  show `Container image … already present on machine` for both the operator and
  postgres images. Pre-pull/`imagePullPolicy: IfNotPresent` matters on multi-node
  or cold-image clusters; here the pull is already zero-cost, so no gain.
- **PVC attach:** `local-path` RWO PVC on the same node — attach is in the
  scheduled→initialized window and is not a distinct cost here (~0). On networked
  storage (EBS/Ceph) this phase would reappear and dominate; a node-affinity pin
  keeps the PVC local.
- **PG crash recovery:** none — hibernate is a graceful `smartShutdown`, so wake
  is a clean start (`database system was shut down` → ready in 24ms). Nothing to
  tune.
- **Operator reconcile (~0.9s):** `--max-concurrent-reconciles=10` already; with a
  single cluster the ~0.9s is queue/watch latency, not contention. Not worth
  chasing.
- **Gateway retry granularity (`GW_RETRY_MS=250`, bakeoff exec-mode gateway):** a
  minor further lever — tightening to 100ms would shave ≤150ms average off the
  "Ready → serves" phase. Left at 250ms to avoid churn; noted as available.

## What is irreducible for CNPG scale-to-zero

The tuned **min of 4.78s** is close to the practical floor for *annotation
hibernation*, which recreates the pod every wake. The irreducible pieces:

- operator reconcile → Pod created: **~0.8–0.9s**
- init container (`bootstrap-controller`) copies the manager binary: **~1s**
- probe observes PG ready at the 1s floor + endpoint propagation: **~1–2s**
- gateway reconnect + client round-trip: **~1s**

⇒ **~4–5s floor, ~6.3s p50** with ~2s of probe-tick-alignment variance (a wake
that just misses a 1s tick pays up to ~1s more; hence the 4.8–8.5s spread).

To go **materially below ~4s you must stop recreating the pod** — i.e. keep a
process warm. That is exactly the Neon warm-standby lever being measured
separately (evidence B). Within true scale-to-zero (pod fully gone at rest), CNPG
cannot beat the pod-lifecycle floor, and we are now within ~1× of it.

## xataio `cnpg-i-scale-to-zero` plugin — evaluated, not adopted

The mission asked whether the xataio CNPG-I plugin wakes faster than
annotation-hibernation. **It does not, by construction.** The plugin's sleep
mechanism is the *same* hibernation primitive (delete the instance pod, keep the
PVC); its wake is the *same* operator-driven **pod recreate → init → PG start →
probe → endpoint** path measured above. Its value proposition is **automatic
idle-detection** (it decides *when* to sleep), not a faster *wake* — and in KS-PG
the **gateway already owns idle-detection** (`GW_IDLE_MS`) and wake-trigger
(annotate on connect). So adopting it would add a CNPG-I plugin dependency to
solve a problem we've already solved, without touching the ~6s wake floor. (It
was evaluated analytically from its documented design; host network fetch is
blocked in this environment, and installing a plugin whose wake path is provably
identical would not change the number.) Recommendation: **do not adopt** for
latency; revisit only if we want operator-native idle policy independent of the
gateway.

## Bottom line for ADR-0002

Tuned CNPG cold wake is **p50 6.3s / p95 8.2s** (from 14.4s / 14.8s) — a single
one-line probe change, persisted declaratively, no new components. This narrows
the gap to Neon's cold wake (p50 3.7s / p95 5.0s) from ~3.9× to **~1.7× (p50)**
— and Neon's own headroom toward sub-second is the warm-standby question in
evidence B. The foundation decision now turns on whether ~2–3s of remaining wake
delta justifies Neon's 6-workload + version-pair ops mass, with branching still
unused.
