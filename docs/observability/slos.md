# knext SLOs / SLIs

Service-level objectives for a knext-deployed app and its control plane, with the
PromQL that computes each SLI from series this codebase actually exports. The
alerts that fire on a breach live in
[`packages/kn-next-operator/config/observability/prometheusrule.yaml`](../../packages/kn-next-operator/config/observability/prometheusrule.yaml);
the 3am response is in [`../runbooks/incident.md`](../runbooks/incident.md).

## Where the series come from

| Series | Exported by |
| --- | --- |
| `kn_next_http_requests_total{app,method,route,status_class}` | app — `apps/file-manager/src/app/api/_metrics/registry.ts` (`observeHttpRequest` / `withRedMetrics`) |
| `kn_next_http_request_duration_seconds_bucket{…}` | app — same registry (RED duration histogram) |
| `kn_next_startup_duration_seconds_bucket{cache_status,app}` | app — observed once per process start |
| `kn_next_bytecode_cache_warm_start{app}` | app — 1 if the V8 bytecode cache was warm at boot |
| `knext_nextapp_reconcile_total{result}` | operator — `internal/controller/metrics.go` |
| `knext_nextapp_reconcile_errors_total` | operator — same |
| `knext_nextapp_reconcile_duration_seconds_bucket` | operator — same |
| `knext_nextapp_condition{type,status,namespace,name}` | kube-state-metrics, reading `NextApp.status.conditions` (Ready / Degraded / Reconciling) the reconciler populates — see "kube-state-metrics" below |

Scale-to-zero caveat: when an app is scaled to zero it exports **no** app series
and its Grafana panels go blank. Availability/latency SLIs are therefore
evaluated over rolling windows and the control-plane SLOs (operator) remain
observable because the operator is always-on.

## SLOs

### 1. Availability (app)
**Objective:** ≥ 99.5% of server-handled requests succeed (non-5xx) over 28 days.

SLI (5xx ratio — the alert inverts this):
```promql
sum(rate(kn_next_http_requests_total{status_class="5xx"}[5m])) by (app)
  /
sum(rate(kn_next_http_requests_total[5m])) by (app)
```
Alert: `KnextHighErrorRate` fires when the 5m ratio exceeds 5% for 10m.

A specific availability signal — backing-store (Redis ISR cache / Postgres)
reachability — is read off the deep `/api/health` route, which returns 503 when a
dependency is down and is wrapped in `withRedMetrics`:
```promql
sum(rate(kn_next_http_requests_total{route="/api/health",status_class="5xx"}[5m])) by (app)
```
Alert: `KnextCacheUnreachable`.

### 2. Cold-start latency (app)
**Objective:** cold-start p95 ≤ 3s. Cold starts dominate the user-visible latency
of a scale-to-zero app, so this is the latency SLO that matters most.

SLI:
```promql
histogram_quantile(0.95,
  sum(rate(kn_next_startup_duration_seconds_bucket{cache_status="cold"}[15m])) by (le, app)
)
```
Alert: `KnextColdStartLatencyHigh` (p95 > 3s for 15m). Correlate with
`kn_next_bytecode_cache_warm_start` — a cold cache after deploy is the usual cause.

Request-latency SLI (warm path), for reference:
```promql
histogram_quantile(0.95,
  sum(rate(kn_next_http_request_duration_seconds_bucket[5m])) by (le, app, route)
)
```

### 3. Reconcile-error rate (control plane / operator)
**Objective:** zero reconcile errors in steady state; reconcile p95 ≤ 30s.

Error SLI:
```promql
increase(knext_nextapp_reconcile_errors_total[10m])
```
Alert: `KnextOperatorReconcileErrors` (> 0 for 5m, critical) — the operator is the
single source of truth (ADR-0001), so a failing reconcile means cluster state may
diverge from the `NextApp` CR.

Reconcile latency SLI:
```promql
histogram_quantile(0.95,
  sum(rate(knext_nextapp_reconcile_duration_seconds_bucket[10m])) by (le)
)
```
Alert: `KnextOperatorReconcileSlow` (p95 > 30s for 15m, warning).

### 4. NextApp health (control plane)
**Objective:** no `NextApp` stays `Degraded=True`.

SLI:
```promql
max by (namespace, name) (knext_nextapp_condition{type="Degraded",status="True"})
```
Alert: `KnextNextAppDegraded`.

## kube-state-metrics dependency (`knext_nextapp_condition`)

The reconciler populates `NextApp.status.conditions` (Ready / Degraded /
Reconciling), but Prometheus only sees them if kube-state-metrics is configured
to emit CRD conditions. This `CustomResourceStateMetrics` config now ships as an
applyable manifest — a ConfigMap at
`packages/kn-next-operator/config/observability/kube-state-metrics-crd-config.yaml`,
wired into the `config/observability` overlay. Apply it with
`kubectl apply -k config/observability`, then point kube-state-metrics at the
ConfigMap's `custom-resource-state.yaml` key (mount it +
`--custom-resource-state-config-file`, plus get/list/watch RBAC on
`nextapps.apps.kn-next.dev`). The embedded config:

```yaml
kind: CustomResourceStateMetrics
spec:
  resources:
    - groupVersionKind:
        group: apps.kn-next.dev
        version: v1alpha1
        kind: NextApp
      metricNamePrefix: knext_nextapp
      metrics:
        - name: condition
          help: "NextApp .status.conditions"
          each:
            type: StateSet
            stateSet:
              labelName: status
              path: [status, conditions]
              valueFrom: [status]
              # Capitalized to match metav1.Condition.Status verbatim — KSM StateSet
              # matching is case-sensitive (lowercase would keep the alert silent).
              list: ["True", "False", "Unknown"]
        # also exposes labels: type, namespace, name
```
Once the overlay is applied AND kube-state-metrics is pointed at this ConfigMap,
`knext_nextapp_condition` is emitted and `KnextNextAppDegraded` is live. If KSM
is not yet running with this config, the alert has no series — track the
condition via `kubectl get nextapp -o jsonpath` in the meantime (see runbook).

## Readiness dependency taxonomy (hard vs soft)

The deep readiness probe (`checkDeepHealth`, `@knext/lib`) backs the Knative
readiness gate, which under scale-to-zero decides whether a pod keeps serving
traffic or is **evicted**. Its overall verdict is derived by dependency
**severity**, not "any dependency down ⇒ down" (see ADR-0023):

- **Hard dependency (Postgres):** configured + unreachable ⇒ overall `down` —
  readiness **fails CLOSED**. The pod can't serve, so don't route to it or keep
  it in rotation. A slow-PG timeout is treated the same; the timed-out sub-check
  is never left falsely `up`.
- **Soft dependency (Redis-as-cache):** the cache layer **fails OPEN** (SCS/Zones
  contract) — a cache miss still serves from the origin. Configured + unreachable
  ⇒ overall `degraded` but still **Ready**; a cache blip must not evict a pod
  that can serve cache-miss traffic.

| postgres        | redis (cache)       | overall    |
|-----------------|---------------------|------------|
| up / unconfig   | up / unconfig       | `ok`       |
| up / unconfig   | down                | `degraded` |
| down            | up / down / unconfig | `down`    |
| timeout         | *                   | `down`     |

`degraded` is a **Ready** state, reserved for soft-dependency failures — it
surfaces reduced capacity to observability, it does not gate traffic.
