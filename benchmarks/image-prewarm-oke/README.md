# image-prewarm live-cluster harness

Measures what `spec.scaling.imagePrewarm` (ADR-0037) is for: whether a cold
scale-from-zero still pays an image pull, and what that pull costs.

The results this produced are written up in
[`docs/benchmarks/image-prewarm-oke.md`](../../docs/benchmarks/image-prewarm-oke.md).

## Why it cannot run on kind

kind side-loads images into every node's containerd, so "no `Pulling` event on
cold start" is **trivially true there whether or not the prewarmer works** — a
green that proves nothing. The measurement needs a multi-node cluster pulling
from a real registry.

## What it does per replicate

1. Selects the arm **through the `NextApp` CR** — `kubectl patch nextapp …
   spec.scaling.imagePrewarm` — and waits for the `<app>-imgcache` DaemonSet to
   be Ready on every node (arm `on`) or to be gone (arm `off`).
2. Waits until the app has **no pods at all** for its active revision.
3. Forces the node image cache into the state the arm claims (arm `off` evicts
   the app image from every node) and then **asserts** it. A replicate whose
   precondition does not hold is recorded as failed, never measured.
4. Holds both arms to the same time-at-zero floor, then issues one request and
   records TTFB, plus an immediately-following warm request as that replicate's
   own baseline (which cancels client↔cluster RTT).
5. Records what the kubelet actually did: the pod, its node, and its
   `Pulling` / `Pulled` events (the `Pulled` message carries the pull duration
   and image size).

Arms are **interleaved ABBA within a pair**, not run sequentially: a
cluster-level slow mode switching on mid-run has already produced one withdrawn
result in this repo (ADR-0036 Run 24).

## Requirements

- A live multi-node cluster with Knative Serving, the knext operator, and a
  `NextApp` whose image is **digest-pinned** and pullable by the app's
  ServiceAccount.
- A **content-unique** app image, so the `off` arm is a real pull and so the
  harness never evicts an image it does not own. Build one in-cluster with
  [`build-unique-image.job.yaml`](./build-unique-image.job.yaml).
- Privileged pods allowed (`nodesh.sh` evicts the image via `crictl` in the host
  namespace — there is no Kubernetes API for evicting a cached image).
- **Nothing else running against the cluster.** Concurrent traffic keeps pods
  warm, so a "cold" start is not cold.

## Run

```bash
KUBE_CONTEXT=<ctx> NAMESPACE=knext-prewarm APP=pw \
PW_IMAGE=<registry>/<repo>@sha256:<digest> \
PW_PAIRS=5 \
node measure.mjs | tee results/run.log

node analyze.mjs results/results.jsonl
```

Environment: `KUBE_CONTEXT`, `NAMESPACE`, `APP`, `PW_IMAGE`, `PW_ENDPOINT`
(default `/api/health`), `PW_PAIRS`, `PW_SETTLE_FLOOR_MS` (default 150000),
`PW_DISK_ABORT_PCT` (default 85), `PW_OUT`, `PW_PAIR_START`.

`analyze.mjs` reports each arm's full distribution (n, min, p25, median, p75,
max, mean, sd), the per-pair ABBA deltas, and whether the distributions overlap.
It never pools the arms and never reports a median alone.

The pure half of the harness (`lib.mjs`) is unit-tested offline by
`tests/image-prewarm-harness.test.ts` — the reference/node-name validation, the
exact-repository selector, the "an absent observation fails the replicate" rule,
the fatal-vs-recorded split, and the restore.

## Three ways it can lie to you, all learned the hard way

- **`crictl images -q <repo>` returns nothing for a digest-only image even when
  the image is present.** The first run of this harness trusted it, so the "no
  prewarm" arm never actually evicted anything and every replicate reported
  `already present on machine`. Presence is checked with `crictl inspecti`.
- **Node disk.** Repeated pulls of a few-hundred-MB image can push a node past
  the kubelet's image-GC high threshold, at which point the kubelet starts
  evicting images the benchmark does not own — which both corrupts later
  measurements and damages other work on the cluster. The harness reads each
  node's root-disk usage every replicate and aborts the **run** at
  `PW_DISK_ABORT_PCT` (it used to abort the replicate, which the caller caught,
  so the next replicate pulled another few hundred MB onto the same node).
- **An observation that did not happen is not an observation.** `Pulling` is the
  headline criterion, and "no `Pulling` event" is also what you get from a pod
  that could not be found or an events query that failed. Both now FAIL the
  replicate; `analyze.mjs` refuses to count a row without a boolean `pulling`.
  Getting this wrong is invisible because it fails toward the desired answer.

## Cleanup

The harness restores the `spec.scaling.imagePrewarm` value it found before the
run and **reads it back to prove the restore landed**; a restore that does not
take effect aborts loudly. `nodesh.sh` Jobs carry `ttlSecondsAfterFinished`, so
they reap themselves.

This used to be a line in this README instead: `ORDER` ends with `on`, so every
run exited leaving a prewarm DaemonSet — and therefore a warm image — resident on
every node, delegated to a human remembering to undo it. The next benchmark on
that cluster inherits it and cannot tell. A checklist is not a restore.

Still yours to do when you are finished with the cluster: **remove the app and
its namespace**, and delete the content-unique image from the registry.

**Not covered:** a `SIGKILL`ed run cannot restore anything. Check
`kubectl get nextapp <app> -o jsonpath='{.spec.scaling.imagePrewarm}'` before
trusting a later measurement on the same cluster.
