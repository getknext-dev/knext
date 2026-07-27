# Scale-to-zero & burst benchmark — OKE (2026-07-19 / 2026-07-20)

Status: point-in-time measurement · Runs: 2026-07-19 (run 1, throwaway scripts), 2026-07-20
(run 2, committed harness), 2026-07-20 (run 3, data-integrity-hardened harness — **aborted
mid-run, partial dataset**) and 2026-07-20 (run 4, retry-hardened harness — **the first run to
complete every phase**), 2026-07-20 (run 5, one-off bytecode before/after — **aborted before the
AFTER arm**) and 2026-07-20 (run 6, in-pod compile-cache COLD/WARM pairs — **the first measured
performance result here, with complete distribution separation**) · Target: `file-manager` Knative
Service

> **Correction notice (2026-07-20).** Run 2 **did not reproduce** run 1's headline burst finding —
> the median-latency delta between the baseline and tuned burst configs reversed sign. The run-1
> conclusion that the burst knobs are a "marginal median-latency lever" is **withdrawn**; see
> [Run 2](#run-2-2026-07-20--produced-by-the-committed-harness) and the
> [corrected findings](#corrected-findings-after-run-2). Run-1 data is retained below as history,
> not as a current conclusion.
>
> **Second correction notice (2026-07-20, after run 4).** Run 2's replacement claim — that the
> tuned config reaches 2 pods **instantly** while baseline takes 3–6s — **also did not reproduce**:
> in run 4 both configs reached 2 pods at 6s and 6 pods at 12s, identically. Both conclusions
> ever drawn from this A/B have now failed to reproduce, in opposite directions. The standing
> position is that **the burst-knob comparison is not conclusive either way at this sample size**;
> see [Run 4](#run-4-2026-07-20--first-complete-run-retry-hardened-harness).

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

## Run 3 (2026-07-20) — first run on the data-integrity-hardened harness (ABORTED)

Same cluster and same target as runs 1 and 2. This is the first run produced by the harness with
the data-integrity fixes from #425 in place. **It did not complete**: while applying the burst
autoscaling config, `kubectl` failed with a transient OKE API-server `TLS handshake timeout`, and
the harness aborted with exit code 1.

```bash
cd benchmarks/scale-to-zero-oke
./run.sh --namespace default --service file-manager \
  --max-scale 6 --container-concurrency 15 --burst-vus 90
```

Harness config for this run: `max-scale=6`, `containerConcurrency` pinned to **15** for the burst
phase, **90** burst VUs, k6 image `grafana/k6:0.49.0` at a 150m CPU request, phases `all`. Captured
pre-run config: `max-scale=10`, `containerConcurrency=20`, burst/panic annotations unset.

### The abort was reported honestly — the headline result

The run's closing verdict line was:

```
run integrity: ABORTED after 6 rep(s) — partial dataset, NOT the configured experiment
```

with exit code **1** (the harness's "aborted part-way through" code, distinct from exit **2** for
"finished, but a rep lost data"). Cleanup restored the service exactly as captured —
`containerConcurrency=20`, `max-scale=10`, burst/panic annotations restored/removed to the captured
originals — and deleted every k6 Job/ConfigMap for the run, leaving **0 leftover artifacts**.

**This is precisely the failure mode the system-designer sign-off on #426 flagged as untested, and
it fired on the fix's first live run.** Before this change the run-integrity verdict was computed
from a rep count rather than from whether the configured experiment actually ran, so this same
aborted run would have printed `dataset is complete for 6 rep(s)` while exiting 1 — a
"complete dataset" label on a run that never executed its burst phase. It now says the opposite, in
the one line a reader is most likely to trust.

### Valid data captured before the abort (6 reps)

The five cold-start samples and the soak rep completed and are reportable.

**Phase A — cold start (5 sequential single-request samples, baseline config):**

| Sample | Response time | Peak pods |
|---|---|---|
| 1 | 3.70s | 1 |
| 2 | 3.91s | 1 |
| 3 | 4.33s | 1 |
| 4 | 3.44s | 1 |
| 5 | 3.93s | 1 |

Median **3.91s**; worst sample **4.33s**. All 5 samples succeeded; 0 errors.

**Phase C — sustained soak (ramp 0→120 VU over 20s, hold 3m, baseline config, think-time load):**

| Reqs | Errors | med | p90 | p95 | p99 | max | rps | peak pods |
|---|---|---|---|---|---|---|---|---|
| 23,101 | 0 (0.00%) | 8.77ms | 19.99ms | 28.79ms | 84.07ms | 4.03s | 109.5 | **1** |

Phase D (scale-down after soak): scaled to 0 after **36s**.

**Phase B (burst A/B) did not run.** The abort happened while applying the first burst config, so
run 3 contributes **no burst data at all** — no request counts, no latency figures, no fan-out
timings. Nothing in the burst tables above changes; run 2 remains the most recent burst dataset.

### Findings — run 3

- **The cold-start median is highly reproducible; the cold-start tail is not.** Medians across the
  three runs: **~4.0s → 3.95s → 3.91s** (run 1 was recorded only to that precision) — the three
  independent runs on this cluster agree to within about a tenth of a second. The tail behaves completely differently: run 2 recorded a **17.6s** sample, while
  run 3's *worst* sample was **4.33s**. The plain implication is that the 17.6s outlier is
  **intermittent, not systematic** — a short run can miss it entirely, and five sequential samples
  is nowhere near enough to characterise the tail. This is the empirical case for the p99
  cold-start-under-concurrency work (#309), and specifically for that work needing **long** runs: a
  five-sample run would have reported run 3's clean 3.44–4.33s band as the whole story.
- **Soak p99 varies widely run-to-run, and the trend is not an improvement.** Soak p99 across runs:
  **730.6ms → 191.35ms → 84.07ms**, with peak pods **3 → 1 → 1**, at near-identical request volume
  (22,643 / 23,027 / 23,101) and identical load shape. **Nothing was optimised between these runs** —
  no runtime, autoscaler, or app change sits between them — so this is run-to-run variance on a
  small shared cluster, not a real improvement. Do not cite the downward sequence as progress. What
  it does establish is that soak p99 here is not a stable enough number to regress against; the
  peak-pod count tracks it (the 730.6ms run is the one that fanned out to 3 pods), which again
  points at scheduling, not steady-state serving, as the tail driver.
- **Sustained-load health held:** 23,101 requests, 0 errors, median **8.77ms** — consistent with
  runs 1 and 2 on the metrics that have been stable throughout (error rate and median).
- **Control-plane flakiness is now a pattern, not an incident.** Two of the three runs aborted on
  the same transient `TLS handshake timeout` talking to the OKE API server: run 2's session hit it
  before any load phase (see [above](#harness-fail-closed-path-live-verified)) and run 3 hit it
  mid-run while applying the burst config. The harness's refusal to continue is the correct
  behaviour in both cases — results for a configuration that was never applied are meaningless —
  but at this frequency it will make long p99 runs abort routinely. Bounded retry on transient API
  errors is tracked as **#427**; without it, the long-run measurements #309 needs are impractical
  on this cluster.

  **Since resolved (#427).** The harness now retries *transient* API errors — including this exact
  `TLS handshake timeout` — with capped exponential backoff, bounded by attempt count and a
  wall-clock deadline. Terminal errors (and anything unrecognised) still fail fast, and on retry
  exhaustion the abort/restore path above is unchanged, so a genuinely unreachable cluster still
  aborts. Runs that used a retry are annotated in their own results file (`api retries: N` plus per
  retry `api-retry:` lines and a `*** RUN DEGRADED BY TRANSIENT API ERRORS ***` block), so a run
  that limped through a flaky window stays distinguishable from a clean one; treat such a run's
  wall-clock timings as possibly inflated by control-plane stalls. See the harness
  [README](../../benchmarks/scale-to-zero-oke/README.md#transient-api-retry).
  **No run in this document was produced with retry enabled** — runs 1–3 predate it, and their
  numbers above are unchanged.

## Run 4 (2026-07-20) — first complete run, retry-hardened harness

Same cluster and same target (`file-manager`, OKE 2-node) as runs 1–3. This is the OKE validation
of the transient-API-retry work (#427 / PR #428), and **the first run in this document to complete
every configured phase**: the harness exited **0** with

```
api retries: 0 (no transient API errors — clean control-plane run)
run integrity: k6 metrics captured for all 10 rep(s) — dataset is complete
```

**The retry path was not exercised by real blips.** Zero transient API errors occurred, so this run
completed because the control plane happened to be healthy — **not** because retry rescued it. The
retry feature gets no credit for this run's success; what the run does show is that a healthy
window on this cluster is enough to finish all 10 reps, and that the run-integrity verdict says so
honestly when it is.

```bash
cd benchmarks/scale-to-zero-oke
./run.sh --namespace default --service file-manager \
  --max-scale 6 --container-concurrency 15 --burst-vus 90
```

Harness config for this run: phases `all`, `max-scale=6`, `containerConcurrency` pinned to **15**
for the burst phase, **90** continuous burst VUs, k6 image `grafana/k6:0.49.0` at a 150m CPU
request; API retry up to **4 attempts** per operation, each call capped at **15s**, total budget
`API_RETRY_DEADLINE_S=60s`. Captured pre-run config (restored on exit): `max-scale=10`,
`containerConcurrency=20`, burst/panic annotations unset.

### The headline: the burst A/B does not reproduce, in either direction

Run 4's burst A/B, in full — all four reps:

| Config | rep | peak pods | →2 pods | →6 pods | reqs | errors | med | p90 | p95 | p99 | max | rps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline (TBC=200, pw=10, pt=200) | 1 | 6 | 6s | 12s | 32,038 | 0 | 60.82ms | 332.95ms | 447.34ms | 1.18s | 23.99s | 427.1 |
| baseline | 2 | 6 | 6s | 12s | 32,407 | 0 | 71.45ms | 340.59ms | 438.34ms | 1.16s | 12.06s | 431.8 |
| tuned (TBC=-1, pw=6, pt=150) | 1 | 6 | 6s | 12s | 35,620 | 0 | 48.41ms | 350.32ms | 453.42ms | 767.9ms | 9.48s | 474.8 |
| tuned | 2 | 6 | 6s | 12s | 34,402 | 0 | 64.22ms | 355.52ms | 454.8ms | 719.62ms | 10.23s | 458.5 |

Placed against the two earlier runs of the *same* A/B on the *same* cluster and app:

| Run | median winner | fan-out timing |
|---|---|---|
| 1 (throwaway scripts) | tuned (81 / 72ms vs 106 / 112ms) | — |
| 2 (harness) | **baseline** (70.86 / 77.4ms vs 88.06ms) | tuned reached 2 pods at **0s**; baseline 3s / 6s |
| 4 (this run) | tuned (48.41 / 64.22ms vs 60.82 / 71.45ms) | **identical** — both 6s→2 pods, 12s→6 pods |

**Two separate conclusions have now been drawn from this comparison, and each has failed to
reproduce.** Run 1's median ordering flipped in run 2. Run 2's replacement finding — the one that
looked far more mechanistically convincing, that `targetBurstCapacity=-1` keeps the activator in
the path and so triggers scale-up instantly — **vanished entirely in run 4**, where the two configs
fanned out on exactly the same schedule to the second.

**Conclusion: at n=2 reps per config per run, between-run variance exceeds the between-config
difference. The burst-knob comparison is not conclusive, in either direction.** It does not
establish that the knobs help, and it does not establish that they don't. Settling it needs more
reps per config and repeated runs, not another single-run reading.

That includes the one difference in run 4 that looks strongest. **Tuned's p99 was ~35% lower than
baseline's — 767.9ms / 719.62ms vs 1.18s / 1.16s — and unlike every earlier candidate signal it was
consistent across both reps of both configs**, with no overlap between the two bands. It is the
largest and most internally consistent difference observed in this A/B so far, and it is recorded
here as **worth investigating — explicitly not as an established result.** This document already
carries one withdrawn burst conclusion and one silently-refuted one; the lesson both taught is that
a single run's delta on this cluster is not trustworthy, and that lesson applies to this p99 gap
exactly as it applied to them.

Fan-out itself remains the stable signal: **`peak=6` in all four reps**, 2 pods at 6s and 6 pods at
12s in every rep, **0 errors across 134,467 burst requests** (32,038 + 32,407 + 35,620 + 34,402).

### Phase A — cold start (5 sequential single-request samples, baseline config)

| Sample | Response time | Peak pods |
|---|---|---|
| 1 | **7.15s** | 1 |
| 2 | 3.83s | 1 |
| 3 | 3.82s | 1 |
| 4 | 3.44s | 1 |
| 5 | 3.90s | 1 |

Median **3.83s**; worst sample **7.15s** — roughly **2× the median**, and again the *first* sample
of the run. All 5 succeeded; 0 errors.

This extends the intermittent-outlier finding from runs 2 and 3 rather than changing it. Outliers
of roughly 2× median show up in most runs (**6.66s** in run 1, **7.15s** here), with one much
larger excursion on record (**17.6s** in run 2) and one run that saw none at all (run 3, worst
sample 4.33s). The median stays remarkably stable across all four runs while the tail does not,
which is the same conclusion in stronger form: **the median understates the tail, and
characterising the tail needs far more than 5 samples** — the empirical case for the p99
cold-start-under-concurrency work (#309).

### Phase C — sustained soak (ramp 0→120 VU over 20s, hold 3m, baseline config, think-time load)

| Reqs | Errors | med | p90 | p95 | p99 | max | rps | peak pods |
|---|---|---|---|---|---|---|---|---|
| 23,166 | 0 (0.00%) | 7.49ms | 14.49ms | 19.41ms | 37.95ms | 4.91s | 110.2 | **1** |

Phase D (scale-down after soak): scaled to 0 after **72s**.

Soak p99 across the four runs is now **730.6ms → 191.35ms → 84.07ms → 37.95ms**, at near-identical
request volume (22,643 / 23,027 / 23,101 / 23,166) and identical load shape. **Nothing was
optimised between any of these runs** — no runtime, autoscaler, or app change sits between them, and
run 4's only code delta is the harness's API-retry path, which did not fire. **This is variance, not
a trend, and the descending sequence must not be presented as improvement.** What it establishes is
unchanged from run 3: soak p99 on this cluster is not stable enough to regress against.

Recorded request volume, run 4: **157,638 requests, 0 failures** — Phase A (5) + Phase C (23,166) +
the four burst reps (134,467). This is the first run where that total covers the complete
configured experiment rather than a subset of it.

### Findings — run 4

- **The dataset is complete, and the harness said so from a real check rather than a rep count.**
  Exit 0 with `k6 metrics captured for all 10 rep(s)`. Runs 2 and 3 are the reason that line is
  trusted: run 2 silently dropped a rep and still exited 0, and run 3 correctly refused to call an
  aborted run complete. This is the first run where the verdict line reports completeness because
  the experiment actually ran.
- **The retry path is untested by real transient errors.** `api retries: 0`. Three of the previous
  runs' sessions hit `TLS handshake timeout` against the OKE API server; this one hit none, so #427's
  retry logic never engaged. Its live behaviour under a genuine control-plane blip remains
  unobserved — do not read run 4 as validation that retry works.
- **The burst A/B is inconclusive.** See [above](#the-headline-the-burst-ab-does-not-reproduce-in-either-direction).
  Both prior conclusions failed to reproduce; the ~35% p99 gap is a hypothesis, not a result.
- **The stable signals stayed stable.** Fan-out to `peak=6` in every burst rep, 0 errors across
  157,638 requests, cold-start median 3.83s (vs ~4.0 / 3.95 / 3.91s), soak median 7.49ms. Error rate,
  median latency, and pod-count behaviour are the numbers this harness measures reproducibly; tail
  and per-config latency deltas are not.

## Run 5 (2026-07-20) — #431 bytecode-cache before/after (ABORTED before the AFTER arm)

Same cluster and target (`file-manager`, OKE 2-node) as runs 1–4. This run was **not** the committed
`benchmarks/scale-to-zero-oke` harness — it was a one-off before/after script written to answer a
single question for #431: *does `NODE_COMPILE_CACHE` on a mounted PVC actually cut cold start on
OKE?*

**It never got to answer it.** The BEFORE arm completed and is valid. Enabling the bytecode cache
was rejected by Knative's admission webhook, so the AFTER arm never ran, and the script aborted
fail-closed rather than measure an unconfigured service.

```bash
# one-off, run from the scratchpad — not part of the committed harness
SAMPLES=8 ./bytecode-ba2.sh     # namespace default, service file-manager,
                                # PVC file-manager-bytecode-cache
```

### BEFORE arm — cold start (8 cold samples, `max-scale` pinned to 1)

`max-scale` was pinned to **1** for this run: the bytecode PVC is `ReadWriteOnce`, and cold start is
a single-pod measurement either way. Captured pre-run state (restored on exit): `max-scale=10`,
**11** env entries, no volumes or mounts.

| Sample | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Response time | 3.95s | 3.81s | 4.01s | 3.79s | 3.80s | 4.50s | 3.43s | 3.80s |

Median **~3.81s**, worst sample 4.50s. This sits squarely inside the band the four prior runs
established (medians **3.8–4.0s**). It adds nothing new on its own — it is the control half of a
comparison that was never completed.

### AFTER arm — never ran

Patching the service to mount the cache PVC was denied:

```
Error from server (BadRequest): admission webhook "validation.webhook.serving.knative.dev"
denied the request: validation failed: Persistent volume claim support is disabled, but found
persistent volume claim file-manager-bytecode-cache:
Persistent volume write support is disabled, but found persistent volume claim
file-manager-bytecode-cache that is not read-only:
must not set the field(s): spec.template.spec.volumes[0].persistentVolumeClaim
```

The cause is Knative's stock `config-features` defaults in namespace `knative-serving`:

| Flag | Stock default |
|---|---|
| `kubernetes.podspec-persistent-volume-claim` | `disabled` |
| `kubernetes.podspec-persistent-volume-write` | `disabled` |
| `kubernetes.podspec-volumes-emptydir` | **`enabled`** |

The third row is recorded because it points at the fix: `emptyDir` is available on a stock install
where a PVC is not. Tracked as **#436**. Note also that **ADR-0010 states the OKE cluster already
had these two flags enabled** — this rejection, on that same cluster, contradicts that premise and
is part of what #436 has to settle.

### The harness behaved correctly — and that is the finding

There is no bytecode-cache measurement in this run. There is a fail-closed check that worked:

- It **verified the mutation had applied before measuring**, reading back
  `NODE_COMPILE_CACHE=''  mount=''`.
- On seeing the mutation had not applied, it **aborted** rather than run an AFTER arm against a
  service that was still in its BEFORE configuration.
- It **restored the service exactly**: 11 env entries, no mounts, `max-scale=10`, `Ready=True`.
  (The PVC itself was left in place — deletion is human-gated under ADR-0001.)

**Without that fail-closed check this run would have published "bytecode caching: no improvement"** —
8 BEFORE samples and 8 identically-configured "AFTER" samples, agreeing to within noise, and a false
null presented as a measured result. That is precisely what the first version of this script did.

### Methodological note — one-off scripts need the committed harness's discipline

The v1 script carried three bugs, all of which mattered because it mutates a **live** service:

1. A `--type merge` patch on the containers array **replaced** it wholesale, dropping `image`, so
   the webhook rejected the patch — and **stderr was swallowed**, so the AFTER arm silently
   measured the unconfigured service. A clean-looking null that actually meant *the change never
   applied*.
2. The capture step **printed** "env/volumes/mounts confirmed empty" without checking anything. The
   service has 11 env vars; the v1 restore would have patched `env: null` and wiped
   `DATABASE_URL` / `REDIS_URL` / GCS config. Only bug 1 prevented it.
3. The trap did not fire on kill, which would have left `max-scale` pinned at 1.

The committed harness earned its fail-closed and run-integrity checks across runs 2–4 (a silently
dropped rep, an honestly-reported abort). **The lesson run 5 adds is that a throwaway measurement
script needs the same fail-loud discipline** — verify every mutation applied, restore from captured
values never from assumptions, and never swallow stderr — because a one-off script pointed at a
live service can both destroy state and publish a false result.

### Findings — run 5

- **No bytecode-caching result exists.** Do not read this run as evidence that bytecode caching
  helps, or that it doesn't. The measurement did not happen.
- **The BEFORE arm is valid** and consistent with runs 1–4: median ~3.81s over 8 samples.
- **PVC-mounted bytecode caching cannot be enabled on a stock Knative install** — both PVC feature
  flags are off by default (**#436**).
- **A fail-closed verify-before-measure check converted a would-be false null into a real finding.**

## Run 6 (2026-07-20) — compile-cache value: the first measured performance result in this document

Same cluster and target app image (`file-manager`, OKE 2-node) as runs 1–5. This run answers the
question run 5 was aborted before reaching — *what does a populated `NODE_COMPILE_CACHE` actually
buy?* — by a different method that needs no PVC, no service mutation, and no image rebuild.

**It is the first comparison in this document with complete distribution separation, and therefore
the first one reported as a result rather than as a signal worth investigating.**

### Method — alternating COLD/WARM boot pairs in one pod

A single pod runs the real application image
(`me-abudhabi-1.ocir.io/.../file-manager:ht-bdfa2fa`) with an `emptyDir` mounted at `/ccache` as the
compile-cache directory. Inside that pod:

1. Boot the **same runtime entry the image's `CMD` boots** — `node -e import('@getknext/core/internal/node-server')`
   with `STANDALONE_SERVER_PATH=apps/file-manager/server.js` — not a proxy script.
2. Wait on the **shallow, dependency-free `/api/health` route**, so the timing measures server boot
   rather than database or Redis readiness.
3. `SIGTERM` the server (so V8 flushes cache entries to disk), then repeat.

Cache files are **deleted before each COLD boot and retained for each WARM boot**, and the two arms
**alternate**, so any drift in cluster conditions over the run affects both arms equally. The pod
mirrors the app's own profile (**no CPU request**), so scheduling is not CPU-gated.

This technique is worth reusing: it isolates a boot-level optimisation **without rebuilding an
image or mutating the live Knative Service**, and the alternating-pairs shape is what makes the
separation below interpretable rather than a snapshot of one moment's cluster conditions.

### Results — 5 alternating pairs (10 samples)

| Arm | Cache state | Samples (ms) | Median |
|---|---|---|---|
| **COLD** | 0 cache files | 3266, 3112, 3144, 3244, 3162 | **3162 ms** |
| **WARM** | 1106 files / 4,246,088 bytes | 2774, 2769, 2809, 2741, 2732 | **2769 ms** |

**Delta: 393 ms (12.4%) faster boot with a populated compile cache.**

Cache size written by one boot: **1106 files / 4,246,088 bytes**.

### Why this one is reported as a result

**Every prior comparison in this document that lacked distribution separation later failed to
reproduce.** The burst-knob A/B produced two successive conclusions and flipped sign twice; it is
now recorded as inconclusive (see [run 4](#the-headline-the-burst-ab-does-not-reproduce-in-either-direction)).
Run 4's ~35% p99 gap is likewise recorded only as a hypothesis.

This measurement is different in exactly the way those were not: **the slowest WARM sample (2809 ms)
is faster than the fastest COLD sample (3112 ms) — zero overlap across all 10 samples.** There is no
value of run-to-run variance that produces that ordering by chance at this gap. That separation, not
the size of the delta, is why this is stated as a result.

### Scope of the claim — what it does and does not show

- **It measures server boot to health-ready inside a pod.** It is **not** an end-to-end Knative
  cold-start measurement.
- End-to-end cold start on this cluster is **3.81s median** (run 5, 8 samples), of which roughly
  **2s** is `Started → Ready`. A ~393 ms boot saving is therefore roughly **10% of end-to-end cold
  start** — and it targets precisely the segment #437 addresses.
- #437 bakes the cache at **image build time**, so a cold pod's *first* boot becomes the WARM case.
  This measurement demonstrates **the value of a populated cache**. It does **not** yet demonstrate
  that the build-time warm-up produces an equivalent cache — **CI building the image is the first
  test of that**, and **no image carrying the baked cache has been deployed or measured**.
- **Image-size growth from the baked cache is unmeasured.**

### Root cause this confirms

`apps/file-manager/Dockerfile` created an **empty** compile-cache directory that nothing ever
populated, then pointed `NODE_COMPILE_CACHE` at it. Every cold pod therefore compiled the standalone
server from scratch, wrote the cache to the ephemeral container layer, and **discarded it on
scale-to-zero** — so the cache never paid off across pods, and the "faster subsequent cold starts"
comment in the Dockerfile was false as shipped. That recompilation is a large part of the ~2s
`Started → Ready` segment measured in runs 1–5.

Fixed in **#437** (build-time cache warm-up baked into the image layer, with a build failure if the
cache ends up empty). The **identical bug exists in `apps/docs/Dockerfile`** and is tracked as
**#439**.

### Findings — run 6

- **A populated compile cache is worth ~393 ms (12.4%) of server boot on this app**, with complete
  distribution separation across 10 alternating samples — the first non-overlapping comparison in
  this document.
- **That is ~10% of end-to-end cold start** (3.81s median), and it is the segment #437 targets.
- **The baked-cache image itself is still unmeasured.** Equivalence between the build-time warm-up
  and a runtime-populated cache, and the image-size cost, are both open.
- **The root cause is confirmed, not inferred:** an empty cache directory shipped in the image,
  refilled and discarded on every cold pod.

## Run 7 (2026-07-20) — startup ablation: is instrumentation costing us boot time? (NULL result)

> **⚠️ Annotation (added after run 9). Do not read this null at face value.** Run 9 showed that
> `KN_METRICS_PORT=0` — the toggle this run used to "disable metrics" — **never disabled
> `collectDefaultMetrics()`**, which runs unconditionally at module scope in
> `node-server.ts:45-46`. Every arm below, including `NEITHER`, therefore paid the identical
> metrics-collection cost. **The four arms were not four arms.** The null is real as reported,
> but it does not mean what it was written to mean: it rules out the metrics *server*, and says
> nothing about the process-metrics collector that run 9 identifies as the likely competitor for
> CPU. See [run 9](#run-9-2026-07-20--attributing-the-842-ms-wrapper-overhead) and
> [the lesson this run teaches about ablation design](#the-lesson-an-ablation-that-toggles-the-wrong-knob-produces-a-confident-null).

Run 6 left ~2.7s of warm-cache boot unexplained. Run 7 asks the cheapest question available about
it: **do knext's own OTel tracing or metrics server contribute measurably to boot time?** Both are
knext code that runs before the server is health-ready, so both were plausible suspects.

**The answer is no, and that null result is the reportable finding** — it is what redirected the
search onto the wrapper, which run 8 then measured.

### Method — four interleaved arms in one pod, all warm

Same cluster and app image as runs 1–6, and the same in-pod technique as run 6 — one pod, an
`emptyDir` compile cache **primed before the first arm** so every arm is a WARM boot, `SIGTERM`
between boots, timing taken to the shallow dependency-free `/api/health` route. **3 reps of each
arm, interleaved**, so cluster drift over the run hits all four arms equally.

| Arm | Toggle | Samples (ms) | Median |
|---|---|---|---|
| **BASELINE** | — | 2760, 2675, 2734 | **2734 ms** |
| **NO_OTEL** | `OTEL_TRACING_ENABLED=false` | 2778, 2693, 2742 | **2742 ms** |
| **NO_METRICS** | `KN_METRICS_PORT=0` | 2715, 2967, 2714 | **2715 ms** |
| **NEITHER** | both | 2714, 3032, 2674 | **2714 ms** |

### Why this is reported as a null, not as a small effect

**All four medians fall within ~30 ms of each other, and the spreads overlap heavily** — NO_METRICS
spans 2714–2967, NEITHER spans 2674–3032, and each of those ranges contains every other arm's
median. There is **no distribution separation**, so by the standing bar in this document — the same
bar that made [run 6](#why-this-one-is-reported-as-a-result) reportable and left runs 1–4's burst
A/B inconclusive — **there is nothing here to report except the absence of an effect.**

Reported the other way round, a 30 ms "improvement" from disabling OTel would be exactly the kind of
noise-sized claim that failed to reproduce three times earlier in this document.

### Honest caveat on what was actually ablated

`KN_METRICS_PORT=0` **skips the listen, not the module import.** This run therefore rules out the
cost of the metrics *server* — binding and serving — but **not** the cost of importing `prom-client`
at module scope, which still happens in every arm. A future ablation that removes the import itself
would be needed to close that gap.

### Findings — run 7

- **Neither OTel tracing nor the metrics server is a measurable contributor to boot time.** Two
  plausible suspects ruled out at a cost of 12 boots.
- **No distribution separation ⇒ reported as null.** The methodological bar this document uses cuts
  both ways: it withholds small positive claims and it makes a null result meaningful.
- **The remaining boot cost is elsewhere** — which is what motivated run 8.
- **Scope limit:** rules out the metrics *server*, not the `prom-client` module import.
- **⚠️ Superseded in part by run 9.** The first bullet overstates its reach. The ablation never
  disabled `collectDefaultMetrics()`, so "metrics ruled out" should be read strictly as "the
  metrics *listen* is ruled out." The correct standing claim is the narrower one in the scope
  limit — which run 7 already stated, and which run 9 shows was the load-bearing sentence.

## Run 8 (2026-07-20) — cold-boot decomposition: the knext wrapper costs 842 ms

With instrumentation ruled out, run 8 asks where the remaining ~2.7s of warm-cache boot actually
goes, by booting **Next.js's own `server.js` directly** and comparing it against **the knext wrapper**
(the parent process that spawns the standalone server as a child).

**This is the second comparison in this document with complete distribution separation, and it is
the largest knext-controlled cost measured so far.**

### Method — same in-pod technique as run 6, applied to two boot paths

One pod, the real application image, an `emptyDir` compile cache **primed for both boot paths
before measurement** so every sample is a WARM boot, `SIGTERM` between boots, timing to the shallow
`/api/health` route. Part B **alternates the two arms in pairs**, so drift in cluster conditions
affects both equally.

As in run 6, this needs **no image rebuild and no mutation of the live Knative Service** — which is
precisely why it can isolate a boot-level effect this cleanly.

### Part A — 3 reps each

| Arm | Samples (ms) | Median |
|---|---|---|
| Bare `node` process floor | 75, 70, 138 | **75 ms** |
| Next.js `server.js` alone | 2234, 1930, 2361 | **2234 ms** |
| knext wrapper (parent + child) | 2887, 2839, 2732 | **2839 ms** |

### Part B — 6 alternating pairs (the tighter measurement)

| Arm | Samples (ms) | Median |
|---|---|---|
| **NEXTJS** (`server.js` alone) | 1972, 1934, 1940, 2449, 1950, 1961 | **1957 ms** |
| **WRAPPER** (knext parent spawns child) | 2845, 2718, 2804, 2794, 2847, 2708 | **2799 ms** |

**Delta: 842 ms (+43%) added by the knext wrapper over booting Next.js directly.**

**Separation is complete: the slowest NEXTJS sample (2449 ms) is faster than the fastest WRAPPER
sample (2708 ms) — zero overlap across all 12 samples.** As with run 6, it is that ordering, not the
size of the delta, that makes this a result rather than a signal.

### Decomposition of a warm-cache boot

| Segment | Cost | Share |
|---|---|---|
| `node` process floor | ~75 ms | 3% |
| Next.js's own boot | ~1957 ms | 70% |
| knext wrapper | ~842 ms | 30% |

### Why this matters more than its size suggests

- **It is ~2.1× the 393 ms the baked compile cache saved** (run 6, shipped as **#438** / ADR-0035) —
  the largest boot win this document has recorded to date.
- **Unlike Next.js's own 1957 ms, it is entirely within knext's control.** The 70% belongs upstream;
  the 30% is knext's code.
- **Run 7 already rules out instrumentation as the cause**, which points the remaining suspicion at
  the **child-process spawn architecture and parent-side module loading** — the parent boots a full
  Node module graph before the child that actually serves traffic even starts.

That last point is an interpretation of two measurements, not a third measurement. **No fix has been
designed, attempted, or measured**, and the split between spawn overhead and parent-side module
loading is unattributed.

> **Annotation (added after run 9).** That standing hypothesis — parent-side module loading —
> **was measured and refuted.** The parent's module load plus spawn costs ~52 ms, not ~842 ms. The
> 842 ms measurement below stands unchanged; only its attribution moved. See
> [run 9](#run-9-2026-07-20--attributing-the-842-ms-wrapper-overhead).

### Findings — run 8

- **The knext wrapper adds 842 ms (+43%) to warm-cache boot**, with complete distribution separation
  across 12 alternating samples.
- **Warm-cache boot decomposes as ~3% node floor / ~70% Next.js / ~30% knext wrapper.**
- **This is the largest knext-owned cold-start cost measured so far** — ~2.1× the compile-cache win.
- **Cause is narrowed, not identified:** instrumentation is excluded (run 7); spawn architecture and
  parent-side module loading are the standing hypotheses, unmeasured.
  **⚠️ Both clauses of this bullet were overturned by run 9:** parent-side module loading is
  refuted (~52 ms), and instrumentation was never actually excluded, because run 7's toggle did
  not disable `collectDefaultMetrics()`.

### Scope — same limits as run 6

Runs 7 and 8 measure **boot-to-shallow-health inside a pod**, not end-to-end Knative cold start
(**3.81s median**, run 5). They are single-environment measurements on one 2-node OKE cluster with
one app image, and are **environment-dependent**.

## Run 9 (2026-07-20) — attributing the 842 ms wrapper overhead

Run 8 **measured** the wrapper's 842 ms. Run 9 asks **where it goes** — and the answer refutes the
hypothesis that was filed as **#441** on the strength of run 8's interpretation.

The filed hypothesis was that the parent process pays ~842 ms loading its own module graph
(`prom-client` and friends) before the child that actually serves traffic starts. **That is wrong by
a factor of sixteen.**

### Part A — split the wrapper into parent cost and child cost (3 reps)

| Segment | Samples (ms) | Median |
|---|---|---|
| Parent module-load + spawn | 53, 52, 51 | **52 ms** |
| Child boot (via the wrapper) | 3339, 2804, 2709 | **2804 ms** |

**The parent costs ~52 ms, not ~842 ms.** The overhead is not in the parent's own startup work at
all. What the numbers say instead is stranger and more specific: **the same Next.js server boots
~847 ms slower merely because the wrapper is running alongside it.**

Two adjacent explanations were ruled out by inspection rather than measurement, and are reported as
such:

- **Spawn arguments are byte-identical to a direct run under Node.** `preloadArgs` only populates
  under Bun, so the child is invoked exactly as `server.js` would be invoked directly.
- **`buildChildEnv` is benign.** It blanks `HOSTNAME`, sets `PORT`, and adds `KNEXT_POD_NAME`.
  Nothing there changes how Next.js boots.

So neither the arguments nor the environment explain the gap. Whatever costs 847 ms happens
**while** the child boots, not before it.

### Part B — CPU contention test (3 pairs, no CPU limit, mirroring the real pod)

If the parent isn't slow and the child isn't invoked differently, the remaining candidate is that
the parent **competes with the child for CPU** during boot. Part B tests whether contention of that
magnitude is even achievable, by booting `server.js` alone versus alongside a deliberately busy
sibling `node` process — with no CPU limit set, mirroring the real pod.

| Arm | Samples (ms) | Median |
|---|---|---|
| `server.js` **alone** | 1938, 2015, 2091 | **2015 ms** |
| `server.js` **+ busy sibling node process** | 2945, 2995, 2966 | **2966 ms** |

**Delta: 951 ms.** **Separation is complete — the slowest alone sample (2091 ms) is faster than the
fastest with-busy sample (2945 ms), zero overlap.** By the standing bar in this document, that
ordering is what makes Part B reportable as a result rather than a signal.

### Mechanism — what is actually running during the child's boot

`node-server.ts:45-46` calls **`collectDefaultMetrics()` at module scope**, which starts a periodic
process-metrics collector in the parent. That collector keeps running for the entire duration of the
child's boot. And `file-manager` pods **request 0 CPU**, so they are scheduled onto an
oversubscribed node where CPU is genuinely contended — this is not a theoretical scheduling concern
on this cluster.

### The lesson: an ablation that toggles the wrong knob produces a confident null

This is the most transferable finding in run 9, and it is a methodological one.

[Run 7](#run-7-2026-07-20--startup-ablation-is-instrumentation-costing-us-boot-time-null-result)
reported a clean null: four arms, medians within ~30 ms, no separation, instrumentation ruled out.
Run 9 explains **why that null was inevitable regardless of the truth**. `KN_METRICS_PORT=0` skipped
the metrics *listen*; it never disabled `collectDefaultMetrics()`. **Every arm — baseline,
`NO_OTEL`, `NO_METRICS`, and `NEITHER` alike — ran the same process-metrics collector and paid the
same cost.** The experiment compared four copies of the same condition.

Note what did *not* fail here. The statistics were sound, the interleaving was right, the bar for
separation was correctly applied, and the null was honestly reported. **A well-executed experiment
on the wrong knob still yields a confident, wrong-feeling-of-certainty answer.** Run 7's own scope
caveat — "rules out the metrics *server*, not the module import" — was the one sentence that
survived contact with run 9, and it was written as a footnote rather than as the headline. The
generalizable rule: **before trusting a null, verify that the toggle actually changed the thing
being ablated.** A null is only as strong as the difference between the arms.

### The busy-loop is a proxy — what Part B does and does not prove

Part B does **not** prove the parent's metrics work is the competitor. It proves something weaker
and worth stating precisely:

- **What it proves:** CPU contention of this magnitude (~951 ms) is achievable in this pod
  configuration, and is **consistent with** the 847 ms measured in Part A.
- **What it does not prove:** that `collectDefaultMetrics()` specifically is the process consuming
  that CPU. A busy loop is not a periodic metrics collector; matching magnitudes are corroboration,
  not identification.

**The falsification condition, stated plainly:** the decisive test is to **defer the parent's
metrics startup and re-measure the wrapper** — which is the work in flight under **#441**. If
deferring it closes the ~847 ms gap, the hypothesis holds. **If it does not close the gap, the
hypothesis is wrong**, and the correct response is to **re-profile** — not to reach for a second
patch on the same theory. Two patches on an unfalsified hypothesis is how run 7's mistake repeats
itself at a larger cost.

### Reproduction method

**Part A — splitting the wrapper.** One pod, the real application image, an `emptyDir` compile cache
primed before measurement so every sample is a WARM boot, `SIGTERM` between boots, timing to the
shallow dependency-free `/api/health` route — the same in-pod technique as runs 6–8. The wrapper's
boot is instrumented at two points: the parent's timestamp immediately before it spawns the child
(giving parent module-load + spawn), and the child's time to health (giving child boot). 3 reps.
The spawn-argument and environment checks are code inspection of `node-server.ts` `preloadArgs` and
`buildChildEnv`, not measurements.

**Part B — contention.** Same pod, same warm cache, **no CPU limit set** so the pod mirrors the real
`file-manager` deployment's 0-CPU-request scheduling. Each pair boots `server.js` directly to health
twice: once with nothing else running, once with a sibling `node` process spinning a busy loop for
the duration of the boot. 3 alternating pairs, `SIGTERM` between boots, so cluster drift hits both
arms equally.

### Findings — run 9

- **The parent's own module load and spawn cost ~52 ms, not ~842 ms** — the hypothesis filed in
  **#441** is refuted by a factor of ~16.
- **The same Next.js server boots ~847 ms slower with the wrapper running alongside it**, with the
  spawn arguments byte-identical and the child environment benign.
- **CPU contention of that magnitude is demonstrably achievable** (951 ms, complete separation) in a
  pod that requests 0 CPU on an oversubscribed node.
- **`collectDefaultMetrics()` at module scope (`node-server.ts:45-46`) is the identified suspect**,
  running for the whole of the child's boot.
- **Run 7's null is explained and should not be cited as "instrumentation ruled out."** Its ablation
  never disabled the collector, so all four arms were the same condition.
- **The suspect is not confirmed.** The busy loop is a proxy; the decisive test is deferring the
  parent's metrics startup (#441) and re-measuring.

### Scope — same limits as runs 6–8

Run 9 measures **boot-to-shallow-health inside a pod**, not end-to-end Knative cold start
(**3.81s median**, run 5). It is a single-environment measurement on one 2-node OKE cluster with one
app image, and is **environment-dependent** — and the contention effect in particular depends on the
node being oversubscribed, which is a property of this cluster and this pod's 0-CPU request.


## Run 13 (2026-07-21) — ADR-0036 P1b: two-target cold-boot A/B on OKE

The **first OKE measurement of the optional `bun-exec` build target** proposed in
[ADR-0036](../adr/0036-optional-vinext-bun-build-target.md) (node stays the default;
this target is opt-in and compat-gated). It answers a narrow question: on **equal minimal
footing**, how much cold-boot does a `vinext → bun --compile` single executable save versus the
default Next-standalone-on-node path?

This run is deliberately **not** the `file-manager` app the runs above measure — it is a minimal
app built three ways so the comparison is apples-to-apples. Same cluster class (OKE 2-node), a
different, purpose-built harness.

> **Appended independently of PR #442.** Runs 7–12 live in an open, unmerged PR (#442) that is not
> reflected in this file on `main`. Run 13 is added here as a self-contained section and makes no
> reference to those runs' numbers; it is the ADR-0036 **P1b** measurement and stands on its own.

### Method — three in-cluster pods, one minimal app built three ways

Three `node:22` pods on OKE (**150m** CPU request / **2** CPU limit, mirroring the app's burst
profile). Each pod builds a **minimal app** — one page plus a shallow, dependency-free
`/api/health` route — and measures **process spawn → first HTTP 200 on `/api/health`**. The
minimal surface is identical across all three paths, which is the entire point: it isolates the
*runtime/boot* difference and removes the app itself as a variable.

This is **in-pod boot, not full Knative cold start.** It does not include scale-to-zero →
activator → schedule → image pull — only the spawn-to-first-200 boot segment.

Toolchain pins (per P1a): **vinext `1.0.0-beta.2`**, **`@vitejs/plugin-rsc` `^0.5.27`**, **nitro
`3.0.260610-beta`**.

Reproduction scripts (three in-cluster `node:22` pods; build + bench):
[`scratchpad/oke-vinext-bench.sh`] and [`scratchpad/oke-next-baseline.sh`] — the vinext/bun and the
Next-standalone-baseline builders respectively.

### Results — median spawn → first-200 (minimal app, in-cluster native x64)

| Path (minimal app, OKE) | Samples (ms) | Median | Artifact size |
|---|---|---|---|
| Next standalone → node | 1079, 852, 846, 967, 766 | **~852 ms** | `.next/standalone` 77 MB |
| vinext → node | 322, 306, 316, 318, 315, 329 | **~317 ms** | `.output` 1.1 MB |
| vinext → `bun --compile` binary | 226, 261, 248, 177, 277, 181 | **~237 ms** | binary 137 MB (native x64 in-cluster) |

**Complete distribution separation:** the slowest `vinext-bun` sample (**277 ms**) is faster than
the fastest Next-standalone sample (**766 ms**) — zero overlap. By this document's own bar (a
result is only reported when the distributions do not overlap; see [run 6](#run-6-2026-07-20--compile-cache-value-the-first-measured-performance-result-in-this-document)),
this separation is what makes it reportable as a **result** rather than a signal.

### Headline finding — framed honestly

- **`vinext-bun` boots ~3.6× faster than Next-standalone-node** on this minimal app (237 vs
  852 ms), with complete separation.
- **Attribution — most of the win is vinext, not bun.** vinext-on-node already accounts for
  **852 → 317 ms (~2.7×)**, because vinext (Vite/rolldown) never boots Next's standalone server at
  all. `bun --compile` adds a **further, still-separated ~1.3× (317 → 237 ms)** plus the benefit of
  single-file distribution. The compile step is the smaller half of the improvement.
- **Explicit correction of an earlier over-claim.** A prior framing cited **"~44× vs 1957 ms."**
  That compared the *heavy* `file-manager` app's boot to a *minimal* vinext app — **not
  apples-to-apples**, and the ratio is withdrawn. On equal minimal footing the ratio is **~3.6×**.
  A heavier app grows **both** sides of the comparison, so the real-world ratio is **app-dependent
  and must be measured per app**, never extrapolated from this minimal number.

### Confounds — recorded in full, none buried

- **Minimal app only.** `file-manager`-class apps differ, and `file-manager` is specifically
  **`bun-exec`-INELIGIBLE**: `next/image` + `sharp` are lost under vinext. The apps that benefit
  most from this target are not the apps this run measured.
- **In-pod boot, not full Knative cold start.** No scale-to-zero → activator → schedule segment is
  included; the end-to-end cold-start numbers elsewhere in this document (3.8–4.0s median) are a
  different, larger measurement.
- **Binary is 137 MB** (native x64 built in-cluster; a cross-compiled musl build was 104–108 MB).
  The **first-ever image-pull cost on a fresh node is NOT measured** — the layer was already
  present on the node during timing.
- **Beta toolchain.** vinext-beta is pinned to nitro-beta; this carries real
  maintenance/abandonment risk for anything that would ship on it.
- **The `RuntimeContract` is NOT tested.** SIGTERM drain + `after()`, the in-process `:9091`
  metrics endpoint, the Redis `cache-handler`, Bearer-auth cache routes, and the ADR-0027
  `globalThis` seam are all unverified under this target. That is **P2**, and it is the gate to a
  *shippable* target — a fast boot with an unmet runtime contract is not a deployable path.

### Findings — run 13

- **A `vinext → bun --compile` single executable boots ~3.6× faster than Next-standalone-node on a
  minimal app** (237 vs 852 ms), with complete distribution separation across all samples — a
  result by this document's separation bar.
- **The win is mostly vinext (~2.7×), with bun-compile adding a further separated ~1.3×** plus
  single-file distribution. Do not attribute the whole gap to `bun --compile`.
- **The earlier "~44×" framing is withdrawn** as a heavy-vs-minimal mismatch; the honest, apples-to-apples
  figure is **~3.6×**, and it is app-dependent.
- **This is a boot-segment result on a minimal, `bun-exec`-eligible app — not a shippable target.**
  Runtime-contract verification (P2), full Knative cold start, image-pull cost, and heavy-app
  behavior are all still open; and per ADR-0036, `bun-exec` ships only if a separated win survives
  those. `bun-exec` remains **opt-in and compat-gated**; node stays the default.


## Recipe RuntimeContract validation on OKE (#447, bun-exec)

This is a **correctness validation, not a benchmark A/B.** It confirms the opt-in `examples/bun-exec`
recipe's RuntimeContract holds in a **real `bun --compile --bytecode` linux/musl binary** built from
the committed `build.sh` — the gap that the macOS unit tests and the five review gates could not close.
An in-cluster Job cloned the PR branch, ran `build.sh` (frozen install → `vite build` with
`NITRO_PRESET=node-server` → `bun --compile`), and exercised the compiled binary in-pod.

| Contract probe | Result |
| --- | --- |
| Compiled binary size | 121 MB |
| Boot → first `/api/health` 200 (in-pod, minimal recipe app) | 659 ms |
| `/api/health` (shallow, ADR-0026 — no PG/Redis dial) | `200 {"status":"ok","target":"bun-exec"}` |
| `:9091/metrics` Prometheus exposition while up | `200`, valid `# HELP` |
| `/api/cache/invalidate` — no token / wrong token / right token | `401 / 401 / 200` (fail-closed Bearer) |
| SIGTERM fired mid-flight into a 2 s `/slow` request | request completes `200`, drained at 2052 ms |
| Process exit code after drain | `0` |

**A deployment bug this caught (and why it matters).** The first validation run bound the servers to
`process.env.HOSTNAME`, which Kubernetes sets to the **pod name** — an unreachable host. The binary
ran (drain exited 0) but served nowhere: boot to first health 200 took 12138 ms and every probe was a
connection refusal. Neither the macOS tests nor any of the five review gates saw it, because the bug
lived in the gap between "reads HOSTNAME from env" (reviewable) and "k8s injects the pod name as
HOSTNAME" (only visible on a real cluster). The fix mirrors the node path's `isBindOrLoopback`
(`packages/kn-next/src/adapters/env.ts`): bind `0.0.0.0` unless `HOSTNAME` is an explicit
bind/loopback address. The table above is the **post-fix** re-validation.

**Scope — what this does and does not show.** It shows the recipe's shipped binary satisfies the
RuntimeContract (shallow health, in-process `:9091`, fail-closed auth, SIGTERM drain) when bound
correctly. It is **not** a cold-start comparison against the node/official-adapter path — the
`boot_ms` here is in-pod process boot for a minimal recipe app, not end-to-end cold start, and is not
comparable to the file-manager runs above. The recipe cold-start A/B (the ADR's P1b gate) remains
unmeasured; run 13 is the closest apples-to-apples build/boot comparison to date.

## Run 14 (2026-07-21) — supervisor non-safety init deferred off cold-start (#441/#443)

The node/official-adapter path's own cold-start optimization: the knext supervisor's heavy import
graphs (`@getknext/lib/clients` → `@cerbos/grpc`+`minio`+`pg`; `./metrics` → `prom-client`+OTel;
`./image-cache-sync`) are converted from **static to dynamic imports** so they load **after** the
child is serving rather than before the spawn. `:9091` still binds eagerly (lightweight listener,
heavy collector lazy on first scrape) and all SIGTERM shutdown-safety wiring stays eager.

**Method.** In-pod on OKE, both branches built from source with the repo's own pnpm+turbo build.
The built supervisor (`dist/adapters/node-server.js`) is run with a **trivial one-line child** (an
`http.createServer` that binds `:3000` instantly), so the child's own boot is ~0 and
process-start → first child `/api/health` 200 **isolates the supervisor's import-graph cost**. 8
reps per arm. Pod limit 2 CPU (less oversubscription than a 0-CPU-request pod, so the effect here
is a floor, not the worst case).

| Arm | reps (ms, process-start → child health-200) | median |
| --- | --- | --- |
| **AFTER** — #443, heavy graphs deferred | 501, 533, 546, 552, 576, 577, 592, 1074 | **~564** |
| **BEFORE** — main, heavy graphs static pre-spawn | 1090, 1097, 1108, 1114, 1126, 1154, 1158, 1386 | ~1120 |

**Result — complete distribution separation.** Every AFTER rep (max **1074 ms**) is faster than
every BEFORE rep (min **1090 ms**): **zero overlap**, the evidence bar the burst-A/B runs above
never cleared. Deferring the import graph roughly **halves** the supervisor's contribution to child
boot (~1120 → ~564 ms median, **~556 ms / ~2×**). `:9091` first-hit returned `200` in **both** arms,
confirming the eager-bind is preserved and the earlier drain-gate regression is not reintroduced.

**Scope.** This measures the **supervisor's in-pod boot contribution** with a trivial child on a
2-CPU pod — it isolates the deferral's mechanism, it is **not** end-to-end cold start. The PR's
hypothesized ~847 ms was on a 0-CPU-request oversubscribed pod where the supervisor and a real
Next.js child compete harder; the ~556 ms here (less contention) is the same effect measured with
more CPU headroom. Direction and separation are decisive; the absolute magnitude scales with pod
CPU pressure. This is the deferral's isolated cost, not a portable cold-start guarantee.

## Run 15 (2026-07-21) — p99 cold start under a thundering-herd wake (#309 A4)

The reliability edge the median hides: when a **burst of concurrent requests wakes a scaled-to-zero
app at once**, what does the *tail* of their cold-start latency look like — and is it stable? This is
the AC of #309 (p99 cold-start under concurrency, not just median).

**Method.** Target = the deployed `file-manager` Knative Service (minScale 0, **maxScale 10**,
unbounded containerConcurrency — measured **as-deployed**, no config mutation). For each of **8
rounds**: verify the app is genuinely scaled to zero (the exit-code-checked `wait_zero` from #452 —
a failed pod query is never read as zero, so no warm round can be recorded as cold), then fire a
**50-request thundering herd** (k6 `shared-iterations`, 50 VUs × 1 request, all at ~t=0) and record
the round's `http_req_duration` distribution + peak pod fan-out. 400 cold requests total.

| Round | med | p95 | p99 | max | peak pods |
| --- | --- | --- | --- | --- | --- |
| 1 | 5.04s | 5.16s | 5.16s | 5.16s | (sampler miss) |
| 2 | 4.91s | 5.11s | 5.11s | 5.12s | 3 |
| 3 | 5.13s | 5.35s | 5.36s | 5.36s | 3 |
| 4 | 6.41s | 6.51s | 6.52s | 6.52s | 4 |
| 5 | 6.48s | 6.64s | 6.65s | 6.65s | 4 |
| 6 | 5.67s | 5.92s | 5.93s | 5.93s | 4 |
| 7 | 6.93s | 7.09s | **7.11s** | 7.11s | 4 |
| 8 | 6.21s | 6.36s | 6.36s | 6.36s | 4 |

**Findings.**
- **Failure-free.** All 50 requests completed in every round — 400/400 cold requests served (each
  round reported `reqs=50`), and every duration landed in the 5–7 s band, far under the 170 s request
  timeout, with no low-side outliers that would signal an early error. (The runner captured the
  request count, not an explicit `http_req_failed` line, so "failure-free" is grounded in that
  distribution shape rather than a failure-rate metric.) No request was stranded behind the activator queue.
- **The tail is tight WITHIN a round.** In every round p99 ≈ p95 ≈ max ≈ median (e.g. round 7: median
  6.93s → p99 7.11s, a ~180 ms spread across 50 concurrent requests). Knative's activator holds the
  herd and releases it together once ~3–4 pods are Ready, so the 50 requests finish in a narrow band
  rather than leaving a long intra-round tail.
- **The variation is ACROSS rounds, not within.** Round-level p99 ranges **5.11s → 7.11s** (worst
  observed p99 = 7.11s; median-of-round-p99 ≈ 6.1s). The practical "tail" of a herd wake is *which
  cold round you land in*, not a stranded request inside a round.
- **Herd overhead over a single cold request.** A single cold request measured ~4s median / 5.5s
  observed (runs 4–6, and a 5.5s probe here); a 50-herd's p99 is ~5–7s — the herd adds ~1–3s from
  activator queueing + booting 3–4 pods instead of 1, but stays bounded.
- **The intermittent extreme outlier did not reproduce.** The 17.6s-class tail seen once in an
  earlier run (noted in #429) did not appear across these 8 rounds — reassuring, but 8 rounds is a
  small sample and does not exclude it.

**Scope.** As-deployed `file-manager` on this specific 2-node OKE cluster, herd=50, 8 rounds, external
sslip.io ingress path. Not a knob A/B and not a portable guarantee — a characterization of the
tail's shape and stability. The measurement's integrity depends on #452: every round confirmed a real
scale-to-zero (`z=OK`), so no warm sample was recorded as cold. `peak pods` for round 1 was a sampler
timing miss (pods came and went inside the gap), not a real zero — the 50 requests were served.
Higher-concurrency characterization (herd 100/200, or a pinned low containerConcurrency to force
queue depth) is a follow-up.

## Run 16 (2026-07-21) — ADR-0036 P1b end-to-end A/B: node arm measured, **bun-exec arm BLOCKED**

The P1b ship-gate for ADR-0036 asks: deployed as **real Knative Services**, does the opt-in
`bun-exec` build target beat the node target end-to-end (scale-from-zero → first request), not just
in the in-pod build/boot that run 13 measured? Both targets were built in-cluster (kaniko → OCIR) and
deployed as scale-to-zero ksvcs (minScale 0 / maxScale 10, digest-pinned, same resources).

**bun-exec arm — could not be measured; the target is not deployable (#460).** The compiled binary
(`nitro` bun preset → `bun build --compile --bytecode`) embeds the **build machine's absolute
`.output/` path** and loads its SSR/route chunks from it at runtime. Deployed as a container (the
recipe's documented "single executable in a bare Alpine image" ship path), it serves the framework
404 for **every** route — verified across three image builds (node-server preset, bun preset, and bun
preset with `.output/` copied to the image). `strings` on the binary shows the embedded absolute path.
Every prior validation (#447 RuntimeContract, the P1a/P2 spikes, run 13) ran the binary **from its
build directory**, where that absolute path still resolves — masking a non-portable artifact. So P1b's
A/B cannot be run until #460 is fixed; run 13's ~3.6× in-pod *boot* delta remains the best available
signal but does **not** come from a deployable artifact.

**node arm — measured (the baseline the A/B would compare against).** Minimal Next `output:standalone`
→ bare `node server.js`, 8 sequential single-request cold starts, each wait-for-zero'd (#452 verify);
all returned `200`.

| rep | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cold start | 2.79s | 2.09s | 2.16s | **10.76s** | 1.70s | 2.66s | **11.22s** | 2.04s |

- **Median ~2.4s**, with 6 of 8 reps tightly in **1.70–2.79s** — a minimal-app end-to-end cold start
  (small image, fast node boot) well below the ~4s median of the larger `file-manager` app.
- **The intermittent extreme tail is real: 2 of 8 reps spiked to ~11s.** This is the outlier class
  #429 flagged (and which run 15's *herd* did not show — a herd is released together once pods are
  Ready, averaging out the spike; single sequential cold starts expose it). The practical node
  cold-start tail is "usually ~2s, occasionally ~11s," not a stable number.

**Scope / verdict.** As-deployed minimal apps on this 2-node OKE cluster. The honest ADR-0036 P1b
conclusion is that **the ship-gate cannot be cleared: `bun-exec` is not deployable as a container**
(#460), so no end-to-end win can be demonstrated. The node target deploys and serves; its end-to-end
cold start is ~2.4s median with an intermittent ~11s tail. Both `p1b-*` ksvcs and their OCIR images
are leftover on the cluster for a maintainer to clean (operator-gated deletes).

## Run 17 (2026-07-22) — ADR-0036 P1b A/B, both arms deployed (bun-exec now self-contained, #460 fixed)

The bun arm that run 16 could not measure is now deployable: **#460 is fixed** — the bun+vinext recipe
produces a genuinely self-contained binary (version revert to the proven nitro-alpha/vinext-0.0.19
combo that bundles the server + a rewritten entry that imports `#nitro/virtual/polyfills` and delegates
to srvx's real request handler). Both build targets are deployed as scale-to-zero Knative Services
(minScale 0, maxScale 10, 0-CPU-request) and the bun+vinext ksvc serves `200` (`/api/health`, `/`,
`:9091`, fail-closed cache auth) — validated end-to-end.

**This is a DIRECTIONAL result, not a distribution.** The full 8-rep-per-arm A/B could not be captured
cleanly: by this point the 2-node OKE cluster was heavily contended (dozens of leftover experiment
Jobs, two 30–44 h stray `Pending` pods, multiple ksvc revisions — none deletable without operator-gated
`kubectl delete`), which flaked every automated multi-rep runner. Single verified cold-start jobs ran
fine; the samples below are those.

| Arm | clean cold-start samples (scale-from-zero → first `/api/health` 200) |
| --- | --- |
| **bun+vinext** (self-contained binary) | **2.07 s, 2.13 s** |
| **node** (minimal Next standalone) | **2.79 s** (+ run 16's ~2.4 s median / ~11 s intermittent tail) |

**Finding — as deployed here, the build target is only a modest lever; image caching is the likely
locus of the real win (unmeasured).** bun+vinext (~2.1 s) edges node (~2.4–2.8 s) by only a few hundred
ms — **not** the ~600 ms regime, and far less than run 13's in-pod ~3.6× build/boot separation. (Caveat:
run 13's boot delta was measured on the newer beta pins; this deployment reverted to the nitro-alpha /
vinext-0.0.19 combo for self-containment, so the boot advantage is directionally-but-not-identically
comparable.) The reason the edge shrinks end-to-end is the one run 16 already named:
end-to-end cold start is dominated by **pod scheduling + activator queueing + image pull**, all
**target-independent**. bun's compiled-boot advantage is *real* (run 13) but is **largely absorbed by
that shared floor** once deployed. The founder's original ~600 ms bun cold start relied on a **second,
orthogonal lever — Docker/Knative image caching** (image pre-pulled to nodes → ~0 pull time) — without
which the boot advantage cannot show through. **Decision-relevant takeaway:** the two-target payoff is
gated on image caching at least as much as on the build target; a bun+vinext deployment *without* image
caching is only marginally faster than node.

**Scope.** As-deployed minimal apps on a specific, degraded 2-node OKE cluster; 2 clean cold samples per
arm (not a distribution). A trustworthy full-distribution A/B needs a clean cluster (the leftover
`p1b-*`/experiment clutter requires operator-gated cleanup) and the image-caching lever wired in to
reach the ~600 ms regime. No portable cold-start guarantee is claimed. What run 17 DOES establish
firmly: the bun+vinext target is now deployable and serving (#460 closed), and the naive as-deployed
cold-start edge over node is modest.

## Run 18 (2026-07-22) — image-pull cost: the measured basis for image caching (#309 / bun-exec)

Run 17 found the bun+vinext cold start was ~2.1s **with the image already node-cached** (no pull). This
run quantifies what caching actually saves by deploying a **fresh-content** image (a cache-busting layer
so it is not present on any node) and reading the pull duration from the pod's `Pulling`→`Pulled` events:

- **Image size:** 104,965,037 bytes (~105 MB) — the bun+vinext binary (~57 MB Bun runtime + app) + Alpine.
- **Pull duration:** **2.09 s** (kubelet: "Successfully pulled … in 2.09s"), on this OKE node from OCIR.

| cold-start scenario | image pull | end-to-end (as-deployed minimal app) |
| --- | --- | --- |
| **warm image** (node already has it) | ~0 | **~2.1 s** (run 17) |
| **cold image** (fresh node / new digest / evicted layer) | **~2.09 s** | **~4.2 s** |

**Finding — image caching roughly HALVES the uncached cold start (~4.2 s → ~2.1 s).** For a scale-to-zero
app this is a real, recurring hazard, not an edge case: containerd can evict an idle image, a new/replaced
node starts empty, and a fresh deploy's first cold start on each node pays the full ~2 s pull. This is the
orthogonal lever run 17 flagged, now measured: pre-pulling the app image onto every node (so scale-from-zero
never waits on the ~105 MB pull) removes ~2 s from the worst-case cold start — the difference between the
warm ~2.1 s and the cold ~4.2 s. It is **complementary to** the build target (bun's boot edge) and to
node CPU/scheduling headroom, not a substitute. Scope: single measurement, this OKE node ↔ OCIR path,
~105 MB image; pull time scales with image size and registry/network. Motivates an operator-reconciled
image pre-pull capability (design in the ADR that follows this run).

## Run 19 (2026-07-22) — bun+vinext load test on OKE (deployed Knative Service, real traffic path)

The self-contained bun+vinext binary (#460) deployed as a scale-to-zero Knative Service (`p1b-bunexec`,
minScale 0 / maxScale 10) under sustained + burst concurrent load, via k6 in-cluster -> Kourier ingress ->
activator -> pods. Profile: **50 constant VUs for 40 s, then a ramp to 200 VUs (25 s burst)**, no think time,
hitting `/api/health`.

| Metric | Result |
| --- | --- |
| Requests | **121,587** over ~72 s |
| Throughput | **1,689 req/s** (full Knative data path) |
| Error rate | **0.00 %** (0 failed / 121,587) |
| Checks (status 200) | **100.00 %** (121,587 pass / 0 fail); 0 interrupted iterations |
| Latency - median | **27.8 ms** |
| p90 / p95 / p99 | 139.8 / 183.2 / **285.5 ms** |
| max | 2.56 s (the FIRST request - app started scaled-to-zero; the initial cold start, not a load artifact) |
| Peak fan-out | **3 pods** (of maxScale 10) |

**Finding - the runtime holds under concurrency with zero drops.** The hand-written srvx-`serve`
delegation + in-flight-counting wrapper in `knext-bun-entry.mjs` (the code path most at risk of a
concurrency bug - a dropped request, a leaked in-flight count) served **250 concurrent VUs / 121k
requests with 0 failures**, median ~28 ms / p99 ~285 ms warm. `:9091` metrics stayed live throughout.

**Scope / caveats.** (1) The `max=2.56 s` is the single initial cold-start request (scale-from-zero), not
steady-state - the warm distribution is the p99 285 ms. (2) **Fan-out capped at 3 pods by CLUSTER
CAPACITY, not the app:** this 2-node OKE cluster runs at ~84 % CPU requested (Knative/system overhead on
~1830m-allocatable nodes, ~290 m free/node), so the autoscaler had little headroom to add pods; 3 pods
were sufficient for 1689 RPS at 0 errors, but a higher-throughput or higher-fan-out test needs more node
capacity (or freeing the leftover experiment clutter). (3) Single run, this cluster and this app image.
What run 19 establishes firmly: the deployed bun+vinext target survives real concurrent load end-to-end
with zero dropped requests and warm p99 under 300 ms.

## Run 20 (2026-07-23) — LOCAL supervisor-overhead micro-bench (#441 re-measure, post-deferral)

> **NOT an OKE run.** Run on a fast dev machine (Apple-silicon), so the absolute numbers are NOT
> comparable to the OKE runs above. The portable findings are the **delta** and the **distribution
> separation**. This measures the knext supervisor's *additive* cold-start overhead in isolation.

**Why.** Runs 7/8 measured the knext wrapper adding **842 ms (+43 %)** over booting Next directly, and
**Run 9 attributed it**: not the parent's own startup (that is ~52 ms), but the module-scope
`collectDefaultMetrics()` collector **competing for CPU with the child's ~2 s boot** on
`0`-CPU-request, oversubscribed nodes. Since then the runtime deferred that metrics graph off the
cold-start path (`createLazyMetricsEndpoint` + `deferred-default-metrics` — the collector now starts
**after** the child is serving, so it no longer runs during the boot window). This run re-measures the
parent overhead with the current code (it does **not**, and cannot, re-measure the contention effect
— see below).

**Method.** Alternating pairs (the project's evidence bar), 12 pairs + 1 discarded warm-up. A
**fast fixture** stands in for Next's `server.js` (binds `$PORT` and answers `/api/health`
instantly) so the ~1957 ms Next boot is removed and only the supervisor's own overhead remains.
- **DIRECT** — `node <fast-fixture>` binding `$PORT`.
- **SUPERVISOR** — the shipped CMD `node -e "import('@getknext/core/internal/node-server')"` (from a
  self-contained `pnpm --filter @getknext/core --prod deploy`, mirroring the drain-e2e runner) spawning
  the same fixture via `STANDALONE_SERVER_PATH`.
Each pair times spawn → first `/api/health` 200.

**Result.**

| | median | range |
|---|---|---|
| DIRECT (fixture alone) | 62 ms | 53–75 |
| SUPERVISOR (wrapper) | 114 ms | 107–121 |
| **DELTA (supervisor overhead)** | **52 ms** | — |

**Distribution separation: YES** — fastest supervisor (107 ms) > slowest direct (75 ms), zero
overlap across 12 pairs.

**What this confirms — and what it deliberately does NOT.** The ~52 ms parent-overhead figure is
**consistent with [Run 9 Part A](#run-9-2026-07-20--attributing-the-842-ms-wrapper-overhead)**, which
already measured the parent's own module-load + spawn at **52 ms on OKE** (import included) and
established that the parent's startup is *not* where the 842 ms lives. Run 20 reproduces that small
parent cost with the current code and a reproducible harness.

**Correction to an earlier draft of this run: the 842 ms is NOT import/disk latency.** Run 9 Part A
falsified that "by a factor of sixteen" (parent 52 ms vs 842 ms), and Part B corroborated the real
mechanism: `collectDefaultMetrics()` at module scope ran a **periodic process-metrics collector in
the parent that competed for CPU with the child during its ~2 s boot**, on `0`-CPU-request pods
scheduled onto an **oversubscribed** node (server.js booted +951 ms alongside a busy sibling,
complete separation). The deferral fixes the
842 ms by **removing that concurrent CPU competitor from the child's boot window**, not by shaving a
~37 ms import. (The ~37 ms local import cost is real but is *not* the mechanism and is not evidence
about the 842 ms.)

**Why this local run cannot substitute for an OKE re-measure.** By design it eliminates **both**
preconditions of the Run 9 effect: the fast fixture removes the ~2 s child-boot window during which
the contention occurs, and a dev machine has no CPU oversubscription. So "not reproducible locally"
is **expected regardless** of whether the deferral helped — it is *not* evidence that #441 is closed.
What Run 20 establishes is narrow and honest: the parent's own overhead is small (~52 ms), matching
Run 9 Part A. **Closing #441 still requires an OKE re-measure** with the current (deferred) code, real
`server.js`, and `0`-CPU-request pods on an oversubscribed node — the conditions Run 9 identified.
Beyond that, the remaining runtime-side lever is the in-process (no-child-spawn) architecture, which
would remove the competing-process class entirely but must preserve the SIGTERM-drain guarantees.

## Run 21 (2026-07-23) — LOCAL runtime throughput (is the runtime the bottleneck? no)

> **NOT an OKE run.** Local, single-machine, closed-loop. On one box the Node client competes with
> the server for CPU, so the RPS is **client-limited** — a *floor* on server capacity, not a ceiling.
> The latency percentiles and the "0 errors" are the portable signals.

**Why.** Run 19 (OKE) measured 1,689 req/s and warm **p99 285 ms** through the full Knative data
path. This run asks how much of that is the knext **runtime** vs the surrounding infrastructure, by
load-testing the runtime directly (no activator, no network, no scheduling).

**Method.** The `bun-exec` single binary serving `/api/health`, driven by the committed general load
tester (`packages/kn-next/bench/http-loadtest.mjs`) — C=50 keep-alive workers, 8 s, after a 2 000-req
warm-up. `/api/health` exercises the real per-request path incl. the srvx **in-flight-counting
middleware** (the RuntimeContract drain accounting).

**Result.**

| metric | value |
|---|---|
| throughput | **46,292 req/s** (client-limited) |
| requests | 370,337 ok, **0 err** |
| latency p50 / p95 / p99 / max | **0.99 / 1.79 / 2.13 / 6.9 ms** |
| `:9091` counters | `requests_total` matched (372,338); `inflight` returned to 0 |

**Finding — for this route, the runtime's per-request cost is negligible.** `/api/health` isolates
the knext **wrapper/middleware** path (in-flight counting, auth gate, routing) — it does **not**
exercise React SSR or data-fetching, so this bounds the *wrapper* overhead, not a real page's render
cost. On that path: sub-millisecond p50 and p99 ~2 ms at 46 k req/s with zero errors; the
in-flight-counting middleware adds negligible per-request cost.

**The honest signal is latency, not a throughput multiple.** Run 19 hit the same `/api/health` and
measured OKE p99 **285 ms** — ~**134×** the local p99 of 2.13 ms. A runtime that answers the identical
route in ~2 ms cannot be what adds 285 ms; that latency is the **Knative data path** (activator queue
on scale-from-zero, pod scheduling, kourier/network, cluster CPU contention on the oversubscribed
2-node cluster). (The *throughput* numbers — 46 k local vs 1,689 OKE — are **not** a clean capacity
ratio: the local figure is client-limited (a floor) and Run 19's was capped at 3 pods by cluster
capacity, so no server-capacity multiple can be read off them. The latency comparison is the one
that holds.) This bounds where throughput optimization can pay off: the runtime's own path is lean;
the remaining levers are cluster-side (activator/autoscaler tuning, node capacity/headroom) and
require OKE.

**Together, Runs 20 + 21 establish that knext's runtime is lean on both axes** — cold-start wrapper
overhead ~52 ms (parent), and steady-state throughput sub-ms p50 / p99 ~2 ms. Future performance work
should target (a) the Knative infrastructure path (OKE-gated), (b) confirming the #441 deferral on OKE,
and (c) the in-process (no-child-spawn) architecture for the cold-start CPU-contention class.

## Run 22 (2026-07-25) — LOCAL supervisor pre-spawn import cost (pino lazy-loaded)

> **NOT an OKE run.** A deterministic Node import-cost measurement, not an end-to-end cold start.

**Why.** The #441 arc's mechanism is that the supervisor's own pre-spawn CPU steals from the child's
boot window on oversubscribed 0-CPU-request nodes, so the deferral work moved the heavy static graphs
(`prom-client`, `@opentelemetry/api`) behind dynamic imports. This closes the **last** heavy static
dep the supervisor still paid eagerly: **pino**.

**Finding.** `utils/logger.ts` instantiated pino at **module scope** (`export const logger =
pino({…})`), so merely importing the logger loaded + initialised pino. Measured in a fresh Node
process importing the built logger module: **~11.5–13.9 ms** (call it ~13 ms). The supervisor
imported the logger and emitted a startup line **before** `spawn()`, dropping that cost on the
cold-start critical path.

**Change.** pino is now lazy (`import type` + `createRequire("pino")` on first emit, behind a
`Proxy<Logger>`; config byte-identical), and the supervisor's startup `log.info` moved to **after**
`spawn()`. In the normal path nothing logs before spawn, so pino loads only once the child is already
booting.

| supervisor pre-spawn logger cost | before | after |
|---|---|---|
| import + first-use (no emit) | ~13 ms (eager pino) | **~0.1 ms** (pino not loaded) |

**Scope / honesty.** This is a **deterministic import-cost removal**, locally measured — not an
end-to-end cold-start number. Whether removing ~13 ms of supervisor pre-spawn CPU moves the observed
OKE wrapper overhead is **OKE-gated**, exactly like the rest of the #441 arc (Run 9 / Run 20). What is
certain is that pino no longer executes on the pre-spawn critical path. With `prom-client`, otel, and
now pino all off that path, the supervisor's remaining pre-spawn work is small local modules + node
builtins; further cold-start levers are the ones Run 21 named (Knative infra path, in-process
architecture), which need OKE.

## Run 23 (2026-07-26) — OKE cold start, 6-day-old image vs current: variance collapsed, median delta unconfirmed

**What this is.** Two 10-sample cold-start arms on the live OKE cluster (`context-ckmva7v7zvq`,
`default/file-manager`), same harness invocation, same extractor, run ~17 h apart.

| arm | image | min | **p50** | mean | p90 | max |
|---|---|---|---|---|---|---|
| before | `file-manager:ht-bdfa2fa` (built 2026-07-20) | 3.42 s | **3.97 s** | 4.33 s | 5.74 s | 7.27 s |
| after | `file-manager@sha256:ede0a34…` (`obs-p13-db1c759`) | 3.02 s | **3.38 s** | 3.35 s | 3.56 s | 3.56 s |

Samples (`http_req_duration` median per k6 run, one request per sample):
- before: 7.27, 4.05, 5.57, 3.45, 4.22, 3.90, 4.01, 3.93, 3.42, 3.52
- after: 3.38, 3.36, 3.11, 3.02, 3.42, 3.56, 3.26, 3.47, 3.56, 3.39

**The robust finding is the variance, not the median.** The after-arm's whole range (3.02–3.56 s)
is narrower than the before-arm's interquartile spread; p90 fell 38 % and max 51 %. Seven of ten
before-arm samples exceed the after-arm's *maximum*. That is the signal worth keeping, because this
document's own bar (see Caveat, and Run 6) is that a latency delta counts when the distributions
separate rather than when the medians differ — and a harness whose cold-start figures previously
ranged 3.42–7.27 s on one image could not have detected a sub-second regression at all.

**The medians do NOT clear that bar.** The two arms overlap at 3.42–3.56 s, so this is not the
complete separation Run 6 had. Treat **p50 3.97 → 3.38 s as provisional** and do not quote it until a
repeat run reproduces it. Weak corroboration only: an earlier partial after-arm (4 valid samples,
same image, discarded for the reason below) read 3.43 / 3.42 / 3.40 after a 6.57 s first sample,
consistent with the 3.4 s cluster seen here.

**This run does not attribute the improvement to anything.** The after image is *current `main` plus
the P1.3 branch*, not an isolated change — it carries everything merged between 2026-07-20 and
2026-07-26, including the Run 22 lazy-pino work (~13 ms, which cannot explain ~600 ms), the docs
compile-cache bake, and unrelated merges. So this is a **"6-day-old image vs current" comparison, not
a measurement of any one change**, and it does **not** close the #441 supervisor-overhead question:
that arc asks whether removing supervisor pre-spawn CPU moves the observed wrapper overhead, and
nothing here isolates the supervisor. The cause of the variance collapse is **unknown** and worth a
dedicated bisect if anyone wants to claim it.

**Confounder to state plainly.** Both arms ran with their image already resident on both nodes, so
neither includes a cold image pull — except the before-arm's first sample (7.27 s) and the discarded
attempt's first sample (6.57 s), both of which look pull-influenced. The after-arm had additionally
been exercised by two prior benchmark attempts, so its node page cache was warmer than the
before-arm's. That asymmetry favours the after-arm and is not corrected for. Run 18 measured
image-pull cost separately; this run does not re-measure it.

### Two attempts were discarded, and why

Recorded because both failure modes produce *plausible* numbers, which is the dangerous kind.

1. **Container env wiped by a merge patch.** Rolling the service to the new image with
   `kubectl patch ksvc --type=merge` and a `{"containers":[{"image":…}]}` body **replaced the whole
   container list element**, dropping all 11 env vars (`NODE_ENV`, `DATABASE_URL`, `REDIS_URL`,
   `GCS_BUCKET_NAME`, …). The revision still went **Ready** — the readiness probe passes without
   them — so nothing looked wrong, and the arm measured an app booting with no database, no Redis and
   `NODE_ENV` unset: **p50 11.36 s across 10 samples, range 10.99–11.54 s**. The tight variance was
   the tell; deterministic added cost means missing configuration far more often than a real
   regression. Use `--type=json` with a path replace, or rebuild the container from the last-good
   revision, and **diff the new revision's container against the previous one before trusting any
   measurement** (`kubectl get revision <r> -o json | jq '.spec.containers[0] | {image, env:(.env|length)}'`).
2. **Two runs racing the same service.** A liveness check of `pgrep -f "scale-to-zero-oke/run.sh"`
   never matches, because the process cmdline is `./run.sh` (relative). A live run was therefore
   declared dead, its cluster was patched mid-flight, and a second run was started on top of it.
   Concurrent traffic keeps pods warm, so a "cold" start may not be cold — samples 5-10 of that
   attempt and all of the second run were discarded. Discriminate real duplicates from a transient
   subshell fork by **elapsed time**, not by cmdline: `ps -eo etime,command`.

The harness's own restore path behaved correctly throughout, including its `RESTORE FAILED` warning
when keys it meant to remove were already absent. One gap it cannot cover: the captured original
config lives only in the running process, so a `SIGKILL` loses it — the restore warning is
trap-based and `SIGKILL` cannot be trapped. Persisting the captured config at capture time would let
any later invocation detect and offer to restore it.

## Run 24 (2026-07-26) — ADR-0036 P1b A/B re-measured on a verified-comparable pair: both arms bimodal, delta unconfirmed

> **Undercut by Run 25 — read that entry before quoting anything from the mode-mixture table below.**
> Run 25 measured the same service, digest and probe one day later and saw the slow mode **zero times
> in ten samples**, so this run's mode mixture is a property of that sitting rather than of the arms.
> The `p = 0.37` Fisher figure below is **withdrawn as a statistic** (see the correction in
> "The headline p50 is an artifact"), not merely weakened. Every other conclusion here stands.

**What this is.** A re-run of the Run 17 bun-exec vs node cold-start A/B on the live OKE cluster
(`context-ckmva7v7zvq`, `default/p1b-node` and `default/p1b-bunexec`), 10 cold samples per arm, run
**sequentially** (never concurrently), same harness invocation and same extractor for both arms.

### This corrects Run 17's stated premise

Run 17 says both arms were deployed "0-CPU-request". **That was not true of the node arm.** Inspection
of the live services found `p1b-node` carrying `requests.cpu=100m`, `limits.cpu=1`, `128Mi`/`512Mi`,
while `p1b-bunexec` had `resources: {}`. The node arm's revision `p1b-node-00002` was created
2026-07-21, before Run 17 ran on 07-22, so that resource block was in force for Run 17. On a cluster
Run 17 itself describes as "heavily contended", it therefore measured **build target and CPU guarantee
together**, with two opposing distortions: a guaranteed CPU floor favouring node, and an uncapped
bun arm favouring bun on an idle node. Run 17's numbers should not be read as a runtime comparison.

**A second confound Run 17 did not state** surfaced in this run's pre-flight check: the arms' readiness
probes differed. node used `httpGet /api/health` with `periodSeconds: 1, timeoutSeconds: 1,
failureThreshold: 3`; bun-exec used a bare `tcpSocket` probe with Knative defaults. That is not
cosmetic for a scale-from-zero measurement — a `tcpSocket` probe passes as soon as the process binds
the listener, while an `httpGet` on a real route additionally requires the app to serve a request, so
the arms were gated on different definitions of "ready", in bun's favour. (Knock-on: the `queue-proxy`
readiness `periodSeconds` was 1 on node vs 10 on bun.) Both arms were equalized to the **same**
`httpGet /api/health` probe before measuring, and both were given a fresh revision within one second
of each other so neither arm had a staleness or image-residency advantage.

### Comparability gate (run before measuring, not after)

Each service's latest READY revision was diffed field-by-field by script — env (names *and* values),
resources, containerConcurrency, timeoutSeconds, ports, readinessProbe, command, args, volumes,
serviceAccount. Verdict on the measured pair (`p1b-node-00005` / `p1b-bunexec-00008`): **identical in
every compared field except `container.image`.** Both `resources: {}`, both `env: []`, both
`containerConcurrency: 0`, `timeoutSeconds: 300`, `min-scale 0`, `max-scale 10`.

### Results — both arms are bimodal

Samples (`http_req_duration` median per k6 run, one request per sample, in run order). All 20 samples
returned a genuine `200` (`checks 100 %`, `http_req_failed 0 %`); none is an error artifact.

- **node**:    10.32, 10.62, 10.28, 10.99, 11.01, 2.77, 2.45, 10.99, 2.17, 10.66
- **bun-exec**: 1.65, 10.75, 1.99, 2.45, 10.77, 1.97, 1.65, 10.77, 2.13, 10.42

| arm | n | min | **p50** | mean | p90 | max |
|---|---|---|---|---|---|---|
| node (Next standalone) | 10 | 2.17 s | **10.47 s** | 8.23 s | 10.99 s | 11.01 s |
| bun-exec (compiled binary) | 10 | 1.65 s | **2.29 s** | 5.46 s | 10.77 s | 10.77 s |

Every sample falls into one of two well-separated clusters with nothing in between (2.77 s → 10.28 s):

| mode | node | bun-exec | verdict |
|---|---|---|---|
| **slow** (≥ 6 s) | 7/10, range 10.28–11.01 s, p50 10.66 s | 4/10, range 10.42–10.77 s, p50 10.76 s | **indistinguishable — overlapping** |
| **fast** (< 6 s) | 3/10, range 2.17–2.77 s, p50 2.45 s | 6/10, range 1.65–2.45 s, p50 1.98 s | **overlapping** |

### The headline p50 is an artifact and must not be quoted

Naively, p50 10.47 s → 2.29 s reads as "bun-exec is 4.6× faster". **It is not a runtime result.** The
two arms' slow modes are the same speed (10.66 s vs 10.76 s); the whole p50 gap comes from *how many*
samples landed in the slow mode — 7/10 for node vs 4/10 for bun-exec. Do not quote the 4.6×, and
do not quote the p50 delta.

> **Correction (Run 25): the `p = 0.37` this section originally quoted is withdrawn.** Fisher's exact
> test was applied to the 7/10-vs-4/10 mode mixture, and its null hypothesis is that both arms draw
> from one *fixed* base rate. Run 25 shows that base rate **moves between sittings** (the same arm
> went 7/10 slow to 0/10 slow overnight), and the two arms here were run **sequentially, not
> interleaved** — so the arms sampled different stretches of a time-varying process. Under those
> conditions Fisher's null is **inapplicable, not merely weak**: `p = 0.37` was never the right
> statistic and should not be cited as evidence for or against a mode-mixture difference. The
> conclusion it was used to support — do not quote the 4.6× — is unchanged and rests on the
> overlapping distributions below, which need no test.

**Nothing here clears this document's bar.** By the Run 6 precedent (see Caveat) a latency delta counts
when the *distributions separate*. These distributions overlap grossly — both arms span ~1.7–11.0 s.
Even restricted to the fast mode, where a runtime difference would have to live, the ranges overlap
(node 2.17–2.77 s, bun-exec 1.65–2.45 s; bun-exec's slowest fast sample equals node's median). The
**fast-mode median delta of 2.45 s → 1.98 s (~470 ms) is provisional and must not be quoted** until a
repeat run reproduces it.

### What this run does establish

**The ~11 s tail is target-independent.** Run 17 recorded an "~11 s intermittent tail" as a property of
the *node* arm. This run shows the bun-exec arm has the same tail at the same magnitude
(10.42–10.77 s vs node's 10.28–11.01 s). Whatever produces it — pod scheduling, activator queueing, or
image pull on this contended 2-node cluster — it is **not** a property of the build target, and it
dominates end-to-end cold start whenever it fires. That is consistent with Run 16/17's "shared floor"
reasoning, and it is now measured on both arms rather than inferred from one. This run does **not**
attribute the tail to a specific cause; the pods were gone before their placement could be inspected.

Secondary: node's fast mode (p50 2.45 s) reproduces Run 17's node figure (2.79 s) despite the CPU
guarantee having been removed, so the removal did not obviously shift the fast mode — but with 3 fast
node samples that is an observation, not a measurement.

### Limitations, stated plainly

- **The two images are not the same application, and this is not correctable by config.** `crane config`
  on both digests shows node = `alpine-minirootfs-3.24.1`, entrypoint `docker-entrypoint.sh` +
  `node server.js` over a `.next/standalone` build, Node 22.23.1; bun-exec = `alpine-minirootfs-3.20.10`,
  entrypoint `/app/knext-bin`, a compiled single-executable built from `examples/bun-exec`. Their `/`
  responses differ in kind (a 4000-byte RSC-rendered document vs a 1397-byte hand-written page). So this
  comparison measures **runtime + application + base image**, not runtime alone.
- **Source commits could not be confirmed.** Both images are 4–5 days old (node built 2026-07-21,
  bun-exec 2026-07-22) and neither carries source-commit annotations in the registry. If they were built
  from different commits, the comparison measures more than the runtime — and per the point above, it
  already does.
- **Single cluster, n=10 per arm, one sitting.** The bimodality means an n=10 arm is really ~3–6 samples
  of each mode, which is why no delta here is quotable.
- The probe equalization changed bun-exec's readiness semantics relative to how Run 17 measured it, so
  Run 24's bun-exec numbers are not directly comparable to Run 17's bun-exec numbers either.

### Cluster state at hand-off

Both services scaled to zero. The harness's capture/restore path reported success on both runs and both
services are back to their captured autoscaling config (`max-scale=10`, `containerConcurrency=0`,
burst/panic annotations absent). `resources: {}` and `env: []` are unchanged on both — the harness never
touches them (it captures and restores only the five autoscaling annotations plus
`containerConcurrency`). Two deliberate, documented deviations from the pre-run state remain, both made
to create the comparable pair: **both arms now carry the same `httpGet /api/health` readiness probe**
(bun-exec's was `tcpSocket`) and an explicit `containerPort: 8080`, plus a `run24` annotation. Leaving
them is intentional — reverting would re-break comparability for the repeat run. Side effect worth
knowing: each harness restore issues several template patches, so each run mints ~4 extra Knative
revisions (`p1b-node` is at 10, `p1b-bunexec` at 13); they are unrouted and scaled to zero. The three
leftover k6 Jobs in the namespace (`cc-measure`, `fm-loadtest`, `vinext-bench`) predate this run.

### What would settle it

Run both arms again, unchanged, and see whether the fast-mode delta reproduces — and separately, find
the cause of the ~11 s mode (capture pod `nodeName` and the kubelet pull/scheduling events per sample).
Until the tail is understood or eliminated it swamps a ~470 ms runtime difference, and no ADR-0036
ship/don't-ship decision should rest on an end-to-end cold-start number from this cluster.

## Run 25 (2026-07-27) — cold-start attribution, instrumented: the bimodality did not reproduce, and the probe-cadence hypothesis is dead

**What this is.** The first run on this cluster built to *attribute* cold start rather than only time
it. Two services measured sequentially (never concurrently), same harness invocation, same extractor:
`default/p1b-node` — the service Run 24's bimodality was actually observed on — and `default/file-manager`.
A read-only observer ran alongside, started before the request rather than queried after.

It also closes a hypothesis that was heading for an experiment it did not deserve.

### The probe-cadence hypothesis is refuted, on the premise rather than the result

The proposal was that the operator pins the ksvc readiness probe to `initialDelaySeconds: 2` /
`periodSeconds: 3` with no `failureThreshold` (defaulting to 3), that Knative's queue-proxy only
polls aggressively when `periodSeconds` is unpinned, and that an app with a ~1.96 s boot floor
therefore misses the first tick and pays `2 + 3 (+3) ≈ 8 s` — discrete, so it would explain clean
bimodality, and ~8 s, so it would match the observed gap.

Four independent checks against the running system, before measuring:

1. **There is no operator on this cluster.** No `NextApp` CRD (`kubectl -n default get nextapp` →
   `the server doesn't have a resource type "nextapp"`), and no `kn-next-operator` Deployment in any
   namespace. `nextapp_controller.go:977-986` has never emitted a probe here. All three benchmarked
   ksvcs are hand-applied — they carry `kubectl.kubernetes.io/last-applied-configuration` and no
   `ownerReferences`.
2. **The values are real in the operator source and absent from the cluster.** The hypothesis was
   derived by reading the source and treating it as a description of the running system.
3. **The services that showed the bimodality run `periodSeconds: 1`, not 3, and no
   `initialDelaySeconds` at all.** Live on both Run 24 arms, confirmed in three places — the ksvc
   spec, the revision spec, and the queue-proxy's `SERVING_READINESS_PROBE` env, which is what the
   queue-proxy actually executes:

   ```json
   {"failureThreshold":3,"httpGet":{"path":"/api/health","port":0},
    "periodSeconds":1,"successThreshold":1,"timeoutSeconds":1}
   ```

   This matches Run 24's own text, which records the arms being equalized to
   `periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 3`.
4. **The arithmetic does not survive the substitution.** With `initialDelay = 0` and `period = 1`, a
   missed first tick costs ~1 s and the worst case before the probe fails is `3 × 1 s = 3 s`, against
   an observed gap of ~8 s. The mechanism is short by nearly 3×. No A/B can rescue it.

The A/B originally proposed — pinned `2/3` versus unpinned — would have characterised a configuration
**nothing on this cluster runs**, and was not performed. Recorded here so it is not re-proposed.

A second, weaker version of the idea also failed its premise: `file-manager` was proposed as the A/B
subject with "probe as-is" as the control, but its probe is *already* unpinned
(`{"successThreshold":1,"tcpSocket":{"port":0}}` — Knative's default), so control and treatment were
the same configuration.

### What was measured

`p1b-node` needed no mutation: it already carried exactly the Run 24 configuration — `httpGet
/api/health`, `periodSeconds: 1`, `timeoutSeconds: 1`, `failureThreshold: 3`, `resources: {}`,
`containerConcurrency: 0`, `containerPort: 8080`, `min-scale 0` / `max-scale 10`. Measuring it as-is
removes the whole class of patch risk that a `--type=merge` container patch introduces.

The harness's `apply_autoscaling` rolled `p1b-node-00010` → `00011` at run start. The two revisions'
containers were diffed field by field and are **identical** — same image digest, probe, `env: []`,
`resources: {}`, ports, `containerConcurrency`, `timeoutSeconds`, no command/args/serviceAccount
override. Only autoscaling annotations differ (`max-scale 10→6`, `target-burst-capacity` unset→`200`,
panic window/threshold set). **All ten samples were served by one revision, `p1b-node-00011`**,
asserted by the report rather than assumed.

### Results — 10/10 fast, no slow mode

Samples are `http_req_duration` medians per k6 run, one request per sample, in run order. All
returned a genuine `200`.

- **`p1b-node`** (n=10): 2.24, 2.71, 2.29, 2.02, 2.17, 2.07, 2.81, 2.26, 2.35, 2.24 — **range 2.02–2.81 s**
- **`file-manager`** (n=10): 6.65, 3.39, 3.44, 3.62, 3.69, 2.99, 3.20, 3.80, 3.44, 3.37 — **range 2.99–6.65 s**

No central tendency is quoted for either arm, deliberately: a single number over a possibly-bimodal
sample describes a value that may never occur, which is how Run 24's "4.6× faster" artifact arose.

**The headline is a negative result.** Run 24 measured `p1b-node` at 7/10 in a slow mode of
10.28–11.01 s, with a clean gap and nothing between 2.77 s and 10.28 s. One day later, on the same
cluster, the same service, the same image digest and the same probe configuration, **the slow mode
did not occur once in ten samples.** `file-manager` likewise shows no 10.5 s mode, and its one
elevated sample (6.65 s) is the first of the run, not a separate cluster.

That is not a refutation of Run 24 — those samples were real and returned 200s. It means the ~11 s
mode is **intermittent across sittings**, so it is a property of the cluster's state on a given day
rather than a stable property of the service, the build target, or the probe. It also means Run 24's
n=10 arms were sampling something whose base rate moves between runs, which invalidates any delta
computed from mode mixture — including the one Run 24 already declined to quote. Run 24 has been
back-annotated accordingly, and its Fisher `p = 0.37` is **withdrawn as a statistic**: that test
assumes one fixed base rate, and its arms were run sequentially rather than interleaved, so its null
is inapplicable here rather than merely weak.

### Attribution: what the instrument excluded — for the fast samples, in this sitting only

With no slow samples there was nothing to attribute, so the run's value is in what it rules out.
All ten samples were admissible — every required lifecycle field captured.

**Read the scope before the bullets.** Every exclusion below is a statement about **the fast samples
measured in this sitting** — the ten on `p1b-node` and the ten on `file-manager`, none of which
reached the ~10.5 s mode — and about nothing else. The slow mode was not observed here, so
none of this excludes anything as a cause *of the slow mode*: **you cannot exclude a cause of a
phenomenon you did not observe.** Run 24's slow samples were a different day and were collected with
no residency sampling, no per-sample kubelet events and no k6 splits — so image pull in particular is
**not** excluded for them, and cannot be from this run's data.

- **Image pull did not contribute to these fast samples**, measured rather than assumed. The target
  digest `sha256:b6b80e81…` was **already resident on both nodes** before the run started, sampled
  from `node.status.images[]` *before* each request (post-hoc this is always true and proves
  nothing). Every sample's kubelet `Pulled` event reads *"already present on machine"*. This says
  nothing about residency during Run 24's slow samples, which was never sampled.
- **Connection establishment did not contribute to these fast samples.** For the six samples whose
  full k6 summary was captured, `http_req_connecting` was 412–680 **µs** and `http_req_waiting`
  equalled `http_req_duration` to two decimals in every one of the six. Those six cold starts are
  entirely server-side; none of that time is Kourier/activator connection setup. Scoped to 6/10
  samples of one arm, on one day.
- **Scheduling did not contribute to these fast samples**, at this resolution: `create→scheduled`
  was 0 s on all ten.
- **Node placement was not a variable in this run** — all ten pods, and all ten k6 driver pods,
  landed on `10.0.1.253`. Nothing exercised `10.0.1.78`.

### Limitations, stated plainly

- **A negative result at n=10 does not disprove an intermittent mode.** If the slow mode's base rate
  were 20%, ten samples would miss it entirely about 11% of the time. This run shows the mode is not
  reliably reproducible; it does not show it is gone.
- **The lifecycle intervals are quantized to one second.** Kubernetes condition `lastTransitionTime`
  values have second resolution, so `scheduled→started`, `started→ready` and `ready→response` come
  out as 0 s, 1 s or 2 s on a ~2.2 s cold start. That is too coarse to apportion a fast sample, and it
  is why the per-interval columns are reported but not used to draw a conclusion here. They would be
  adequate for an ~8 s excess; they are not adequate for a ~2 s total.
- **One node, one day, one revision.** Every sample ran on `10.0.1.253` on 2026-07-27 against
  `p1b-node-00011`. A distribution from that scope can be literally honest and still describe an
  artifact of that node. Both nodes were, at the time, ~83–85% of allocatable CPU *requested* with
  limits oversubscribed to 388–404% — the "heavily contended" condition earlier runs describe, and a
  plausible home for an intermittent multi-second stall.
- **Split metrics were captured for 6 of 10 samples.** The other four report `—`, which is missing
  data, not zero (see the harness note below).
- **The harness alters the service config it measures**: `max-scale 10→6`, `target-burst-capacity`
  unset→`200`, and panic window/threshold set, restored afterwards. For the **cold** phase this is
  believed not to change the request path — a scale-from-zero request has no pods, so the activator
  buffers it by necessity at any `target-burst-capacity`, and TBC governs activator retention once
  pods exist. That reasoning is from Knative semantics and **was not verified by measurement here**;
  it is stated as an open point rather than a finding. It would be a live caveat for the soak and
  burst phases, which do run with pods available.

### A harness limitation this run exposed

`run.sh:1021` filters each k6 summary through
`grep -E 'http_req_duration|http_req_failed|http_reqs|iteration_duration|checks\.\.\.|vus_max|dropped'`
before it reaches the results file. `http_req_connecting`, `http_req_waiting` and
`http_req_tls_handshaking` are dropped there. Those splits are what separate "connection/routing" from
"server side", so **no run in this document before this one could have attributed a latency mode from
its own artifacts** — the harness was built to measure, not to attribute, and this is the second half
of that gap. (The first half: the only pod observation is `running_pods()` at `run.sh:809`, a *count*
polled every 3 s — no pod name, no `nodeName`, no timestamps, no events, no revision identity.)

This run did not modify the harness. The collector reads each k6 driver pod's **full log** the moment
it reaches `Succeeded`, which carries the complete summary; `run.sh:1098` deletes the Job at the end of
each rep, so it must be polled during the run and cannot be recovered afterwards. Four of ten were
reaped before capture — hence 6/10 coverage — which is itself an argument for widening the grep rather
than relying on the workaround.

### Instrumentation added

- `benchmarks/scale-to-zero-oke/cold-attribution-collector.sh` — read-only observer (get/list only;
  it does **not** raise the scale-to-zero grace period, which would mutate what is being measured).
  Captures pod identity/placement/lifecycle conditions, `startedAt` for **both** `user-container` and
  `queue-proxy` (queue-proxy readiness is what gates traffic, so omitting it attributes sidecar time
  to the app), the rewritten on-pod probe stanza, node-level target-digest residency sampled before
  each request, PodAutoscaler `Active`/`Activating` and replica timeline, kubelet events, k6 driver
  pod `nodeName`, and full k6 logs.
- `benchmarks/scale-to-zero-oke/cold-attribution-report.mjs` — per-sample fast/slow with admissibility
  enforcement, serving-revision constancy assertion, stratification by node / image residency /
  readiness predicate / same-node-vs-cross-node, and a per-interval excess table. Its attribution
  arithmetic is a separate module (`cold-attribution-attribute.mjs`) so it can be tested against
  synthetic samples the cluster has never produced, rather than only against what it happened to
  emit.

Two deliberate design choices in the report, both aimed at a failure mode rather than a feature:

- **Attribution can return `UNATTRIBUTABLE`, and that bucket is expected to be non-empty.** An earlier
  version picked the largest interval as the cause, which would have classified 100% of samples by
  construction and described its own classifier rather than the cluster. A cause is now named only if
  **one** interval accounts for ≥50% of a sample's excess over the *worst* fast sample by itself —
  applying that floor to the *sum* of the intervals was not enough, because five intervals at ~20%
  each sum to 100% while the named bucket still explains 20%. Three further ways the tool could have
  named a cause it had not measured are closed with it: the summed intervals are now a
  **non-overlapping** decomposition (`pulling→pulled` sits *inside* `scheduled→started`, so counting
  both double-counted the pull); `ready→response` is a **diagnostic, never a cause**, because its end
  marker is the k6 driver pod's container termination — summary write and teardown included — which
  makes it the largest interval by construction; and per-interval excess is **signed** rather than
  clipped at zero, so quantization noise across five one-second-resolution intervals can no longer
  only push the explained share upward. An excess inside that 1 s quantization names nothing.
  Guarded by `tests/cold-attribution-attribute.test.ts`, including a synthetic five-way-split sample
  run end-to-end through the report — the case this cluster has not yet produced.
- **The arm-integrity check asserts the serving revision, not the ksvc generation.** The generation
  legitimately moves twice per run (apply before sample 1, restore after sample N), so flagging that
  reported a clean arm as contaminated — which trains readers to ignore the check.

### The readiness-predicate lead: still standing, still untested

The sprint plan's surviving lead is the readiness **predicate** — every observation of the slow mode
so far has been on an arm probing with `httpGet /api/health`, and every unimodal arm has used a bare
`tcpSocket` probe; a tcpSocket probe passes when the socket binds, an httpGet additionally requires
the app to serve a request. This run **does not test it**, because testing it means locating which
interval a slow sample's ~8 s lives in, and there was no slow sample to locate. The predicate is
recorded as a stratification column here and nothing more.

Two data points from this run bear on it anyway, and both point the same way — away from it:

- **`p1b-node` is an `httpGet` arm and came back 10/10 fast.** An `httpGet` predicate is therefore
  not *sufficient* for the slow mode: the same predicate, service, digest and probe cadence that were
  7/10 slow a day earlier produced no slow sample at all.
- **The run's one elevated sample (6.65 s, `file-manager`) is on a `tcpSocket` arm** — the wrong side
  of the hypothesis. It is a single sample, and being the first of its run it carries an unresolved
  run-order/warm-up confound, so it is weak evidence; it is stated because it is evidence *against*,
  and omitting it would be selective.

The honest status: **untested, not weakened to death, and not promising.** Neither point falsifies
the lead — the hypothesis was always that the predicate *interacts* with something else, and a
necessary-but-not-sufficient condition survives an arm that stayed fast. But nothing here supports it
either, and it should not be carried forward as though this run had strengthened it. It is settled
the same way everything else here is: catch a slow sample with the instrument attached and read the
interval it lives in.

### What would settle it

- **Repeat sittings, not more samples in one sitting.** The mode's base rate moves between days, so
  three runs of 10 on three days discriminates better than one run of 30. Re-running the same arms
  unchanged is the cheapest next step.
- **Catch one slow sample with the instrument attached.** Everything needed to attribute it is now
  captured; this run simply had no slow sample to attribute. A standing collector across several runs
  is more likely to catch one than a longer single run.
- **Correlate with cluster contention at sample time.** Both nodes sat near 85% requested CPU with
  heavily oversubscribed limits. Node-level CPU pressure and steal time at t0 are not yet captured.
  Contention is a plausible candidate, but it is not a candidate *by elimination*: pull, connection
  setup and scheduling **were excluded for the fast samples measured here**, which does not exclude
  them for the slow mode nobody has yet caught with an instrument attached. Call this a hypothesis
  worth instrumenting, not a remainder.
- **Do not read a build-target conclusion into any of this.** ADR-0036's P1b question remains where
  Run 24 left it: unconfirmed, and not decidable from end-to-end cold-start numbers on this cluster
  while an intermittent multi-second mode is unexplained.

## Run 26 (2026-07-27) — ADR-0036 P1b A/B, **interleaved**: the arms are indistinguishable, and the ~10.5 s mode is caught with the instrument attached

**What this is.** The bun-exec vs node cold-start A/B again, on the live OKE cluster
(`context-ckmva7v7zvq`, `default/p1b-node` and `default/p1b-bunexec`) — but with the arms
**interleaved sample by sample** rather than run one after the other. 13 pairs attempted, 12
complete. Same harness invocation, same extractor for both arms, strictly sequential throughout
(the cluster is a queue of one; concurrent traffic keeps pods warm and a "cold" start stops being
cold). The read-only attribution collector from Run 25 ran alongside every one of the 26 samples.

### Why interleaving, and why the earlier comparisons could not be rescued

Run 25 established that the ~10.5 s mode is intermittent **across sittings**: same service, same
image digest, same probe, one day apart, Run 24 saw it in 7 of 10 samples and Run 25 in 0 of 10.
The Caveat's third rule follows from that — *a comparison whose signal is mode mixture is invalid
unless the arms were interleaved* — and it is why Run 24's Fisher test is withdrawn as inapplicable
rather than merely weak. Sequential arms cannot separate an arm effect from drift in the sitting.

Interleaving makes any sitting-level drift land on both arms equally. It also buys **pairing**:
sample *i* of node is comparable to sample *i* of bun-exec because they ran minutes apart under the
same conditions, so the paired difference is the estimate to read, not the two marginal medians.

The order was **ABBA rather than ABAB** — node first on odd pairs, bun-exec first on even pairs.
Plain alternation cancels drift between pairs but leaves position-within-pair perfectly confounded
with arm, since one arm would always run first. This run's results make that precaution look
justified rather than fussy: the sitting did in fact change regime partway through.

### Comparability gate (run before measuring, and again after)

Each service's latest READY revision was diffed field-by-field by script — env names *and* values,
resources, containerConcurrency, timeoutSeconds, ports, readinessProbe, command, args, volumes,
serviceAccount, autoscaling annotations.

| when | pair | verdict |
|---|---|---|
| before | `p1b-node-00015` / `p1b-bunexec-00013` | identical in every compared field except `container.image` |
| after | `p1b-node-00080` / `p1b-bunexec-00078` | identical in every compared field except `container.image`, **same two digests** |

Both `resources: {}`, both `env: []`, both `containerConcurrency: 0`, `timeoutSeconds: 300`,
`min-scale 0`, `max-scale 10`, both `httpGet /api/health` with `periodSeconds: 1`,
`timeoutSeconds: 1`, `failureThreshold: 3`. Checking again afterwards matters because the harness
mints revisions as it captures and restores config; the check confirms it minted them without
drifting the thing under test.

### Every sample was verified cold by the instrument, not by the harness

This needs stating because the harness cannot support the claim. `run.sh`'s `wait_zero` printed
`-> still 1 pod(s) after 150s (continuing anyway)` on **all 26 samples of this run — and on all 10
samples of Run 25's committed results file**. It is a standing property of this harness on this
cluster, not a Run 26 defect, and it means the harness's own pod count certifies nothing.

The collector does certify it. For each sample it recorded every pod with its uid and creation
timestamp, and a sample counts as cold only if the pod that served the request was **created after
the request window opened** — a warm hit reuses a pod that already exists. **26 of 26 samples:
COLD.** No sample was served by a pre-existing pod.

### Results — the full sample arrays

`http_req_duration` median per k6 run, one request per sample, in wall-clock pair order. All
reported samples returned a genuine `200` (`http_req_failed 0.00 %`).

| pair | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **node** | 2.23 | 2.75 | 2.29 | 1.78 | 1.87 | 2.08 | *2.58* | 1.92 | 4.09 | **10.97** | **10.14** | **10.48** | **10.64** |
| **bun-exec** | 2.43 | 1.69 | 2.23 | 1.82 | 2.65 | 1.98 | — | 2.30 | 2.31 | 2.05 | **11.44** | **10.23** | **10.57** |

Pair 7's bun-exec rep is **excluded**: the harness itself flagged it `k6 metrics INCOMPLETE —
missing: http_reqs` and exited non-zero. Its node partner (2.58 s, italic) was measured cleanly but
is dropped from the paired analysis, because a pair needs both halves. Everything below is the 12
complete pairs.

| arm | n | min | p50 | mean | p90 | max |
|---|---|---|---|---|---|---|
| node (Next standalone) | 12 | 1.78 s | 2.52 s | 5.10 s | 10.62 s | 10.97 s |
| bun-exec (compiled binary) | 12 | 1.69 s | 2.30 s | 4.31 s | 10.54 s | 11.44 s |

**No median is a headline here.** Both arms are mixtures of two modes and the marginal medians only
report how many samples of each arm happened to land in which mode.

### The paired differences — what interleaving was for

node − bun-exec, per pair, seconds:

| pair | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Δ** | −0.20 | +1.06 | +0.06 | −0.04 | −0.78 | +0.10 | −0.38 | +1.78 | **+8.92** | **−1.30** | +0.25 | +0.07 |

Median Δ **+0.07 s**, mean **+0.80 s**, range **−1.30 s … +8.92 s**. Sign split: node slower in
7 of 12, bun-exec slower in 5 of 12 — which is what a fair coin looks like.

The mean is dragged by exactly **one** pair — pair 10 (Δ +8.92 s), the only pair in which the two
arms were in *different* modes, because the switch described below fell between them. That pair is
not evidence about runtimes; it is evidence about when the regime changed. Drop it and the mean
delta falls to **+0.06 s** over the remaining 11 pairs, all of which sit within ±1.8 s of zero with
no consistent sign. Note that pair 11's Δ of −1.30 s is *not* such a straddle: both arms were slow
there (10.14 vs 11.44), so it is a comparison within the slow mode, not across modes.

### Does it clear ADR-0036's bar? No — the distributions do not separate

ADR-0036 does not ask which median is lower; it asks for a **distribution-separated win**, the bar
Run 6 cleared on the strength of complete separation rather than the size of its delta.

| | node | bun-exec | separated? |
|---|---|---|---|
| full range | 1.78 – 10.97 s | 1.69 – 11.44 s | **no — near-total overlap** |
| fast mode only (< 6 s) | n=8, 1.78 – 4.09 s, p50 2.16 s | n=9, 1.69 – 2.65 s, p50 2.23 s | **no — overlap** |

**The delta is not quotable, regardless of its size.** That holds for the full distributions and it
holds for the fast mode, which is the only place a runtime difference could live.

One thing this does settle, in the negative: **Run 24's provisional fast-mode advantage to bun-exec
(~470 ms) did not reproduce — the sign reversed.** Run 24 measured node 2.45 s vs bun-exec 1.98 s;
this run measures node 2.16 s vs bun-exec 2.23 s. Run 24 marked that figure "must not be quoted
until a repeat run reproduces it." The repeat run did not reproduce it. It should now be treated as
withdrawn, not pending.

### Slow-mode occurrence, this sitting only

Per arm, out of the 12 complete pairs. **Not pooled with Run 24 or Run 25** — per the Caveat, these
are reported as a sitting, and the across-sitting rate is a range, not an average.

| arm | slow (≥ 6 s) | samples |
|---|---|---|
| node | **4 / 12** | 10.97, 10.14, 10.48, 10.64 |
| bun-exec | **3 / 12** | 11.44, 10.23, 10.57 |

The empty band is real in this run and was checked rather than assumed from Run 24: the largest gap
in the sitting's pooled samples is **4.09 s → 10.14 s**, a 6.05 s void with nothing in it.

### The finding: the slow mode is a regime, not a per-sample coin flip

The mode did not scatter through the sitting. It switched on, in both arms, and stayed on:

| arm | pair 1 → 13 |
|---|---|
| node | fast fast fast fast fast fast fast fast fast **SLOW SLOW SLOW SLOW** |
| bun-exec | fast fast fast fast fast fast — fast fast fast **SLOW SLOW SLOW** |

Not one slow sample before pair 10; not one fast sample after pair 11. Both arms crossed over
within one pair of each other, i.e. within a few minutes of the same wall-clock moment.

**This is the result that matters, and it invalidates a whole class of analysis.** Every treatment
of this mode so far — including Run 24's withdrawn Fisher test — has modelled it as a per-sample
Bernoulli draw with some base rate. It is not. Within a single sitting it behaves as a **regime that
switches and persists**, so samples are not independent and "7 of 10" or "4 of 12" are not estimates
of a probability. They are descriptions of where the switch happened to fall relative to the run.

That also dissolves the Run 24 vs Run 25 puzzle without needing either to be wrong: 7/10 and 0/10
are what you get from sittings that caught different sides of a switch.

It is also the vindication of interleaving. Had this run used sequential arms — all of one, then all
of the other — the switch at pair 10 of 13 would have put whichever arm ran **first** almost entirely
inside the fast regime and whichever ran **second** almost entirely inside the slow one. The run
would then have reported a several-fold win for the arm that happened to go first (~2.2 s vs
~10.5 s), in whichever direction the running order fell. That number would have been an artifact of
*when* each arm ran and nothing else — and nothing in the sequential design would have revealed it.

### Attribution — where the extra ~8.5 s is not, and where it looks like it is

Run 25 closed by naming what was missing: pull, connection setup and scheduling were excluded "for
the fast samples measured here, which does not exclude them for the slow mode nobody has yet caught
with an instrument attached." This run caught it. Across all 26 samples:

- **Scheduling is excluded.** `pod created → PodScheduled` was **0.00 s on all 26 samples**, slow
  and fast alike. The scheduler is not where the time goes.
- **Image pull is excluded.** **Zero image pulls across all 26 samples** — every pull event reads
  `already present on machine`, for the app image and the queue-proxy alike.
- **Node placement does not predict the mode.** Both cluster nodes produced both modes
  (`10.0.1.253`: 5 slow / 15 fast; `10.0.1.78`: 2 slow / 3 fast — the 25 samples that carry a
  duration, i.e. all but the excluded pair-7 rep).

Where it *does* look like it goes, stated with its sample size rather than dressed up: on the four
samples where the collector captured the complete in-pod chain, the extra time sits between the
**user container starting and the pod being marked Ready**.

| | n | pod created → Ready | user-container start → Ready |
|---|---|---|---|
| slow (≥ 6 s) | 2 | 11.00 s | **9.00 s** |
| fast (< 6 s) | 2 | 2.50 s | **1.50 s** |

**Read this as indicative, not established.** It is 2 samples against 2, and both slow samples with
complete timing are **bun-exec** — so the in-pod attribution is measured on one arm only. What is
established across all 26 is the negative half: not the scheduler, not image pull, not placement.
The positive half needs a run that captures the in-pod chain on every sample, which means a poll
tighter than the transitions it is trying to observe.

### Cluster state at hand-off

- **Both services are byte-identical to their pre-run baselines.** Captured before the first sample
  and re-fetched after the last, then compared on template annotations, containers,
  `containerConcurrency`, `timeoutSeconds` and traffic: **identical for both `p1b-node` and
  `p1b-bunexec`.** The run changed no product code and no service spec.
- Both `p1b-*` services scaled to zero; no k6 Jobs or ConfigMaps left behind (`bench-run` label
  selector returns nothing).
- Side effect, same as Run 24 noted: each harness capture/restore mints Knative revisions, so 26
  samples took `p1b-node` to 78 revisions and `p1b-bunexec` to 72. They are unrouted and scaled to
  zero, but this accumulates and is worth pruning before it becomes its own confound.
- The `cc-measure`, `cc-probe`, `fm-loadtest` and `vinext-bench` pods in the namespace predate this
  run, as they predated Run 24.

### What would settle it

- **The ADR-0036 P1b question is still not decidable from end-to-end cold start on this cluster.**
  A regime that adds ~8.5 s and, here, persisted for the final ~35 minutes of the sitting swamps
  any plausible runtime difference. The
  arms are indistinguishable here, and that is the honest answer this run supports.
- **Measure the switch, not the samples.** The useful experiment is no longer "n more cold starts";
  it is a standing collector running across hours, recording when the regime flips and what else on
  the cluster changes at that moment. A cheap standing collector across many runs beats a longer
  single run, because the thing that varies is the sitting — and it now appears the thing that
  varies *within* a sitting is a switch with a timestamp, which is a far more tractable target.
- **If a P1b decision is needed sooner**, measure in-pod server boot directly, as Run 6 did. That
  comparison cleared the bar precisely because it measured a quantity this cluster's scheduling and
  readiness behaviour cannot swamp.

## Caveat

These are **point-in-time measurements on a specific small (2-node) OKE cluster** with a
zero-CPU-request target app — they demonstrate behavior and relative effect, not portable
absolute numbers or a performance guarantee for other clusters, node pools, or workloads.

**Run 25 adds the strongest version of that caveat this document has, and it applies backwards to
every entry here.** A *distribution* measured in one sitting is not *the* distribution. On the same
service, image digest and probe, one day apart, Run 24 saw a ~10.5 s mode in 7 of 10 samples and
Run 25 saw it in **0 of 10**. Both are honest measurements; neither describes the system on its own.

Three rules follow, and they are stricter than "repeat the run":

1. **A single sitting cannot establish that a mode exists, and cannot establish that it does not.**
   At n=10, a mode with a 20 % base rate is missed entirely about 11 % of the time. Report the
   sitting, not the system.
2. **Never pool across sittings.** Pooling would have averaged Run 24 and Run 25 into a mode that
   fires ~35 % of the time — a number describing no observed reality. Report per-sitting rates as a
   **range**.
3. **A comparison whose signal is mode *mixture* is invalid unless the arms were interleaved.**
   Run 24's arms ran sequentially, so its Fisher test assumed a fixed base rate that Run 25 showed
   moves. That statistic is withdrawn, not weakened.

The practical consequence for anyone measuring here: a cheap standing collector across many runs
beats a longer single run, because the thing that varies is the sitting.

**Run 26 sharpens rule 1 and undercuts the model all three rules are phrased in.** Those rules treat
the mode as a per-sample draw with some base rate — rule 1 even quotes a miss probability computed
that way. It does not behave like one. Interleaved across a single sitting, the mode switched on
in both arms within one pair of each other and then persisted to the end of the run: no slow sample
before pair 10, no fast sample after pair 11. **Within a sitting it is a regime with a timestamp,
not a coin flip**, so samples are not independent and a count like "7 of 10" or "4 of 12" is not an
estimate of a probability — it records where the switch fell relative to the run. Rule 2 survives
unchanged and rule 3 is strengthened: had Run 26's arms run sequentially, the switch would have
handed a spurious several-fold win to whichever arm happened to run first. Read the "20 % base
rate" arithmetic in rule 1 as
superseded, and treat *when* a sample ran as data rather than as noise.

Run 2 additionally showed that **even the "relative effect" half of that claim needs a repeated
run to stand up**: the burst A/B's median delta reversed between two runs of the same A/B against
the same cluster and app. Latency deltas here should be reported only when they reproduce across
runs; pod-count and time-to-N-pods observations proved far more stable and are the more
trustworthy signal from this harness.

Run 3 adds a second caveat about the *runs themselves*: two of three aborted on transient control-plane
errors, and run 3's dataset is **partial** — cold start and soak only, no burst phase. Read its
numbers as the six reps that completed before an experiment that was never finished — which is
exactly what the harness's own verdict line says. Any figure in this document should be checked against the run it
came from before it is quoted.

Run 4 sharpens the first caveat rather than relieving it. It is the only complete dataset here, and
it still **refuted the surviving burst conclusion** — run 2's "tuned reaches 2 pods instantly"
effect did not appear at all. With every burst reading so far contradicted by the next run, the
honest summary of this A/B is that **three runs have not been enough to measure it**. Read the
per-config latency and fan-out deltas in this document as open questions; read the pod-count,
error-rate, and median figures — which have held across all four runs — as the trustworthy output.

Run 6 is the one comparison here that clears that bar, and it clears it on a specific ground worth
naming: **complete separation between the two distributions**, not the size of its delta. It is
still a single-environment measurement of a single app image, and it measures **in-pod server boot**
rather than end-to-end cold start — so the 393 ms figure should be cited with that scope attached,
and not as a portable cold-start improvement. The baked-cache image that #437 produces remains
unmeasured on this or any cluster.
