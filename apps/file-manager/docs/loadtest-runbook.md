# Load-test runbook (k6) — manual / nightly

> **This is NOT a PR gate.** It is a manual / nightly operability tool (#30, salvaged from PR #10
> onto the adapter approach). The PR-gated tests for this work are the k6 script/manifest
> *generators* (`packages/kn-next/src/__tests__/loadtest-job.test.ts`) — not running an actual
> load test. Run this against a deployed environment when you want real numbers.

## What it does

Generates a k6 `ConfigMap` (the test script) + a `Job` (runs `grafana/k6`) and applies them to the
cluster, targeting a **Knative ksvc URL**. The Job self-cleans via `ttlSecondsAfterFinished`.

Generators: `packages/kn-next/src/generators/loadtest-job.ts`
CLI: `kn-next loadtest` (`packages/kn-next/src/cli/loadtest.ts`)
Entrypoint: `scripts/load-test.sh`

## Scenarios

| `--type`          | Profile                                                       |
| ----------------- | ------------------------------------------------------------ |
| `smoke`           | 1 VU for 1m — sanity / liveness.                              |
| `load`            | ramp to 50 VUs, hold 2m, ramp down — steady-state capacity.  |
| `spike`           | burst 10 → 200 → 10 VUs — autoscaler reaction.               |
| `scale-to-zero`   | wake burst, wait 5m for scale-to-zero, second burst — cold start. |

The `scale-to-zero` scenario is the one that matters for knext's differentiator. It ties to
[`coldstart-bench-kind.md`](./coldstart-bench-kind.md): the `after_scale_down` burst (startTime
`5m`) measures real cold-start latency after Knative has scaled the revision to zero.

## Run

```bash
# Get the ksvc URL
URL=$(kubectl get ksvc -n default -o jsonpath='{.items[0].status.url}')

# Build the CLI bundle once (ships dist/cli/loadtest.js)
pnpm --filter @knext/core build

# Smoke
scripts/load-test.sh --url "$URL" --type smoke

# Cold-start (scale-to-zero) in a specific namespace
scripts/load-test.sh --url "$URL" --type scale-to-zero --namespace team-a
```

Tail results:

```bash
kubectl logs -n default -l app=k6-loadtest,target=<app-name> -f
```

## Prometheus remote-write (optional)

When the app's `kn-next.config.ts` has `observability.enabled: true`, the CLI wires
`K6_PROMETHEUS_RW_SERVER_URL` so k6 streams metrics into the in-cluster Prometheus via its
experimental remote-write output. Otherwise k6 writes summary stats to stdout only. No SaaS
target is ever configured (CLAUDE.md §8: no lock-in).

## Nightly

Wire `scripts/load-test.sh --type scale-to-zero` into a scheduled job (cron / nightly CI on a
real cluster) if you want trend data. It is intentionally kept **out of the per-PR pipeline** so a
flaky cluster or autoscaler timing never blocks a merge.
