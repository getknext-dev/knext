# knext SLOs / SLIs

Service-level objectives for a knext-deployed app and its control plane, with the
PromQL that computes each SLI from series this codebase actually exports. The
alerts that fire on a breach live in
[`packages/kn-next-operator/config/observability/prometheusrule.yaml`](../../packages/kn-next-operator/config/observability/prometheusrule.yaml);
the 3am response is in [`../runbooks/incident.md`](../runbooks/incident.md).

The structured-logging standard and the request/correlation-ID contract (the
`correlation_id` / `trace_id` fields that make logs joinable to traces) are in
[`logging.md`](./logging.md); end-to-end distributed tracing (the
`knext.cold_start` / `knext.db_wake` spans that attribute cold-path latency) is
in [`tracing.md`](./tracing.md). The **full metric catalog** (every name, type,
label, and the scrape setup) is in [`metrics.md`](./metrics.md).

## Where the series come from

| Series | Exported by |
| --- | --- |
| `knext_bunexec_http_requests_total{status_class}` | **runtime** — the compiled executable's `:9464` exposition (`renderMetrics`). Request rate; the `5xx` slice is the error rate |
| `knext_bunexec_http_request_duration_seconds_bucket{le}` | runtime — same endpoint (golden latency) |
| `knext_bunexec_http_inflight_requests` | runtime — same endpoint (golden saturation) |
| `knext_bunexec_startup_duration_seconds` | runtime — set once per process, at listener bind. The cold-start signal |
| `knext_bunexec_process_uptime_seconds` / `knext_bunexec_process_resident_memory_bytes` | runtime — same endpoint |
| `knext_nextapp_reconcile_total{result}` | operator — `internal/controller/metrics.go` |
| `knext_nextapp_reconcile_errors_total` | operator — same |
| `knext_nextapp_reconcile_duration_seconds_bucket` | operator — same |
| `knext_nextapp_image_prewarm_errors_total` | operator — same |
| `workqueue_depth{name="nextapp"}` | operator — controller-runtime workqueue provider (control-plane saturation) |
| `knext_nextapp_condition{type,status,namespace,name}` | kube-state-metrics, reading `NextApp.status.conditions` (Ready / Degraded / Reconciling) the reconciler populates — see "kube-state-metrics" below |
| `up{job="knext-nextapp"}` | Prometheus itself — per-target scrape health, and the anchor for the staleness meta-alerts |

**Not on the shipped scrape.** `knext_http_*`, `knext_coldstart_*`,
`knext_db_wake_*`, `knext_deep_health_state` and every `kn_next_*` series are
registered by an APP into a prom-client registry served on the app port through
`/api/metrics`. Since ADR-0048 the runtime no longer merges those onto `:9464`,
and the shipped `PodMonitor` scrapes `:9464` only — so an SLI written against
one of them is empty unless you add your own scrape config. Those rules live in
the separate `knext.app.node-legacy` group. See
[`metrics.md`](./metrics.md#not-on-the-shipped-scrape-app-owned-registries).

Scale-to-zero caveat: when an app is scaled to zero it exports **no** app series
and its Grafana panels go blank. Availability/latency SLIs are therefore
evaluated over rolling windows and the control-plane SLOs (operator) remain
observable because the operator is always-on. This is also why the staleness
meta-alerts below anchor on `up` rather than on `absent()` of an app series: an
idle app is legitimately absent, and an alert that fires nightly gets muted.

## SLOs

### 0. The alerting is not blind (meta)
**Objective:** every SLI below is actually being measured.

A PromQL query naming a series nobody emits returns an empty vector — no error,
no alert, a blank panel. A healthy quiet system and a totally broken metrics
pipeline look identical, which is how the app-alert group sat dead for weeks
after the runtime's metric names changed. Two rules close that:

```promql
up{job="knext-nextapp"} == 0
```
Alert: `KnextAppMetricsTargetDown` (10m, critical) — the target is discovered
but unscrapeable.

```promql
(up{job="knext-nextapp"} == 1)
  unless on (namespace, pod) knext_bunexec_process_uptime_seconds
```
Alert: `KnextAppMetricsContractBroken` (15m, critical) — the scrape *succeeds*
and returns nothing these rules recognise. That is what a metric rename looks
like from Prometheus' side.

### 1. Availability (app)
**Objective:** ≥ 99.5% of server-handled requests succeed (non-5xx) over 28 days.

SLI (5xx ratio — the alert inverts this):
```promql
sum(rate(knext_bunexec_http_requests_total{status_class="5xx"}[5m])) by (app)
  /
sum(rate(knext_bunexec_http_requests_total[5m])) by (app)
```
Alert: `KnextHighErrorRate` fires when the 5m ratio exceeds 5% for 10m.

This also carries the backing-store signal. A deep `/api/health` route returns
503 when Redis or Postgres is unreachable, and that 503 lands in the `5xx`
slice. The old per-route form (`KnextCacheUnreachable`, filtering
`route="/api/health"`) is **retired**: the runtime emits no `route` label,
because a route label is unbounded by construction and one crawler would mint a
series per URL. Reintroducing it needs an explicit bounded route allowlist
first.

### 2. Cold-start latency (app)
**Objective:** cold start ≤ 3s. Cold starts dominate the user-visible latency
of a scale-to-zero app, so this is the latency SLO that matters most.

SLI:
```promql
max by (app) (knext_bunexec_startup_duration_seconds)
```
Alert: `KnextColdStartLatencyHigh` (> 3s for 15m). The gauge is set once per
process from `process.uptime()` at the moment both listeners bind, so it covers
the Bun bootstrap and every module evaluation a waking pod pays for. One sample
per pod means the fleet distribution *is* the gauge; `max`/`quantile` over it is
the correct aggregation, not `histogram_quantile`.

There is no warm/cold split any more. The compiled executable has no V8 compile
cache, so every start is a cold start — the `cache_status` label and the
`kn_next_bytecode_cache_*` series belong to the retired node-server path.

Request-latency SLI (warm path):
```promql
histogram_quantile(0.95,
  sum(rate(knext_bunexec_http_request_duration_seconds_bucket[5m])) by (le, app)
)
```
Alert: `KnextHighRequestLatency` (p95 > 1s for 15m). Buckets run 5ms…10s with
five under 100ms, so a warm p50 is a real number rather than an interpolation
across one enormous first bucket.

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

The deep readiness probe (`checkDeepHealth`, `@getknext/lib`) backs the Knative
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
