# The bimodal cold-start slow mode: nine one-second probe timeouts

**Status:** measured 2026-08-11, by controlled placement. Supersedes the standing
"unattributable because the pods were gone before their placement could be inspected"
note (Run 24).

**It also corrects an earlier revision of this document**, which concluded the slow mode
was node-local to `10.0.1.78`. **That conclusion was wrong** — see
[The node hypothesis, and why it died](#the-node-hypothesis-and-why-it-died). It is
recorded rather than deleted because the observational evidence for it looked strong
(0/41 vs 5/12), and the way it failed is the useful part.

## What the slow mode is

**Exactly nine consecutive one-second readiness-probe timeouts against the queue-proxy
sidecar**, after which the pod goes Ready normally.

With 16 cold starts under controlled placement, the split is perfectly clean:

| | Unhealthy events before `Killing` | listen→Ready gap |
|---|---|---|
| **slow pods** (5) | `Unhealthy × 9` — `Get "http://<podIP>:8012/": context deadline exceeded` | 8.6–9.3 s |
| **fast pods** (11) | none (only benign 503s during teardown) | −0.4 to 1.2 s |

Nine probes × `timeoutSeconds: 1` accounts for the entire gap. The count is **9 every
time**, on both nodes — a fixed mechanism, not variable work, which is what the
suspiciously clean 6.36 s band in the original 24-sample distribution was pointing at.

Port 8012 is the Knative **queue-proxy**. The distinction that matters:

- **503** — queue-proxy answers, reporting the app not yet ready. Normal, clears in ~1 s.
- **timeout** — queue-proxy accepts the connection but never responds, so the kubelet's
  1 s deadline expires.

## Where the time is *not* spent

Both containers are up early, and **identically so in fast and slow pods**:

| | user-container `LISTENING` | queue-proxy `main:8012` bound |
|---|---|---|
| fast pods | 1.37–2.26 s | 1.55–2.49 s |
| slow pods | 1.02–2.21 s | 1.19–2.41 s |

The slow pods start listening *earlier* on average. So the delay is not image pull, not
container start, not app boot, and not the build target. It is entirely in the readiness
path, after everything is already listening.

It is also **not the health handler doing dependency work** —
`examples/bun-exec/app/api/health/route.ts` is a static `Response.json`, with no PG or
Redis dial by ADR-0026.

## The node hypothesis, and why it died

Observationally the effect looked perfectly node-local: across 53 pods,
`10.0.1.253` was 0/41 slow and `10.0.1.78` was 5/12. Six mechanisms were ruled out
against that hypothesis, and those refutations still stand on their own evidence:

- **node health** — `.78` is the *quieter* node on every indicator (loadavg 0.02 vs 1.38,
  direct-reclaim stalls 2 vs 150, `pgmajfault` 18k vs 61k, iowait 447k vs 1.77M jiffies,
  steal 891k vs 2.20M), so CPU/memory/IO/steal starvation cannot explain it;
- **general container startup** — five paired runs of an identical busybox pod:
  `.253` 1,1,1,2,2 s vs `.78` 1,1,1,2,4 s;
- **concurrent-start contention** — `.253` had 18 pods start in bursts of 3+ with zero
  slow, while `.78` pods starting *alone* were slow 3 of 5;
- **a transient event** — slow pods alternate with fast ones across 13 minutes;
- **config drift** — identical OS, kernel, CRI-O, kubelet, capacity, taints;
- **CNI errors** — flannel on `.78` has logged nothing since node boot.

**The controlled test refutes it anyway.** Two throwaway Knative Services pinned with
`nodeSelector`, one per node, cloned from `p1b-bunexec`'s exact pod shape, 16 samples
ABBA-interleaved:

| arm | samples (s) | slow |
|---|---|---|
| `nodepin-78` | 2, 2, 2, 2, 2, 10, 11, 2 | 2/8 |
| `nodepin-253` | 3, 11, 3, 10, 2, 1, 2, 10 | 3/8 |

The slow mode fires on **both** nodes at comparable rates. The observational asymmetry
was a **sampling confound**: every *measured* cold start happened to be scheduled to
`.253`, and the `.78` pods in that dataset were a small, differently-composed population
of transient revision-activation pods. n=12 on one arm produced a 0-vs-5 split that
looked decisive and was not.

The lesson is the one this repo keeps relearning: a clean-looking split in observational
data is a hypothesis, not a finding, until placement is controlled.

## What is still unknown

Why queue-proxy accepts the TCP connection but fails to respond for ~9 s in roughly a
third of cold starts. The rate is consistent across datasets (5/16 pinned, 10/24 in the
earlier ABBA sitting), so it is reproducible, but the trigger is not identified.

Two measurements that were attempted and are **not** evidence, recorded so they are not
mistaken for negative results:

- **PSI** (`/proc/pressure/*`) is `UNREADABLE` — not compiled into this kernel.
- **conntrack reads 0 on both nodes**, because the probe pod sees its own network
  namespace, not the host's.

There is no historical fallback: this cluster's Prometheus scrapes kube-state-metrics
only — no cAdvisor, no node-exporter — so CPU-throttling and node-memory series do not
exist anywhere.

## Consequences

1. **The slow mode is a platform/Knative-layer effect, not a runtime or build-target
   effect.** Phase 1 already showed the two build targets indistinguishable in fast mode
   (2.65 s vs 2.55 s); the entire apparent 4.12 s pooled win was mode mixture. Roughly a
   third of cold starts pay a fixed ~9 s, and that is where cold-start work belongs.
2. **Cold-start numbers must be reported stratified by mode**, since the mode's base rate
   drifts between sittings — pooling manufactures differences that are not there.
3. `readinessProbe.timeoutSeconds: 1` converts a slow queue-proxy response into nine
   whole seconds of waiting. Whether raising it or `periodSeconds` shortens the tail is
   a cheap, obvious next experiment — and it is a mitigation, not a fix, until the ~9 s
   itself is explained.

## Reproducing

Attribution over an existing service (read-only; the collector must start **first**,
because Knative reaps the pod on scale-to-zero and placement becomes unrecoverable):

```
./cold-attribution-collector.sh <ksvc> <context> <namespace> out.jsonl &
./run.sh --service <ksvc> --phases cold --cold-samples N --sitting <id>
kill -TERM %1
node cold-attribution-report.mjs out.jsonl <results-file>
```

Node comparison: `./node-pressure-probe.sh` — one self-reaping Job per node, read-only
against `/proc`, no delete issued. It runs on **both** nodes always: a reading from a
suspect node alone cannot distinguish an anomaly from the cluster's normal.

Controlled placement requires `kubernetes.podspec-nodeselector: enabled` in the
`knative-serving/config-features` ConfigMap — Knative's webhook rejects `nodeSelector`
outright without it. The flag is permissive only and changes no running workload; it was
enabled for this experiment and reverted afterwards.
