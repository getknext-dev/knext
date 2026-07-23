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

1. Boot the **same runtime entry the image's `CMD` boots** — `node -e import('@knext/core/internal/node-server')`
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
graphs (`@knext/lib/clients` → `@cerbos/grpc`+`minio`+`pg`; `./metrics` → `prom-client`+OTel;
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
- **SUPERVISOR** — the shipped CMD `node -e "import('@knext/core/internal/node-server')"` (from a
  self-contained `pnpm --filter @knext/core --prod deploy`, mirroring the drain-e2e runner) spawning
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

**Correction to an earlier draft of this run: the 842 ms is NOT import/disk latency.** Run 9 Part B
falsified that "by a factor of sixteen" and identified the real mechanism: `collectDefaultMetrics()`
at module scope ran a **periodic process-metrics collector in the parent that competed for CPU with
the child during its ~2 s boot**, on `0`-CPU-request pods scheduled onto an **oversubscribed** node
(server.js booted +951 ms alongside a busy sibling, complete separation). The deferral fixes the
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

## Caveat

These are **point-in-time measurements on a specific small (2-node) OKE cluster** with a
zero-CPU-request target app — they demonstrate behavior and relative effect, not portable
absolute numbers or a performance guarantee for other clusters, node pools, or workloads.

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
