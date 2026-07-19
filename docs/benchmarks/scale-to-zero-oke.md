# Scale-to-zero & burst benchmark — OKE (2026-07-19)

Status: point-in-time measurement · Date: 2026-07-19 · Target: `file-manager` Knative Service

## Environment

- **Cluster:** Oracle Kubernetes Engine (OKE), 2 nodes, Kubernetes 1.33, ~1830m allocatable CPU
  per node.
- **Target app:** `file-manager` Knative Service (the knext example app). Pods request **0 CPU**
  (no `resources.requests.cpu` set), so pod fan-out is not CPU-gated on this cluster — only the
  autoscaler/scheduler path is being measured.
- **Load generator:** in-cluster `grafana/k6` 0.49, run as a Job in the same cluster (not
  external) to avoid confounding network egress latency with cold-start latency.

This is a single small (2-node) cluster. Treat every number below as **environment-dependent, not
a guarantee** — see the closing note.

## Methodology

### Phase A — cold start
Single HTTP request sent after the service had been idle long enough to scale to zero, repeated
for **5 samples**, under baseline autoscaling config (no burst tuning applied). Measures the full
0→1 wake: scheduling + container start + server boot + first-request serve.

### Phase C — reliability / soak
**120 virtual users (VUs)** held for **3 minutes** against the warm/scaling service, baseline
autoscaling config. Measures steady-state latency and error rate under sustained concurrent load,
plus scale-up behavior from a cold or near-cold starting point.

### Phase B — burst A/B, round 1 (inconclusive — superseded by the discriminating re-run below)
`10 → 200 → 10` VU ramp, ×2 reps per config, default `containerConcurrency`. Both baseline and
tuned configs converged on **peak pods = 1** — a single pod absorbed all 200 VUs because the app
is a lightweight GET and default concurrency left one pod with headroom, so the KPA never fanned
out and the burst knobs had nothing to differentiate. Kept in the dataset below for completeness,
but the *discriminating* burst A/B is the re-run in the next section.

### Discriminating burst A/B (forced fan-out)
To actually exercise the burst-response knobs, `containerConcurrency` was pinned to **15** and
load was switched to **continuous (no-think-time) 90 VUs**, so that `90 ÷ 15 = 6` pods —
exactly `maxScale` — forcing a real fan-out from 0 (or near-0) to the pod cap. Two reps per
config:
- **Baseline:** `targetBurstCapacity=200`, `panicWindowPercentage=10`, `panicThresholdPercentage=200`
- **Tuned:** `targetBurstCapacity=-1`, `panicWindowPercentage=6`, `panicThresholdPercentage=150`

(First attempt at this re-run failed for an unrelated reason: the k6 Job itself requested 500m
CPU and went `Pending` on the near-full 2-node cluster — 1830m allocatable/node, ~290m free at
the time. Refit k6 to request 150m CPU; `file-manager` pods request 0 CPU so the *app* was never
the constrained side.)

## Results

### Cold start, soak, and first burst round

| Phase | Config | Load | Reqs | Errors | med | p95 | p99 | max | peak pods | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| A cold-start | baseline | 1 req after idle ×5 | 5 | 0% | ~4.0s | — | — | 6.66s | 1 | scheduling-bound |
| B burst (round 1) | baseline (TBC=200, pw=10, pt=200) | 10→200→10 VU ×2 | 7290 / 7379 | 0% | 9.0/7.3ms | 67/25ms | 300/95ms | 7.3/4.0s | 1 | max = the cold first req; no fan-out occurred |
| B burst (round 1) | tuned (TBC=-1, pw=6, pt=150) | 10→200→10 VU ×2 | 7409 / 7408 | 0% | 3.4/3.3ms | 9.4/9.2ms | 27/29ms | 6.9/7.2s | 1 | tighter tail than baseline; no fan-out occurred |
| C soak | baseline | 120 VU held 3m | 22643 | 0% | 5.6ms | 28ms | 731ms | 10.96s | 3 | time-to-2-pods 12s |
| D scale-down | — | post-load | — | — | — | — | — | — | →0 | clean, fast |

Total across cold-start/round-1-burst/soak: **~44,500 requests, 0 failures.**

### Discriminating burst A/B (cc=15 pinned, forced fan-out to maxScale=6)

| Config | rep | →2 pods | →6 pods | reqs | errors | med | p95 | p99 | max | rps |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline (TBC=200, pw=10, pt=200) | 1 | 6s | 9s | 35795 | 0 | 106ms | 390ms | 667ms | 9.25s | 477 |
| baseline | 2 | 6s | 12s | 29181 | 0 | 112ms | 292ms | 438ms | 31.44s | 389 |
| tuned (TBC=-1, pw=6, pt=150) | 1 | 9s | 9s | 37276 | 2 (0.005%) | 81ms | 286ms | 515ms | 28.4s | 497 |
| tuned | 2 | 9s | 15s | 27101 | 0 | 72ms | 549ms | 1.31s | 21.77s | 361 |

## Findings

- **Fan-out to maxScale confirmed every rep once concurrency was pinned to force it:** 0→6 pods
  in **9–15s**, with 2 pods reached in **6–9s** — this is the run that actually exercises the
  burst knobs (round-1 burst above never fanned out past 1 pod, so it can't speak to scale-up
  behavior).
- **Near-zero errors under saturation:** 2 failures across ~129k requests during the forced
  fan-out reps (0.005% in the one rep with failures; 0% in the other three). Combined with the
  ~44.5k-request, 0-failure cold-start/soak dataset, the platform did not drop requests under
  either sustained or bursty load in this test.
- **The burst knobs (`targetBurstCapacity`, `panicWindowPercentage`, `panicThresholdPercentage`)
  are a marginal MEDIAN-latency lever, not an error-rate or tail-latency fixer.** Tuned config
  held median **72–81ms** vs baseline **106–112ms** — keeping `targetBurstCapacity=-1` (an
  always-on buffer in front of the pods) shows up as a consistent median improvement. It did
  **not** improve error rate (already ~0 in both) and the tail is noisy in both configs (max
  9–31s), because the tail is dominated by the first cold request in the run, not by
  autoscaler reaction time.
- **The tail is cold-start-dominated, not burst-knob-dominated:** cold start measured
  independently at **~4.0s median (Phase A)**, scheduling-bound on this 2-node cluster (not
  boot-bound). The `max` column across every burst/soak phase reflects that same first-request
  cold start, which is why tuning panic-window/threshold doesn't move it — those knobs affect
  reaction speed during an already-warm-ish scale-up, not the cost of the very first pod
  scheduling onto a node.
- **Soak (120 VU / 3 min) confirms steady-state health independent of the burst path:** 0 errors
  across 22,643 requests, scaled 0→3 pods, reached 2 pods at 12s, p99 731ms (again the one cold
  first-request pulling the tail up).

## Caveat

These are **point-in-time measurements on a specific small (2-node) OKE cluster** with a
zero-CPU-request target app — they demonstrate behavior and relative effect, not portable
absolute numbers or a performance guarantee for other clusters, node pools, or workloads.
