# Scale-to-zero & burst benchmark — OKE (2026-07-19 / 2026-07-20)

Status: point-in-time measurement · Runs: 2026-07-19 (run 1, throwaway scripts) and 2026-07-20
(run 2, committed harness) · Target: `file-manager` Knative Service

> **Correction notice (2026-07-20).** Run 2 **did not reproduce** run 1's headline burst finding —
> the median-latency delta between the baseline and tuned burst configs reversed sign. The run-1
> conclusion that the burst knobs are a "marginal median-latency lever" is **withdrawn**; see
> [Run 2](#run-2-2026-07-20--produced-by-the-committed-harness) and the
> [corrected findings](#corrected-findings-after-run-2). Run-1 data is retained below as history,
> not as a current conclusion.

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

## Reproducing this

Every phase below is reproducible via the committed harness at
[`benchmarks/scale-to-zero-oke/`](../../benchmarks/scale-to-zero-oke/) (added in #423 — the
numbers here were originally produced by throwaway temp scripts). It runs against any Knative
Service on any cluster; no cluster identity is hardcoded:

```bash
cd benchmarks/scale-to-zero-oke

# Dry run — prints every kubectl/k6 action without touching a cluster.
./run.sh --service my-app --namespace default --dry-run

# The full run behind this doc (Phase A + Phase C + the discriminating burst A/B):
./run.sh --context my-kube-context --namespace default --service my-app \
  --max-scale 6 --container-concurrency 15
```

The harness captures and restores the target's autoscaling config on exit (including on Ctrl-C),
so an interrupted run doesn't leave the cluster patched with test config. See
[its README](../../benchmarks/scale-to-zero-oke/README.md) for the full flag list, how to read the
output, and the **two false-result traps** — think-time load that never fans out (peak pods = 1),
and an oversized k6 CPU request that leaves the load generator `Pending` (a false zero-load
result). Both are the failures that actually occurred while producing the numbers below.

Not covered by the harness: CI regression gating (needs a dedicated perf environment) and
p99 cold start *under concurrency* — the Phase A methodology here is sequential single-request
samples.

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

## Results — run 1 (2026-07-19, historical)

These numbers were produced by throwaway temp scripts, before the harness existed. Retained as
history. Where run 2 contradicts them, **run 2 governs**.

### Cold start, soak, and first burst round

| Phase | Config | Load | Reqs | Errors | med | p95 | p99 | max | peak pods | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| A cold-start | baseline | 1 req after idle ×5 | 5 | 0% | ~4.0s | — | — | 6.66s | 1 | scheduling-bound |
| B burst (round 1) | baseline (TBC=200, pw=10, pt=200) | 10→200→10 VU ×2 | 7290 / 7379 | 0% | 9.0/7.3ms | 67/25ms | 300/95ms | 7.3/4.0s | 1 | max = the cold first req; no fan-out occurred |
| B burst (round 1) | tuned (TBC=-1, pw=6, pt=150) | 10→200→10 VU ×2 | 7409 / 7408 | 0% | 3.4/3.3ms | 9.4/9.2ms | 27/29ms | 6.9/7.2s | 1 | tighter tail than baseline; no fan-out occurred |
| C soak | baseline | 120 VU held 3m | 22643 | 0% | 5.6ms | 28ms | 731ms | 10.96s | 3 | time-to-2-pods 12s |
| D scale-down | — | post-load | — | — | — | — | — | — | →0 | clean, fast |

Total across cold-start/round-1-burst/soak (5 + 7290 + 7379 + 7409 + 7408 + 22643): **52,134 requests, 0 failures.**

### Discriminating burst A/B (cc=15 pinned, forced fan-out to maxScale=6)

| Config | rep | →2 pods | →6 pods | reqs | errors | med | p95 | p99 | max | rps |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline (TBC=200, pw=10, pt=200) | 1 | 6s | 9s | 35795 | 0 | 106ms | 390ms | 667ms | 9.25s | 477 |
| baseline | 2 | 6s | 12s | 29181 | 0 | 112ms | 292ms | 438ms | 31.44s | 389 |
| tuned (TBC=-1, pw=6, pt=150) | 1 | 9s | 9s | 37276 | 2 (0.005%) | 81ms | 286ms | 515ms | 28.4s | 497 |
| tuned | 2 | 9s | 15s | 27101 | 0 | 72ms | 549ms | 1.31s | 21.77s | 361 |

## Findings — run 1 (as published 2026-07-19; the burst-knob bullet is now WITHDRAWN)

- **Fan-out to maxScale confirmed every rep once concurrency was pinned to force it:** 0→6 pods
  in **9–15s**, with 2 pods reached in **6–9s** — this is the run that actually exercises the
  burst knobs (round-1 burst above never fanned out past 1 pod, so it can't speak to scale-up
  behavior).
- **Near-zero errors under saturation:** 2 failures across ~129k requests during the forced
  fan-out reps (0.005% in the one rep with failures; 0% in the other three). Combined with the
  52,134-request, 0-failure cold-start/round-1-burst/soak dataset, the platform did not drop requests under
  either sustained or bursty load in this test.
- ~~**The burst knobs (`targetBurstCapacity`, `panicWindowPercentage`, `panicThresholdPercentage`)
  are a marginal MEDIAN-latency lever, not an error-rate or tail-latency fixer.**~~
  **WITHDRAWN — refuted by run 2**, which measured the tuned config's median *higher* than
  baseline's. The run-1 delta below was run-to-run noise. Original text kept for the record:
  Tuned config
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

## Run 2 (2026-07-20) — produced by the committed harness

Same cluster and same target (`file-manager`, OKE 2-node) as run 1. **This is the first run
produced end-to-end by the committed harness** rather than by throwaway scripts, so it is
reproducible by anyone with cluster access:

```bash
cd benchmarks/scale-to-zero-oke
./run.sh --namespace default --service file-manager \
  --max-scale 6 --container-concurrency 15 --burst-vus 90
```

Harness defaults for this run: `max-scale=6`, `containerConcurrency` pinned to **15** for the
burst phase, **90** continuous (no-think-time) burst VUs (`90 ÷ 15 = 6` pods = the cap),
k6 image `grafana/k6:0.49.0` at a 150m CPU request. Captured pre-run config (restored on exit):
`max-scale=10`, `containerConcurrency=20`, burst/panic annotations unset.

### Phase A — cold start (5 sequential single-request samples, baseline config)

| Sample | Idle before request | Response time | Peak pods |
|---|---|---|---|
| 1 | 66s | 5.84s | 1 |
| 2 | 18s | **17.6s** | 2 |
| 3 | 30s | 3.72s | 1 |
| 4 | 72s | 3.83s | 1 |
| 5 | 48s | 3.95s | 1 |

Median **3.95s**; max **17.6s** — a **4.5× median** outlier (run 1's worst cold sample was 6.66s).
All 5 samples succeeded; 0 errors.

**The median badly understates the cold-start tail.** Four of five samples cluster in 3.7–5.9s and
one lands at 17.6s. **We do not know what caused the 17.6s sample** — the harness records
end-to-end request time only, with no per-stage breakdown (scheduling vs image pull vs boot vs
first serve), so any explanation would be speculation and none is offered here. What the sample
does establish is that a 5-sample sequential median is not a safe summary of cold-start behavior,
and it is the concrete empirical justification for measuring **p99 cold start under concurrency**
(#309) rather than reporting a median of sequential singles.

### Phase C — sustained soak (ramp 0→120 VU over 20s, hold 3m, baseline config, think-time load)

| Reqs | Errors | med | p90 | p95 | p99 | max | rps | peak pods |
|---|---|---|---|---|---|---|---|---|
| 23,027 | 0 (0.00%) | 7.75ms | 21.1ms | 44.56ms | 191.35ms | 3.83s | 109.4 | **1** |

**Peak pods varied run-to-run: 1 here vs 3 in run 1**, at comparable request volume (23,027 vs
22,643) and identical load shape. The harness flagged this rep with its `peak pods = 1` warning.
Under think-time load a single pod can absorb 120 VUs, so whether a second pod is created at all
depends on where request arrivals land relative to the autoscaler's window — this is variance in
the measurement, not a demonstrated behavior change. It is also why the *burst* phase pins
`containerConcurrency` to force fan-out.

Phase D (scale-down after soak): scaled to 0 after **60s**.

### Phase B — discriminating burst A/B (cc=15 pinned, 90 continuous VUs, maxScale=6)

| Config | rep | peak pods | →2 pods | →6 pods | reqs | errors | med | p90 | p95 | p99 | max | rps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline (TBC=200, pw=10, pt=200) | 1 | 6 | 3s | 9s | 37,031 | 0 | 70.86ms | 332.9ms | 415.64ms | 668.97ms | 8.34s | 493.5 |
| baseline | 2 | 6 | 6s | 12s | 35,712 | 0 | 77.4ms | 343.08ms | 429.76ms | 686.82ms | 8.39s | 476.0 |
| tuned (TBC=-1, pw=6, pt=150) | 1 | 6 | **0s** | 9s | 34,593 | 0 | 88.06ms | 348.91ms | 431.48ms | 715.7ms | 7.92s | 461.1 |
| tuned | 2 | 6 | **0s** | 3s | — | — | — | — | — | — | — | — |

**Data gap, stated rather than filled:** the results file records tuned rep 2's pod metrics
(peak=6, →2 pods 0s, →6 pods 3s) but **contains no k6 metrics block for that rep** — no request
count, latency, or error figures. Those cells are left empty rather than estimated, and every
request total below covers only the **three** reps that have recorded metrics.

**This gap is why the harness now fails loudly on it (#425).** At the time of run 2 the harness
discarded the `kubectl wait` result, so a k6 Job that had not finished — and therefore had printed
no end-of-run summary to scrape — was indistinguishable from one that had; the rep was dropped in
silence and the run still exited 0. The gap was caught by a human reading this document, not by the
harness, and it nearly produced a "0 errors across all four reps" claim the data did not support.
The harness now reports each rep's Job outcome (`completed` / `failed` / `timed-out`), keeps the Job
when its metrics were not captured, prints an always-on run-integrity verdict line, and **exits 2**
on an incomplete dataset. A rerun that hit this same condition today would surface it loudly instead
of silently — see [the harness README](../../benchmarks/scale-to-zero-oke/README.md) for the full
set of output states. **No rerun has been performed; the numbers above are unchanged.**

Recorded request volume, run 2: **107,336** burst requests across those three reps
(37,031 + 35,712 + 34,593), **0 failures**. Including Phase A (5) and Phase C (23,027):
**130,368 recorded requests, 0 failures** for the whole run.

### Corrected findings after run 2

- **The run-1 median improvement did not reproduce — the direction flipped.** Run 1 measured tuned
  at 81/72ms vs baseline 106/112ms; run 2 measured tuned at **88.06ms** vs baseline **70.86ms /
  77.4ms**, i.e. baseline equal or better. Across both runs the burst knobs show **no demonstrable
  effect on median response time at all**. This is a firmer statement than run 1's "marginal lever"
  framing, not a softer one: the honest reading is not "the knobs help a little" but "**we cannot
  demonstrate that they help**." Do not cite the run-1 delta.
- **Methodological lesson, and the reason this correction exists: a single-run performance delta on
  a shared 2-node cluster is not trustworthy.** Run 1's ~30ms gap looked like a clean signal,
  consistent across two reps, and was published as a finding; a second run of the same A/B on the
  same cluster reversed it. Two reps *within* one run share that run's cluster conditions and so do
  not establish reproducibility — only a repeated run does. Treat any future single-run latency
  delta here as a hypothesis until an independent run confirms it.
- **A real and consistent difference does exist — in how fast capacity is added, not in latency.**
  The tuned config reached 2 pods **instantly (0s in both reps)** vs baseline's **3s and 6s**.
  `targetBurstCapacity=-1` keeps the activator in the request path, so it buffers requests and
  triggers scale-up immediately rather than waiting for a proxy-reported concurrency breach. The
  cost is an extra network hop on every request — a plausible reading of why tuned's median is not
  better. **Faster fan-out, not better latency** is the defensible claim.
- **Fan-out to the cap confirmed in all four burst reps: `peak=6` every time**, with 0 errors
  across the 107,336 requests that have recorded metrics.
- **Cold start remains the tail driver, and its own tail is worse than run 1 suggested** (17.6s max
  vs 6.66s in run 1). Burst-knob tuning does not touch it.

### Harness fail-closed path: live-verified

The first live invocation of the harness in this session **aborted instead of producing results**.
A transient `TLS handshake timeout` caused the autoscaling patch to fail; the harness detected the
failed patch, refused to run any load phase against a configuration it had not successfully
applied, and restored the service exactly as captured (`containerConcurrency=20`, `max-scale=10`,
annotations returned to their captured state, no k6 Jobs/ConfigMaps left behind).

That is the fail-loud/fail-closed behavior added in the harness hardening pass, and it is worth
recording that it fired for real on its first live outing: **without it, that run would have
produced a complete, plausible-looking benchmark measuring an unapplied config** — a silently
wrong result of exactly the kind this document is now correcting.

## Caveat

These are **point-in-time measurements on a specific small (2-node) OKE cluster** with a
zero-CPU-request target app — they demonstrate behavior and relative effect, not portable
absolute numbers or a performance guarantee for other clusters, node pools, or workloads.

Run 2 additionally showed that **even the "relative effect" half of that claim needs a repeated
run to stand up**: the burst A/B's median delta reversed between two runs of the same A/B against
the same cluster and app. Latency deltas here should be reported only when they reproduce across
runs; pod-count and time-to-N-pods observations proved far more stable and are the more
trustworthy signal from this harness.
