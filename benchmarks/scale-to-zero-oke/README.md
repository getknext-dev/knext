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
  create Jobs/ConfigMaps in its namespace.
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

Use `--phases` to pick a subset (`cold`, `soak`, `burst`, comma-combinations, or
`all`). Whichever subset you run, the target's autoscaling config is restored when
the script exits, via the single cleanup path (see below) — so you can safely
split phases across separate invocations.

## Reading the output

Results are appended to a plain-text log (default
`./results/<service>-<UTC timestamp>.txt`, override with `--out`). For each k6 run
you'll see:

- The k6 summary lines (`http_req_duration`, `http_req_failed`, `http_reqs`, `checks`, `vus_max`, ...).
- A `pods: peak=<N> time_to_2pods=<Ns> time_to_<max-scale>pods=<Ns|not-reached>` line
  from the pod sampler that polls `kubectl get pods -l serving.knative.dev/service=<svc>`
  every 3s for the duration of the run.

**Peak pods is the load-bearing number for the burst phase.** A rep that never
fans out past 1 pod produces a `*** WARNING: peak pods = ... did NOT fan out ***`
line in the log — treat that rep's latency numbers as inconclusive for the burst
A/B, not as evidence the tuned config "won" or "lost".

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
not an assumed baseline. A `trap` on `EXIT`, `INT`, and `TERM` restores exactly
those captured values (or removes the annotation if it wasn't set originally) and
deletes this run's k6 Jobs/ConfigMaps (labeled `bench-run=<run-id>`), **even if the
script is killed mid-run** (Ctrl-C, `kill`, a crashed shell). This is the direct
fix for the real incident behind this harness: the manual runs that produced the
published numbers were interrupted twice and left the cluster patched with test
autoscaling config.

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
