# Scale-to-zero / burst benchmark harness

Reproducible harness behind [`docs/benchmarks/scale-to-zero-oke.md`](../../docs/benchmarks/scale-to-zero-oke.md).
That doc was originally produced from throwaway temp scripts — this directory commits
the real thing so anyone can re-run the same phases against any Knative Service, on
any cluster, and detect a cold-start/burst regression instead of just trusting a
point-in-time number.

Non-goal (see the issue this closes): this is **not** wired into CI as a blocking
gate — it needs a stable, dedicated perf environment, which is a separate decision.
It's also not the p99-cold-start-under-concurrency measurement itself (thundering
herd against a 0-pod service) — that's a follow-on increment built on top of this
harness.

## Requirements

- `kubectl` configured with a context that can read/patch the target `ksvc` and
  create Jobs/ConfigMaps in its namespace. **`get` permission is mandatory** — the
  harness refuses to run if it can't read the config it would have to restore.
- `jq`, used to capture the target's original autoscaling config in one atomic read.
- The target is a **Knative Service** (`ksvc`) — the harness patches
  `spec.template.spec.containerConcurrency` and `autoscaling.knative.dev/*`
  annotations directly.
- The load generator runs **in-cluster** (a k6 Job in the target namespace) so
  network egress latency doesn't get confounded with cold-start latency. Point
  `--url` at the ksvc's cluster-local DNS name (the default) unless you have a
  reason to test from outside the cluster.

## Quick start

```bash
# Dry run first — prints every kubectl/k6 action without touching a cluster.
./run.sh --service my-app --namespace default --dry-run

# Full run (cold-start + soak + burst A/B) against a real cluster:
./run.sh \
  --context my-kube-context \
  --namespace default \
  --service my-app \
  --max-scale 6 \
  --container-concurrency 15

# Just the burst A/B, with custom sizing:
./run.sh --service my-app --phases burst --container-concurrency 20 --max-scale 8

# Everything is also settable via env vars (flags win): KCTX, NS, SERVICE, URL,
# MAXSCALE, CC, IMG, K6_CPU_REQUEST, COLD_SAMPLES, SOAK_VUS, BURST_VUS, OUT, ...
```

Run `./run.sh --help` for the full flag list and defaults. **No cluster identity is
hardcoded** — `--service` is the only required flag; everything else (context,
namespace, URL, autoscaling knobs, k6 image, output path) has a documented default
you're expected to override for your own cluster.

## Phases

| Phase | What it does | Maps to |
|---|---|---|
| `cold` | N sequential single-request samples, each after waiting for the ksvc to scale to 0. Measures the full 0→1 wake (scheduling + container start + boot + first response). | Phase A in the published doc |
| `soak` | Sustained **think-time** load (default 120 VUs, 3-minute hold) at baseline autoscaling config. Measures steady-state latency/error-rate and scale-up from cold. | Phase C (+D scale-down) |
| `burst` | The **discriminating** burst A/B: pins `containerConcurrency` and runs **continuous, no-think-time** load, sized so `VUs ÷ containerConcurrency ≈ max-scale`, forcing real fan-out to the pod cap. Runs a `baseline` and a `tuned` burst-knob config, N reps each, and reports peak pods per rep. | Phase B ("discriminating burst A/B" section) |

Use `--phases` to pick a subset (`cold`, `soak`, `burst`, comma-combinations,
`all`, or `none`). Whichever subset you run, the target's autoscaling config is
restored when the script exits, via the single cleanup path (see below) — so you
can safely split phases across separate invocations.

`none` runs no load phases at all (capture + restore only), which is what the
tests use. Note that setting `PHASES=""` does **not** mean "no phases": the
script reads `${PHASES:-cold,soak,burst}`, and `:-` treats an empty value as
*unset*, so an empty `PHASES` runs **all three**. Pass `none` when you mean none.

## Reading the output

Results are appended to a plain-text log (default
`./results/<service>-<UTC timestamp>.txt`, override with `--out`). For each k6 run
you'll see:

- The k6 summary lines (`http_req_duration`, `http_req_failed`, `http_reqs`, `checks`, `vus_max`, ...).
- A `pods: peak=<N> time_to_2pods=<Ns> time_to_<max-scale>pods=<Ns|not-reached>` line
  from the pod sampler that polls `kubectl get pods -l serving.knative.dev/service=<svc>`
  every 3s for the duration of the run.

**Peak pods is the load-bearing number for the burst phase.** A *burst* rep that
never fans out past 1 pod produces a `*** WARNING: peak pods = ... did NOT fan
out ***` line — treat that rep's latency numbers as inconclusive for the burst
A/B, not as evidence the tuned config "won" or "lost".

That warning is **scoped to the burst phase on purpose**. In `cold`, one request
needs exactly one pod, and `soak` is think-time load that measures sustained
throughput — a peak of 1 is the *correct* outcome in both, so they print a plain
parenthetical (`(peak pods = 1 — expected for the cold phase: ...)`) instead.
Firing a warning where it can never indicate a problem just trains you to skim
past the one signal designed to make a false result visible.

### Run-integrity states

Every run ends with an explicit verdict line, so a partial dataset can never be
mistaken for a complete one:

| Output | Meaning |
|---|---|
| `run integrity: k6 metrics captured for all N rep(s) — dataset is complete` | The run reached the end of every configured phase, and every rep finished cleanly **and** produced all four required metric keys. Exit code 0. |
| `run integrity: ABORTED after N rep(s) — partial dataset, NOT the configured experiment` | A `FATAL:` abort stopped the run part-way (e.g. an autoscaling config that would not apply) after at least one rep had banked data. The reps that did run may be fine, but the reps that never ran are missing — **do not compare the halves of an A/B that only half-ran.** Non-zero exit (1 from the `FATAL:`). |
| `run integrity: no reps ran; no data collected — this file is NOT a dataset` | No rep executed at all (`--phases none`, a plain `--dry-run`, or an abort before the first rep). Exit code is whatever caused it — 0 for a dry run, non-zero for a `FATAL:` abort. Never read this file as a result. |
| `run integrity: N rep(s) ran but some LOST data — dataset is NOT complete` | The run finished all phases, but at least one rep is missing data or did not finish cleanly. **Exit code 2.** Preceded by the `*** RUN INCOMPLETE ***` block naming the reps. |
| `*** RUN INCOMPLETE — untrustworthy rep(s): <rep> [<reason>] ***` | Printed whenever a rep lost data, **independently** of how the run ended — a run can be both truncated *and* missing a rep, and you need to see both facts. Scope any claim to the reps that do have data, and say so. |
| `api retries: 0 (no transient API errors — clean control-plane run)` | Always printed. The control plane answered every call first try. |
| `api retries: N (transient API errors were retried — this run is NOT a clean first-try run)` | Printed with a `*** RUN DEGRADED BY TRANSIENT API ERRORS ***` block naming each retried operation. Every config that was applied was verified applied before it was measured, so if the run also completed all its reps the data is valid — the banner says so only in that case — but the control plane was flaky, so wall-clock timings may include control-plane stalls. If the run aborted or lost a rep, the banner says that instead and the `run integrity:` verdict below it is authoritative. See "Transient API retry" below. |

The verdict is derived from three facts — reps run, reps flagged incomplete, and
whether the run reached the end of its phases — so it always agrees with the exit
code. In particular, "nothing was flagged incomplete" is **not** sufficient for
`dataset is complete`: a run that aborted before doing all its configured work is
reported as `ABORTED`, not as complete.

A rep counts as **complete** only if both hold:

1. its captured metrics contain **all** of `http_req_duration`, `http_req_failed`,
   `http_reqs`, and `checks` — a *set* check, not a line count, so a truncated or
   partially-flushed summary is caught rather than passing as whole; and
2. `kubectl wait` observed `condition=complete`.

Rule 2 is deliberate: a Job that failed or timed out **is flagged even when its
summary looks whole**, because k6 also prints a summary on abort — those numbers
describe a truncated test, not the one that was configured. For a benchmark whose
output gets published, under-reporting confidence is the safe direction.

The per-rep failure names the reason and embeds the evidence:

```
  *** WARNING: k6 metrics INCOMPLETE — missing: http_req_duration, checks for 'burst-tuned-2' — this rep's result is INCOMPLETE. ***
  *** The raw k6 Job log is captured below, in this results file, because the Job itself does not survive the run. ***
  --- raw k6 Job log for 'burst-tuned-2' (job/k6-<run-id>-burst-tuned-2, last 200 lines) ---
  | ...
  --- end raw k6 Job log for 'burst-tuned-2' ---
```

Three things make this reliable:

- **The `kubectl wait` result is reported, not discarded.** Each rep states
  whether its Job `completed`, `failed`, or `timed-out`. k6 prints its summary
  *only at end of run*, so a Job that hasn't finished has no summary to scrape —
  `timed-out` is the tell.
- **The evidence outlives the run.** The per-rep Job delete is skipped for a bad
  rep, but the end-of-run cleanup sweeps Jobs by label and the Job carries
  `ttlSecondsAfterFinished: 300` — so for the *last* rep the Job is gone seconds
  later. The raw logs are therefore copied into the results file itself (last
  `RAW_LOG_TAIL_LINES`, default 200), which is the only copy guaranteed to
  survive.
- **Lost sampler data is not rounded to zero.** If the pod sampler produced no
  measurement at all, you get `peak pods = <no sampler data>` — fan-out for that
  rep is *unknown*, which is a different fact from a measured peak of 0.

> **Why this exists:** a validation run silently dropped one burst rep's k6
> metrics and still exited 0. The gap was caught by a human reading the doc, not
> by the harness, and it nearly produced a published "0 errors across all four
> reps" claim the data did not support. A benchmark that omits a rep in silence
> is worse than one that crashes, because the partial dataset *looks complete*.

Note that a results file embeds the target URL and raw k6 Job log lines, so give
it a skim before pasting it into a public issue. (k6 sends no auth headers, so
there are no credentials in there — this is a tidiness check, not a security one.)

## Two known false-result traps (read before trusting a result)

1. **Think-time load never fans out.** A workload with `sleep(N)` between
   requests (the `soak` phase's style) rarely keeps enough requests in flight to
   push a single pod over its `containerConcurrency` limit — even at 200 VUs. The
   first attempt at the burst A/B in the published doc used exactly this pattern
   and both configs converged on **peak pods = 1**, so the burst knobs had nothing
   to differentiate. That's why the `burst` phase here deliberately uses
   **continuous, no-think-time** load and pins `containerConcurrency` low enough
   that the configured VU count *must* exceed one pod's capacity. If you widen
   `--burst-vus` or `--container-concurrency` yourself, keep the ratio
   `VUs ÷ containerConcurrency ≈ --max-scale` or you'll reproduce the same
   inconclusive result.

2. **An oversized k6 CPU request silently produces a zero-load "result".** If the
   k6 Job's CPU request (`--k6-cpu-request`, default `150m`) doesn't fit on any
   node, the pod sits `Pending` forever, the Job eventually fails/times out, and
   you get an empty or near-empty metrics summary — which can look like "the
   service handled it fine" if you're not watching for it. This exact failure
   happened during the original OKE run (a 500m request went `Pending` on a
   near-full 2-node cluster). The harness watches for this: if the k6 pod hasn't
   left `Pending` within `SCHEDULE_CHECK_TIMEOUT` seconds (env var, default 20s;
   no dedicated flag — set the env var if you need to tune it), it logs a
   `*** WARNING: k6 pod ... still Pending ... FALSE zero-load result ***` line.
   Keep the default request small; only raise it if you've confirmed headroom
   with `kubectl describe nodes`.

## Self-cleaning, including on failure/interrupt

Before making any change, the harness captures the target ksvc's **current**
`containerConcurrency` and `autoscaling.knative.dev/{max-scale,target-burst-capacity,
panic-window-percentage,panic-threshold-percentage}` — whatever they actually are,
not an assumed baseline. This is a **single** `kubectl get ksvc -o json` whose exit
code is checked, so the capture is atomic and can't half-succeed. It requires `jq`.

**If that read fails, the harness aborts before touching anything.** A missing
ksvc, a typo'd `--service`, a transient API error, or RBAC that allows `patch` but
denies `get` all stop the run with a `FATAL:` message and a non-zero exit — nothing
is patched. This matters because "the get failed" and "the field is unset" are
otherwise indistinguishable, and acting on the latter would reset
`containerConcurrency` to `0` and strip all four annotations off a service that had
a real, load-bearing config.

Once the capture succeeds, a `trap` on `EXIT`, `INT`, and `TERM` restores exactly
those captured values (or removes the annotation via a JSON-patch `remove` if it
genuinely wasn't set originally) and deletes this run's k6 Jobs/ConfigMaps (labeled
`bench-run=<run-id>`), **even if the script is killed mid-run** (Ctrl-C, `kill`, a
crashed shell). This is the direct fix for the real incident behind this harness:
the manual runs that produced the published numbers were interrupted twice and left
the cluster patched with test autoscaling config.

**The restore always runs unbounded.** The per-call `timeout` box that bounds a hung
API call (see *Transient API retry* below) is explicitly cleared as the first
statement of the cleanup path, because cleanup is the last chance to un-mutate a
live service. This matters specifically on the signal path: bash defers a trapped
signal until the in-flight command completes and then runs the trap *before* the
next statement, so an interrupt arriving mid-call used to enter cleanup with the
per-call cap still armed and every restore patch got killed by it.

**A restore that fails is reported, not swallowed.** Each restore patch is
attempted independently — one failure never aborts the remaining steps — but if any
of them did not apply, cleanup prints

```
*** RESTORE FAILED — these keys did NOT apply: max-scale target-burst-capacity ***
*** <service> MAY STILL BE MUTATED by this benchmark. Check and restore it by hand … ***
```

instead of the usual `restored: …` line. Treat that as "the service is still
carrying benchmark config" and fix it by hand before trusting the service or any
later run. Note this can also fire benignly when removing an annotation that was
never set; over-reporting a failed restore is the safe direction, silently claiming
a successful one is not.

## Transient API retry

Two of the three original OKE runs aborted on the same one-off control-plane blip
while applying a burst config:

```
FATAL: failed to apply autoscaling config …; kubectl exited 1.
       kubectl said: Unable to connect to the server: net/http: TLS handshake timeout
```

Refusing to measure a config that was never applied is **correct and unchanged**.
But throwing away a valid partial dataset over a one-second blip forces a full
re-run, and long runs (p99 cold start under concurrency needs many samples) hit
that window often. So the two API calls whose failure aborts a run —
`apply_autoscaling`'s patch and `capture_original`'s read — now retry **transient**
errors with capped exponential backoff plus jitter.

**Terminal errors are never retried.** Classification is terminal-first, and
anything unrecognised is treated as terminal: a wrong "transient" verdict would
turn a real misconfiguration (typo'd `--service`, missing RBAC, invalid
annotation value) into a *slow* failure, which is worse than a fast one.

| Class | Examples | Behaviour |
|---|---|---|
| **transient** (retried) | TLS handshake timeout · connection refused/reset · i/o timeout · `unable to connect to the server` · context deadline exceeded · request timed out / `time allotted` · `TooManyRequests` / throttling · 5xx (`InternalError`, `ServiceUnavailable`, `an error on the server`) · unexpected EOF · network unreachable | Retry with backoff, up to the attempt/deadline bound |
| **terminal** (never retried) | `NotFound` · `Forbidden` · `Unauthorized` · `Invalid` / validation / unknown-field · `BadRequest` · `AlreadyExists` · `MethodNotAllowed` · `Gone` · `no such host` and `couldn't get current server api group list` (a wrong cluster/kubeconfig, not a blip) · **and every unrecognised message** | Fail immediately, exactly as before |

Classification is applied terminal-first on purpose: a terminal error that happens
to mention a timeout stays terminal.

Matching is on message substrings, so a pattern must not be able to fire on a
value that merely *contains* it. There is deliberately **no bare `429` pattern**:
kubectl renders a real rate-limit as `Error from server (TooManyRequests): …`,
which is matched by name, whereas a Knative admission denial for an out-of-bounds
annotation reads `expected 0 <= 429 <= 100` — and that value comes from your own
`--baseline` / `--tuned` flag. Matching `429` there would turn a typo'd flag into
a slow failure, which is exactly what the terminal-first bias exists to prevent.

| Knob | Default | Meaning |
|---|---|---|
| `API_RETRY_ATTEMPTS` / `--api-retry-attempts` | `4` | Total attempts per operation. `1` disables retrying. A value below `1` or non-numeric is clamped to `1`, and the startup banner reports the clamped value it will actually enforce. |
| `API_RETRY_BASE_MS` / `--api-retry-base-ms` | `500` | First backoff step; doubles each retry. |
| `API_RETRY_MAX_MS` / `--api-retry-max-ms` | `8000` | Per-step backoff ceiling. |
| `API_RETRY_DEADLINE_S` | `60` | **Total** wall-clock budget per operation — see below. Clamped to `1` the same way as the attempt count: at `0`/negative/non-numeric the per-call cap computed to `0`, which meant *no* `timeout` wrapper at all and a hung call was unbounded while the banner still advertised a bound. |
| `API_CALL_TIMEOUT_S` / `--api-call-timeout-s` | `deadline / attempts` (min `1`) | Hard cap on a **single** call. Clamped to the total budget. |

These are two different bounds and they must stay separate:

- `API_RETRY_DEADLINE_S` is the **total** budget for one operation. No new
  attempt is started once it has elapsed.
- `API_CALL_TIMEOUT_S` caps **one call**. Every attempt runs under `timeout(1)`,
  so a *hung* apiserver connection is terminated rather than waited on
  indefinitely.

The per-call cap defaults to `deadline / attempts`, floored at 1s, so that the
configured attempts normally fit inside the total budget. The floor means they
are not *guaranteed* to (a 3s budget over 4 attempts floors to 4×1s); the budget
check, not the arithmetic, is what bounds the run. When one knob did both
jobs, a hung first attempt consumed the whole budget and `API_RETRY_ATTEMPTS`
became **dead for exactly the failure this feature exists for** — a stalled
apiserver got one attempt regardless of the configured number. With defaults
(`60s / 4`), each call is capped at 15s and a stalled control plane still gets
its four attempts. Worst case for an operation is therefore ~`deadline` plus the
one per-call cap that may be in flight when the budget expires — not
`attempts × per-call duration`.

A call killed by the per-call cap is classified transient. If a further attempt
remains within the budget it is **counted as a retry**; if the budget or the
attempt count is exhausted, the operation is **counted as abandoned** (see
below). Either way it is recorded — a stalled run can never be reported as
clean.

This per-call cap needs `timeout` (or `gtimeout`) on `PATH` — GNU coreutils,
present on Linux and via Homebrew, **absent from a stock macOS**. Without it the
harness degrades to bounding retry *scheduling* only, so a hung call is not
itself interrupted and the worst case really is `attempts × per-call duration`.
The run prints a `NOTE:` line at startup when it is in that mode; install
coreutils to get the hard box.

Bounded means bounded: a genuinely unreachable cluster still aborts, just a few
seconds later. **On exhaustion the behaviour is exactly the old behaviour** — the
same `FATAL:`, the same restore of the captured original config, the same
`ABORTED` verdict and non-zero exit. The fail-closed guarantee is untouched:
`capture_original` still refuses to mutate a service whose original config it
could not read, whether that read failed once or four times.

Every retry **and every abandonment** is recorded in the results file:

```
  api-retry: op='apply-autoscaling' attempt=1/4 class=transient — retrying after 380ms; the API said: Unable to connect to the server: net/http: TLS handshake timeout
  api-abandoned: op='capture-original' — giving up after transient failures: the API_RETRY_DEADLINE_S=6s budget was spent after 2 attempt(s); the API said: i/o timeout: the API call did not return within the per-call cap of 2s …
…
*** RUN DEGRADED BY TRANSIENT API ERRORS — 2 retry/retries, 1 abandoned call(s): apply-autoscaling x2, capture-original x1 ***
```

This is deliberate. A run that limped through a flaky window must not produce an
artifact identical to a clean run — that would be another instance of the
"results look cleaner than reality" bug class this harness has already had three
of.

**How to read a retried run.** Grep the results file for `api retries:` — it is
always present, exactly once, near the verdict:

- `api retries: 0 (no transient API errors — clean control-plane run)` — clean
  first-try control-plane run. Nothing to caveat. This exact line is the **only**
  clean claim, and it is emitted only when the retry count *and* the abandonment
  count are both zero.
- `api retries: N, api calls abandoned after transient failure(s): M` — the
  control plane misbehaved.
  - `N > 0, M = 0`: every stall was recovered by retrying. The numbers are still
    *valid* — a config is only measured after it was verified applied, so no rep
    was taken against a half-applied service — but the run's **wall-clock timings
    may be inflated** by the backoff spent inside the retried operation.
  - `M > 0`: an operation was given up on (attempts or budget exhausted), so the
    run aborted. Read the run-integrity verdict: this file is not a complete
    dataset. A call killed by the per-call cap counts here even if it was the
    only attempt, which is what stops a stalled run from reading as clean.

  Read the `api-retry:` / `api-abandoned:` lines above the verdict to see which
  operation stalled and by how long.

Practical consequences: quote a retried run's cold-start numbers with the
degradation noted, don't silently pool a retried run with clean runs in the same
p99 claim, and if the retry count is high enough to matter, re-run rather than
caveat.

What is *not* retried: k6 workload failures. A failed load generator is a real
result, not a blip.

## Tests

Three paths here can produce real damage or a real lie, so all three have tests:

```bash
bash benchmarks/scale-to-zero-oke/capture-restore.test.sh      # can damage a service
bash benchmarks/scale-to-zero-oke/k6-metrics-integrity.test.sh # can publish a false result
bash benchmarks/scale-to-zero-oke/api-retry.test.sh            # can mask an unreachable cluster
```

All three drive `run.sh` against a stub `kubectl` (via the `KUBECTL_BIN` +
`DRY_RUN_EXERCISE_KC=1` test seam). `capture-restore` asserts that a failed
capture aborts without issuing a single `patch`, and that a successful capture
restores the exact original values. `k6-metrics-integrity` asserts the honest-
reporting rules above: a rep with no metrics — or with a *partial* summary, or
one whose Job did not finish cleanly — warns loudly and exits non-zero, its raw
log lands in the results file, a zero-rep run refuses to claim completeness,
`kubectl wait` outcomes are distinguished, lost sampler data reads
`<no sampler data>`, and the fan-out warning is scoped to the burst phase.
`api-retry` asserts both directions of the classification above against real
kubectl error strings — a transient error is retried and the run completes, a
terminal one is attempted *exactly once*, exhaustion still restores the config and
reports `ABORTED`, retries appear in the results file, and a clean run reports
zero retries.

Two further env-var seams exist only to keep those tests fast and deterministic;
leave them alone in a real run:

- `SAMPLER_SIMULATE_LOST=1` makes the pod sampler exit without flushing, which is
  the only practical way to reach the `<no sampler data>` branch — the real race
  (sampler killed before its `TERM` trap runs) was never observed in practice, but
  the branch still has to be correct, because coercing it to `0` would publish an
  unmeasured number as a measurement.
- `APPLY_SETTLE_SECONDS` (default `8`) is the post-patch settle sleep; the tests
  set it to `0`.

Note that plain `--dry-run` deliberately short-circuits before any cluster read,
so it does *not* exercise these paths — that's what the stub is for. Because the
seam makes the script genuinely mutate, the banner says so rather than claiming
"no kubectl mutation, no cluster required".

Note the annotation keys are **kebab-case** (`autoscaling.knative.dev/max-scale`),
not camelCase (`maxScale`) — Knative's KPA silently ignores the camelCase form, so
a script (or a manual `kubectl patch`) using it looks like it worked but changes
nothing.

## What's NOT covered here

- CI wiring / regression gating — deliberately out of scope for this harness (see
  Non-goal above).
- p99 cold-start **under concurrency** (N simultaneous requests hitting a 0-pod
  service) — the `cold` phase here is N *sequential* single-request samples, matching
  the published methodology. The concurrent thundering-herd case is a follow-on.
