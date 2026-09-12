# EKS bun-exec bench — file-manager single-executable (vinext `bun build --compile`)

Measured on a **healthy** AWS EKS cluster (the point of the exercise: OKE's numbers were
taken on a CPU-request-saturated cluster and were not trustworthy).

## Cluster
- EKS 1.31, `eu-west-1`, 2× **t3.xlarge** (burstable), spot. Knative Serving + Kourier v1.18.
- App: `knext-file-manager-bunexec` (compiled bun single-exec, `/app/server`), Knative Service,
  `min-scale: 0`, `max-scale: 1`, image pre-cached on node (every scale-up event logged
  `already present on machine` — zero pull cost in all measurements).

## Cold start (scale-from-zero → first response, client-measured)
| trial | ms |
|------|-----|
| 1 | 1811 |
| 2 | 2910 |
| 3 | 2442 |
| 4 | 2090 |
| 5 | 2065 |
| phase-run A | 1644 |
| phase-run B | 2332 |

**Median ≈ 2.2s.** Beats OKE-saturated 3401ms; **not** sub-second.

### Where the ~2s goes (instrumented, one pod)
```
:34.0  pod created + scheduled (instant)
:35.0  containers started         ~1s : sandbox / VPC-CNI pod-IP + container create
:35.6  bun app LISTENING:3000     app bound ~0.6s after container start
:35.9  app self-warm /api/health = 352ms (first-hit route compile)
```
- **The bun app is not the cold-start cost** — it is listening + self-warmed within ~1s of the
  container starting. Image caching is already fully in effect and does **not** move the number.
- The ~2s is **platform + node**: Knative activator scale-up + pod schedule/network + container
  create. Two EKS-specific taxes: **t3 burstable CPU** throttling container/queue-proxy/bun start,
  and **VPC-CNI** per-pod ENI-IP setup.
- Tunable found: queue-proxy readiness probe `period=10s, failureThreshold=3` → the k8s `Ready`
  condition can lag ~30s (the activator routes faster, so the client is unaffected, but it is sloppy).

### Reconciling the GKE sub-second (~600ms cold / ~500ms warm) memory
Consistent with the app boot measured here (<1s, self-warm 352ms). The EKS delta is ~1.4s of
**platform tax** (burstable node + VPC-CNI), **not** image caching and **not** knext. A non-burstable
node (`c6i`/`c7i`) is expected to close most of the gap — untested here.

## Warm throughput (single pod, `/api/health`)
| concurrency | rps | p50 | p90 | p99 |
|---|---|---|---|---|
| 50  | 631  | 77ms  | 86ms  | 112ms |
| 250 | 1143 | 205ms | 265ms | 426ms |

- At C=50 the run is **RTT-bound** (remote client → eu-west-1 ≈ 75ms), not app-bound: 50/0.077 ≈ 650.
- At C=250 the single warm pod sustains **1143 rps**, essentially matching the **local 1103 rps** —
  the compiled bun exec performs the same on EKS as locally. Per-pod ceiling; Knative autoscaling
  (`max-scale > 1`) multiplies it.

## Node-type retest — c6i.xlarge (non-burstable) vs t3.xlarge (burstable)
Same cluster, added a `c6i.xlarge` node group, cordoned the t3 nodes, pre-warmed the image on c6i
(so pull cost stays zero), re-ran N=7.

| node | median | mean | min | max |
|------|--------|------|-----|-----|
| t3.xlarge (burstable)   | ~2090ms | ~2264ms | 1811 | 2910 |
| **c6i.xlarge (non-burstable)** | **1398ms** | **1545ms** | **1331** | 2146 |

- **~700ms / 33% faster on c6i** — the burstable-CPU throttling of container-create + queue-proxy +
  bun boot was a real contributor, now confirmed by measurement (not projected).
- Still **~1.4s, not sub-second**: node type removes the CPU-throttle share, but the residual is the
  **platform layer** — VPC-CNI per-pod IP setup + Knative activator scale-up/buffer + readiness
  gating — which a faster node does not touch. Closing the rest toward GKE's ~600ms would require
  attacking that layer (or the GKE figure was measured from a warmer state).

## Bottom line
- knext's own contribution (bun single-exec) is sub-second cold and ~1100 rps/pod warm on both
  EKS and local — parity confirmed.
- The EKS cold-start penalty vs GKE is the **cluster/node**, not knext: burstable t3 + VPC-CNI.
  Retest on a compute-optimized node group before attributing cold-start cost to the runtime.

> Teardown: `eksctl delete cluster --name knext --region eu-west-1` stops billing.
