# The bimodal cold-start slow mode: attributed to one node, and to the readiness gate

**Status:** measured 2026-08-11. Supersedes the standing "the ~10–11 s slow mode is
unattributable because the pods were gone before their placement could be inspected"
note (Run 24). It is now attributed, to a defensible depth, with the limits stated below.

## The shape that started this

Sorting the 24 interleaved ABBA samples from the 2026-08-10 sitting shows two tight
clusters and **nothing between them**:

| band | n | range | spread |
|---|---|---|---|
| fast | 14 | 1.98–3.80 s | 1.82 s |
| slow | 10 | 10.16–11.57 s | 1.41 s |

The largest interior gap is **6.36 s**; the second largest is **0.49 s**. A resource
contention story produces a continuum, so this shape argued for a discrete event —
a timeout, a fixed backoff, or a missed poll.

## What it is

**The slow mode is node-local to `10.0.1.78`, and the whole excess sits after the
container has started, inside the readiness gate.**

Pod time-to-Ready, pooled over both collector runs (53 pods, including transient
pods no benchmark request ever touched):

| node | n | min | p50 | max | ≥10 s |
|---|---|---|---|---|---|
| `10.0.1.253` | 41 | 1 s | 2 s | 3 s | **0** |
| `10.0.1.78` | 12 | 2 s | 3 s | 11 s | **5** |

Those 10–11 s values coincide with the observed slow band. Decomposing the five slow
pods against the five fast ones on the same node:

```
SLOW (10.0.1.78)   Scheduled=0s  Pulled=1-2s  Created=1-2s  Started=1-2s  Ready=10-11s
FAST (10.0.1.78)   Scheduled=0s  Pulled=1-2s  Created=1-2s  Started=1-2s  Ready=2-3s
```

The container is running by 2 s in **both** cases. The entire 8–9 s difference is
spent waiting for readiness, and the event text says why:

- **slow pods:** `Readiness probe failed: Get "http://10.244.0.N:8012/": context
  deadline exceeded (Client.Timeout exceeded while awaiting headers)` — 2, 6, 9, 9
  and 9 occurrences.
- **fast pods:** `HTTP probe failed with statuscode: 503` only.

Port 8012 is the Knative **queue-proxy**. A 503 means queue-proxy is answering and
the app is not up yet — normal, and it clears in 1–2 s. A *timeout* means queue-proxy
itself does not answer at all. With `periodSeconds: 1` and `timeoutSeconds: 1`,
roughly nine consecutive one-second timeouts reproduce the missing 8–9 s, and
`10.244.0.0/25` is `10.0.1.78`'s pod CIDR, which is what ties the timing to the node.

## What it is not

Each of these was a live hypothesis and each is dead. They are recorded so nobody
re-derives them.

| hypothesis | refuted by |
|---|---|
| readiness-probe backoff | `periodSeconds: 1` — a missed probe costs 1 s, not ~7 |
| image pull | the target digest is resident on **both** nodes |
| idle gap / page-cache eviction | slow gaps 145–198 s vs fast 148–199 s — no separation |
| revision accumulation | a run with 148 revisions present (the most ever) went 12/12 fast |
| per-invocation structure / fresh revision | 6 separate single-sample invocations, the exact structure that produced slow samples the night before, went 6/6 fast |
| node CPU saturation | both nodes 84% of allocatable requested, 4% actually used |
| pod CIDR overlap | distinct — `10.244.1.0/25` vs `10.244.0.0/25` |

Memory is the one node-level number that is high on both (81–84%), and `10.0.1.78`
additionally hosts the activator, both Kourier gateways and both CoreDNS pods.
Neither observation is load-bearing for the conclusion above.

## Limits of this result — read before quoting it

- **No measured sample landed on `10.0.1.78`.** All 18 samples on 2026-08-11 were
  scheduled to `10.0.1.253`; `.78` only ever hosted transient revision-activation
  pods. The node↔slow-mode link therefore rests on **pod time-to-Ready**, not on a
  sampled request. The 10–11 s agreement with the slow band is strong, and it is
  still an inference.
- **The layer below the probe timeout is not established.** Why queue-proxy on `.78`
  fails to answer for ~9 s — CNI/flannel programming latency, memory reclaim, or
  something else — is not determined by this data. Do not assert one.
- **One cluster, two nodes, two sittings.** A distribution from one node and one day
  can be literally honest and still describe an artifact of that node.

## Consequences

1. **A pooled cold-start number across these two nodes is a mixture, not a
   measurement.** This is the same defect that withdrew Run 24 and that ADR-0036
   condition A5 exists to prevent, one level lower: A5 stratifies by *mode*, and
   mode is at least partly *node*. Cold-start results should stratify by node, and
   the harness records placement well enough to do it.
2. **The build target is not where the cold-start work is.** The Phase 1 A/B already
   showed the arms indistinguishable in fast mode (2.65 s vs 2.55 s); the entire
   apparent 4.12 s pooled win was mode mixture. The slow mode is worth ~6.4 s and
   belongs to the platform, not to the runtime.
3. `10.0.1.78` is anomalous and worth investigating on its own terms, independently
   of any benchmark.

## Reproducing

```
./cold-attribution-collector.sh <ksvc> <context> <namespace> out.jsonl &   # BEFORE the run
./run.sh --service <ksvc> --phases cold --cold-samples N --sitting <id>
kill -TERM %1
node cold-attribution-report.mjs out.jsonl <results-file>
```

The collector must start first: Knative reaps the pod on scale-to-zero and placement
becomes unrecoverable afterwards. It is read-only against the cluster.
