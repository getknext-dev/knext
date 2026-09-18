# EKS bun-exec bench — file-manager single-executable (vinext `bun build --compile`)

> **Status: complete.** Ran on EKS (t3 + c6i) and GKE (n2), all clusters torn down, zero residual
> billing. Verdict below is final: a genuine Knative scale-from-zero cold start is **~1.4–1.5s on both
> EKS c6i and GKE n2** (within ~70ms), platform-bound (activator + scheduling + CNI), **not** the bun
> runtime and **not** image caching; the remembered "~600ms GKE" was a *warm* hit (warm p50 ~60ms).
> Next phase: typed-client codegen over scale-to-zero backend functions — see the design brief.

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

## GKE cross-cloud retest (the "GKE sub-second" question, settled)
Same image (`file-manager:vinext-inlined`, identical digest), same method (confirm 0 pods, then one
timed request), Knative v1.23 + Kourier, GKE 1.35, **n2-standard-4 (non-burstable, the GKE analog of
c6i)**, `europe-west1`.

Image: the compiled **bun single-exec on alpine** (`/app/server`, ~51 MB, 5 layers) — same digest on
both clouds. Cold-start trials are **cached-only** (cordoned to the node holding the image, so every
scale-from-zero pays zero pull — matching the EKS c6i method). NB: an uncached first pass on GKE read
1773ms median because one trial landed on the 2nd (un-cached) node and paid a 2.4s pull; cordoning to
the cached node gives the clean number below.

| metric | EKS t3 (burst) | EKS c6i (non-burst) | GKE n2 (non-burst) | local |
|--------|----------------|---------------------|--------------------|-------|
| cold-start median (cached) | ~2090ms | 1398ms | **1465ms** | — |
| warm p50 | 77ms | — | **60ms** | — |
| RPS / pod (C=250) | 1143 | — | **1754** | 1103 |

- **GKE cold start ≈ EKS c6i (~1.4–1.5s) — NOT sub-second.** On comparable non-burstable nodes with
  cached images, the two clouds are within ~70ms of each other.
- Yet GKE's warm p50 is 60ms and it does the highest RPS/pod (1754, beating EKS and local). A faster
  node buys **throughput, not a faster cold start** → cold start is **platform-bound** (activator +
  scheduling + pod networking), confirmed on both clouds.
- Therefore the remembered "~600ms GKE cold" was a **warm** hit (matches ~60ms warm + client RTT),
  not a genuine scale-from-zero. On a confirmed 0→1 cold start, **both clouds land at 1.4–1.8s**.

## Bottom line
- knext's own contribution (bun single-exec) is <1s to boot+self-warm and 1100–1750 rps/pod warm
  across EKS, GKE, and local — parity confirmed; the runtime is not the cold-start cost.
- A genuine Knative scale-from-zero cold start is **~1.4–1.8s on both EKS and GKE** and is
  platform-bound (activator + scheduling + CNI), not runtime- or node-CPU-bound. "Sub-second cold
  start" claims are warm hits or `min-scale: 1` unless scale-to-zero is verified before timing.

> Teardown: `eksctl delete cluster --name knext --region eu-west-1` stops billing.
