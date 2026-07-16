# knext incident runbook (day-2)

The 3am playbook for a knext-deployed app. Each scenario is **detect →
diagnose → remediate**, grounded in metrics this codebase actually exports
(`apps/file-manager/src/app/api/_metrics/registry.ts` and the operator's
`packages/kn-next-operator/internal/controller/metrics.go`) and the alerts in
[`../../packages/kn-next-operator/config/observability/prometheusrule.yaml`](../../packages/kn-next-operator/config/observability/prometheusrule.yaml).
SLO definitions: [`../observability/slos.md`](../observability/slos.md).
For "won't deploy / which failure mode am I in" (image rejected, stuck reconcile,
route never programs, webhook down), see the
[troubleshooting guide](./troubleshooting.md).

> knext is the **scale-to-zero Next.js adapter for Knative**. Two facts shape
> every response below:
> 1. When an app is scaled to zero it exports **no** app metrics and its Grafana
>    panels are blank — that is normal, not an outage. Trust the alerts/SLIs over
>    a blank dashboard.
> 2. The **operator is the single source of truth** (ADR-0001). You change desired
>    state by editing the `NextApp` CR (or via `kn-next` which only patches the
>    CR) — never by `kubectl edit` on the Knative Service directly.

## Quick reference

| Alert | Scenario |
| --- | --- |
| `KnextColdStartLatencyHigh` | [2 — cold-start latency spike](#scenario-2-cold-start-latency-spike) |
| `KnextHighErrorRate`, `KnextCacheUnreachable` | [3 — Redis/cache down](#scenario-3-rediscache-down) |
| `KnextOperatorReconcileErrors`, `KnextOperatorReconcileSlow` | [1](#scenario-1-scale-to-zero-stuck) / [4](#scenario-4-rollback--bad-revision) |
| `KnextNextAppDegraded` | [1](#scenario-1-scale-to-zero-stuck) / [4](#scenario-4-rollback--bad-revision) |

---

## Scenario 1: scale-to-zero stuck

The app will not scale up from zero on a request (cold request hangs / 503), or
the operator won't roll out a new revision.

### Detect
- User reports a hanging first request after idle, or Knative activator 503s.
- `KnextNextAppDegraded` firing → `knext_nextapp_condition{type="Degraded",status="true"}`.
- `KnextOperatorReconcileErrors` / `KnextOperatorReconcileSlow` if the control
  loop itself is wedged.
- Distinguish from a *healthy* scaled-to-zero state: a blank dashboard with no
  alert and a fast first request is **not** an incident.

### Diagnose
```sh
kubectl get nextapp <app> -n <ns> -o jsonpath='{.status.conditions}' | jq
kubectl get ksvc <app> -n <ns>                     # Knative Service Ready?
kubectl get revision -n <ns> -l serving.knative.dev/service=<app>
kubectl describe ksvc <app> -n <ns>                # activation / RevisionFailed events
```
Common causes: image digest not pullable (the operator rejects `:latest`, so a
bad digest surfaces here), failing readiness probe (`/api/health` 503 — see
Scenario 3), or KPA at `minScale: 0` with the activator unable to reach the pod.

### Remediate
- **Image won't pull / bad revision:** roll back to the last-good revision — see
  [Scenario 4](#scenario-4-rollback--bad-revision).
- **Readiness failing on a dependency:** fix the dependency (Scenario 3); the
  revision becomes Ready and the activator forwards the queued request.
- **Operator wedged** (`reconcile_errors` climbing): check operator logs
  `kubectl logs -n kn-next-operator-system deploy/kn-next-operator-controller-manager`;
  a transient apiserver/Knative-CRD error self-heals on requeue. Do **not** hand-edit
  the ksvc — re-apply the `NextApp` CR so the operator reconverges.

---

## Scenario 2: cold-start latency spike

First-request latency after scale-from-zero regresses (slow cold starts).

### Detect
- `KnextColdStartLatencyHigh` firing — cold-start p95 > 3s SLO:
  ```promql
  histogram_quantile(0.95,
    sum(rate(kn_next_startup_duration_seconds_bucket{cache_status="cold"}[15m])) by (le, app))
  ```

### Diagnose
- Check bytecode-cache warmth: `kn_next_bytecode_cache_warm_start{app="<app>"}`.
  A `0` (cold cache) after a fresh deploy is the usual cause — a new BUILD_ID
  means a new `NODE_COMPILE_CACHE` dir that has to be re-populated.
- Compare cold vs warm: `kn_next_startup_duration_seconds_bucket{cache_status="warm"}`
  should be materially faster. If warm is also slow, the regression is in app
  init, not caching.
- Confirm the bytecode cache PVC is actually mounted (operator provisions
  `<app>-bytecode-cache`): `kubectl get pvc -n <ns>`.

### Remediate
- If a new deploy invalidated the cache, latency recovers as the cache re-warms;
  if the regression persists, it is a code/dependency init regression — **roll
  back** ([Scenario 4](#scenario-4-rollback--bad-revision)) to the prior revision
  whose warm-start p95 met SLO.
- If the cache PVC is missing/unbound, fix the `NextApp` CR's cache settings and
  re-apply so the operator re-provisions it.

---

## Scenario 3: Redis/cache down

The Redis ISR/data cache (`cache-handler.js`) or Postgres is unreachable. ISR
reads/writes fail; deep health checks fail.

### Detect
- `KnextCacheUnreachable` firing — the deep `/api/health` route (which probes
  Postgres/Redis and is wrapped in `withRedMetrics`) returns 503:
  ```promql
  sum(rate(kn_next_http_requests_total{route="/api/health",status_class="5xx"}[5m])) by (app)
  ```
- Often accompanied by `KnextHighErrorRate` (overall 5xx ratio > 5%).
- App logs: connection-refused / timeout to the Redis or Postgres host.

### Diagnose
```sh
kubectl get pods -n <ns> -l app=redis        # or your managed-Redis status
kubectl exec -n <ns> deploy/<app> -- node -e 'process.exit(0)'   # pod alive?
kubectl get secret -n <ns>                   # DATABASE_URL / redis creds present?
```
The app reaches its store via env from a **K8s Secret** (never a hardcoded
host). A rotated/missing Secret, a scaled-down Redis, or a NetworkPolicy change
are the usual culprits. Note the operator reconciles a default-on internal-only
NetworkPolicy — verify it still permits egress to the cache.

### Remediate
- Restore Redis/Postgres (restart the statefulset / failover the managed
  instance). Knative readiness recovers automatically once `/api/health` returns
  200 and the queued requests drain.
- If a Secret was rotated, update the K8s Secret; the pod picks up new env on the
  next revision roll (re-apply the `NextApp` CR to force it).
- Do **not** disable the health check to "stop the alert" — that hides a real
  data-loss/ISR-staleness condition.

---

## Scenario 4: rollback — bad revision

A new deploy is serving errors / latency regressions and must be reverted. This
is the **ADR-0014 traffic-split path**: you shift Knative traffic to a prior
revision by patching `NextApp.spec.traffic` — the operator reconciles the ksvc.

### Detect
- `KnextHighErrorRate` and/or `KnextNextAppDegraded` shortly after a deploy.
- `KnextColdStartLatencyHigh` if the new revision regressed cold start.
- Correlate the alert's start time with the rollout.

### Diagnose
```sh
kubectl get nextapp <app> -n <ns> -o jsonpath='{.status.currentTraffic}' | jq
kubectl get revision -n <ns> -l serving.knative.dev/service=<app> \
  --sort-by=.metadata.creationTimestamp        # find the last-good revision name
```
Identify the last-good Knative revision (e.g. `<app>-00007`).

### Remediate — pin traffic to the good revision
Preferred (CLI, which **only** `kubectl patch`es the CR — never mutates the ksvc
directly, honoring ADR-0001):
```sh
# 100% back to the last-good revision:
kn-next rollback <app> --to <app>-00007 -n <ns>

# Or a cautious canary: send N% to latest-ready, the rest to the pinned revision:
kn-next rollback <app> --to <app>-00007 --canary 10 -n <ns>

# Once the fix is deployed, clear the pin to resume latest-ready:
kn-next rollback <app> -n <ns>
```
Equivalent raw CR edit (`spec.traffic`, fields from
`packages/kn-next-operator/api/v1alpha1/nextapp_types.go`):
```sh
kubectl patch nextapp <app> -n <ns> --type merge -p \
  '{"spec":{"traffic":{"revisionName":"<app>-00007","canaryPercent":10}}}'
```
- `spec.traffic.revisionName` pins serving traffic to that prior revision
  (empty ⇒ latest-ready, no pin).
- `spec.traffic.canaryPercent` (1..99) sends that % to **latest-ready** and the
  remainder to the pinned revision; `0`/unset ⇒ 100% pinned.

### Verify
```sh
kubectl get nextapp <app> -n <ns> -o jsonpath='{.status.currentTraffic}' | jq
```
`status.currentTraffic` should report the pinned revision serving the expected
percentage; `KnextHighErrorRate` / `KnextNextAppDegraded` should clear within the
alert's `for:` window.
