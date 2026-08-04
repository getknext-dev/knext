# Image prewarm on a live cluster — OKE (2026-08-04)

Status: point-in-time measurement · Runs: 2026-08-04 (run 1 — **invalid, withdrawn**, see the
correction below; run 2 — the reported data) · Target: a `NextApp` on OKE, 2 nodes, Kubernetes
1.33.10, cri-o 1.33.10, pulling from a same-region OCIR registry · Harness:
[`benchmarks/image-prewarm-oke/`](../../benchmarks/image-prewarm-oke/)

This is the measurement ADR-0037 left open and that the earlier round deliberately refused to fake:
**does `spec.scaling.imagePrewarm` actually take the image pull off a cold scale-from-zero, and what
is it worth?** It is not assertable on kind — kind side-loads images into every node's containerd, so
"no `Pulling` event" is trivially true there whether or not the prewarmer works.

> **It found a defect before it found a number.** With the operator as merged, the prewarm DaemonSet
> **CrashLoopBackOff'd on every node** against an Alpine-based app image: the pinned busybox helper
> was the *glibc* (dynamically linked) variant, so the staged binary could not exec inside the app
> image. `ImageCacheReady` sat at `False/Pulling` while `Ready` stayed `True`. The numbers below were
> taken **after** repinning the helper to a static (`-uclibc`) busybox. See
> [the defect](#the-defect-found-first) and ADR-0037's 2026-08-04 amendment.

## Environment

- **Cluster:** OKE, 2 worker nodes (Oracle Linux 8.10, 1830m allocatable CPU each), Kubernetes
  1.33.10, **cri-o** 1.33.10, Knative Serving with Kourier.
- **Registry:** OCIR in the cluster's own region, pulled with the app ServiceAccount's
  `imagePullSecrets`. Pull cost here is therefore a *same-region* pull — a cross-region or
  Docker-Hub-rate-limited pull is worse, not better.
- **App:** one `NextApp` (`spec.scaling.minScale: 0`, `maxScale: 1`, `cpuRequest: 250m`), image
  **digest-pinned and identical on both arms**: a real knext Next.js standalone app image (the
  `p1b-node` benchmark app, Alpine-based) plus one incompressible 120 MiB pad layer, built in-cluster
  and published under its own repository. Total image size as reported by the kubelet:
  **369,851,685 bytes**.
- **Why a pad layer:** the `off` arm has to be a *real* pull. An image sharing layers with something
  already cached on a node would make that arm mostly local, and evicting an image the benchmark does
  not own would corrupt other work on the cluster. The pad guarantees a content-unique image that only
  this harness has ever pulled.
- **Cluster state, stated because it bounds the numbers:** both nodes were at ~84% of allocatable CPU
  *requests* from pre-existing workloads (the ADR-0036 investigation's leftovers), leaving ~290m free
  per node, and both root filesystems were at 82–83% (the kubelet's image-GC high-water mark is 85%).
  The harness reads node disk every replicate and aborts rather than push the kubelet into evicting
  images it does not own.
- **Operator:** built from the branch under test and run **out-of-cluster** against this cluster
  (`go run ./cmd/main.go` with a kubeconfig pinned to that context), because pushing an operator image
  from this workstation to the in-region registry timed out repeatedly. Cluster state is still authored
  solely by the operator, from the CR (ADR-0001); only the process location differs.

## Method

Per replicate, with **nothing else running against the cluster**:

1. Select the arm **through the `NextApp` CR** (`spec.scaling.imagePrewarm` true/false) and wait for
   the `<app>-imgcache` DaemonSet to be Ready on every node, or to be gone.
2. Wait until the app has **no pods at all** for its active revision.
3. Force the node image cache into the state the arm claims — the `off` arm evicts the app image from
   **every** node — and then **assert** it (`crictl inspecti`). A replicate whose precondition does not
   hold is recorded as failed, never measured.
4. Hold both arms to the same time-at-zero floor (150 s) and record the actual gap, then issue **one**
   request and record TTFB, followed immediately by a second (warm) request as that replicate's own
   baseline — which cancels the ~400 ms client↔cluster RTT.
5. Record what the kubelet did: the pod, its node, and its `Pulling`/`Pulled` events.

**Requested endpoint: `GET /api/health`** (the app's health route, also its readiness probe path).

Arms are **interleaved ABBA within a pair** (prewarm, no-prewarm, no-prewarm, prewarm), 5 pairs → 10
replicates per arm. Sequential A-then-B is not admissible here: a cluster-level slow mode switching on
mid-run has already produced one withdrawn 4.5× result in this repo (ADR-0036 Run 24).

## The defect, found first

With the operator as merged on `main`, enabling `spec.scaling.imagePrewarm` on this cluster produced
a DaemonSet whose pods **never started**:

```
pw-imgcache   2 desired   2 current   0 ready
pin: exit 255, restarts 2 — "exec /knext-pin/busybox: no such file or directory"
NextApp conditions: Ready=True/ReconcileSuccess … ImageCacheReady=False/Pulling
```

The staged helper existed (mode 755, 1,013,320 bytes, ELF x86-64) and could not be exec'd: the pinned
`busybox:1.36.1@sha256:73aaf09…` is Docker's **default** busybox tag, i.e. the **glibc** build, and the
app image is Alpine (musl). Staging the identical way from `busybox:1.36.1-uclibc` — `FROM scratch`,
statically linked — ran `busybox sleep 20` in that **same** app image and exited 0. After repinning:

```
pw-imgcache   2 desired   2 current   2 ready   (restartCount 0 on both nodes)
NextApp conditions: … ImageCacheReady=True/Cached
```

Two properties of this failure are worth keeping. It was **invisible in `Ready`** — by design, since a
prewarm failure only degrades `ImageCacheReady` — and the image **was still pulled**, because a
CrashLoopBackOff pod has already pulled and still references its image. So "no `Pulling` event on cold
start" would have been *true* on a cluster where the feature was crash-looping on every node: the
criterion is only meaningful read together with `ImageCacheReady` and the prewarm pods' restart counts.

Separately, and on the same nodes: the staged static helper also runs in a **libc-free, shell-free**
image (`gcr.io/distroless/static-debian12:nonroot` as a stand-in app image ran
`/knext-pin/busybox sleep 15`, exit 0, restarts 0). That is the shell-free mechanism working where a
`sleep infinity` on the app image could not — at container level. It is **not** the full distroless
proof ADR-0037 still tracks, which wants a genuinely distroless *knext app* image driven through the
e2e.

## Results (run 2, n = 10 per arm, 0 failed replicates)

Cold-start TTFB, `GET /api/health`, measured from outside the cluster:

| arm | n | min | p25 | median | p75 | max | mean | sd |
|---|---|---|---|---|---|---|---|---|
| `imagePrewarm=true` (image on node) | 10 | 2273 | 2382 | **2490** | 2818 | 3068 | 2592 | 280 |
| `imagePrewarm=false` (kubelet pulls) | 10 | 4064 | 4382 | **4782** | 6696 | 13812 | 6445 | 3457 |

- **`Pulling` events: 0/10 with prewarm, 10/10 without.** Every prewarm replicate's pod reported
  `already present on machine` for the app image; every no-prewarm replicate reported
  `Successfully pulled image … Image size: 369851685 bytes`.
- **The distributions do not overlap**: the slowest prewarm replicate (3068 ms) is faster than the
  fastest no-prewarm replicate (4064 ms).
- **Median delta: 2293 ms** for a 370 MB image on a same-region registry. Per-pair (ABBA) deltas were
  positive in all five pairs: 8065, 2320, 1656, 5574, 1648 ms.
- **Stratified by node**, since scheduling was not balanced (19 of 20 pods landed on `10.0.1.253`; the
  single `10.0.1.78` sample is the 11.6 s no-prewarm outlier): on `10.0.1.253` alone the medians are
  **2483 ms (prewarm, n=10)** vs **4683 ms (no prewarm, n=9)** — a **2200 ms** same-node delta. The
  node asymmetry is therefore not what produces the result.
- Warm baselines were stable and indistinguishable between arms (median 410 ms vs 392 ms), which is the
  client↔cluster RTT; subtracting it, the cold-start cost itself is **2091 ms** with prewarm vs
  **4326 ms** without.
- The kubelet's own reported pull duration (median **2148 ms**, min 1639, max 4673) accounts for most
  of the median delta but **not** the tail: replicates 3 and 15 took 13.8 s and 11.6 s end-to-end while
  the kubelet reported 2.4 s and 1.6 s of pulling. Whatever produces those — scheduling, layer
  extraction, or contention on a cluster already at ~84% of CPU requests — is *additional* to the pull
  and only ever happens on the no-prewarm arm here.

So the ~2 s estimate ADR-0037 carried is right at the median, and understates the tail: the 75th
percentile costs 3.9 s and the worst replicate 11.3 s more than the prewarmed arm.

### Correction: run 1 is withdrawn

Run 1 (same day, same cluster) is **invalid and its data is not reported**. Its "no prewarm" arm never
actually evicted anything: presence was probed with `crictl images -q <repo>`, which returns **nothing
for a digest-only (untagged) image even when the image is present**, so the eviction loop found no ids,
removed nothing, and every replicate — both arms — reported `already present on machine`. It would have
produced a *null result* ("prewarm makes no difference"), which is exactly the shape of wrong answer a
harness that trusts one unverified probe produces. Run 2 checks presence with `crictl inspecti` and
**asserts the precondition on every node in every replicate**, failing the replicate rather than
measuring it.

### What this does not establish

- **One cluster, one sitting, one image size.** Pull cost scales with image size and registry
  distance; 370 MB from a same-region OCIR is a favourable case for the no-prewarm arm.
- **A same-region registry.** A cross-region registry or a rate-limited public one makes the
  no-prewarm arm worse, not better.
- **Nothing here measures the cost side of prewarm** (a copy of the image on every schedulable node
  plus one pod per app per node against each node's max-pods limit). That trade is documented for users
  in the Runtime → image caching page, and it is the reason the feature is opt-in.

## Reproducing this

```bash
cd benchmarks/image-prewarm-oke
KUBE_CONTEXT=<ctx> NAMESPACE=knext-prewarm APP=pw \
PW_IMAGE=<registry>/<repo>@sha256:<digest> PW_PAIRS=5 \
node measure.mjs | tee results/run.log
node analyze.mjs results/results.jsonl
```

`benchmarks/**/results/` is gitignored, so the raw rows are reproduced below rather than
committed as JSONL.

## Appendix — every replicate

Run order is top to bottom; the arms alternate ABBA within each pair. Node names are the OKE worker
internal IPs (`10.0.1.x`).

| # | pair | arm | node | cold TTFB ms | warm TTFB ms | `Pulling`? | kubelet pull |
|---|---|---|---|---|---|---|---|
| 1 | 1 | prewarm | …253 | 2383 | 375.2 | no | — |
| 2 | 1 | no prewarm | …253 | 7198.1 | 383.8 | **yes** | 4.673 s |
| 3 | 1 | no prewarm | …253 | 13811.8 | 395.7 | **yes** | 2.41 s |
| 4 | 1 | prewarm | …253 | 2496.5 | 390.3 | no | — |
| 5 | 2 | prewarm | …253 | 2273.4 | 392.1 | no | — |
| 6 | 2 | no prewarm | …253 | 5191.4 | 834.2 | **yes** | 2.074 s |
| 7 | 2 | no prewarm | …253 | 4383.4 | 410.4 | **yes** | 2.222 s |
| 8 | 2 | prewarm | …253 | 2662.4 | 553.9 | no | — |
| 9 | 3 | prewarm | …253 | 2951 | 458.9 | no | — |
| 10 | 3 | no prewarm | …253 | 4881.6 | 378.8 | **yes** | 2.32 s |
| 11 | 3 | no prewarm | …253 | 4251.9 | 394.9 | **yes** | 2.009 s |
| 12 | 3 | prewarm | …253 | 2870.2 | 441.4 | no | — |
| 13 | 4 | prewarm | …253 | 2482.5 | 406.6 | no | — |
| 14 | 4 | no prewarm | …253 | 4381 | 386 | **yes** | 2.033 s |
| 15 | 4 | no prewarm | …78 | 11601.6 | 517.2 | **yes** | 1.639 s |
| 16 | 4 | prewarm | …253 | 2351.6 | 397.6 | no | — |
| 17 | 5 | prewarm | …253 | 3067.8 | 414.4 | no | — |
| 18 | 5 | no prewarm | …253 | 4682.5 | 388.6 | **yes** | 2.327 s |
| 19 | 5 | no prewarm | …253 | 4063.9 | 382 | **yes** | 1.87 s |
| 20 | 5 | prewarm | …253 | 2382 | 413.3 | no | — |
