# knext metrics (Prometheus)

Every Prometheus series knext exports for a `NextApp` and its control plane —
name, type, labels, and how to scrape them. The four **golden signals** (rate,
errors, latency, saturation) plus cold-start / DB-wake / bytecode-cache series
come from the runtime; reconcile + work-queue series come from the operator.

Related: [SLOs / SLIs](./slos.md) (the objectives these signals feed) ·
[distributed tracing](./tracing.md) (the `knext.cold_start` / `knext.db_wake`
spans these counters mirror) · [structured logging + correlation IDs](./logging.md)
· [OTel tracing backend](../adr/0012-otel-tracing-backend.md).

## Two scrape targets

| Target | Process | Port / path | Series |
| --- | --- | --- | --- |
| **App runtime** | the runtime supervisor (`node-server.ts`) | `:9091/metrics` | golden signals + cold-start + DB-wake (merged from the child) and the Node process metrics |
| **Operator** | the controller manager | its `/metrics` (HTTPS `:8443` by default) | reconcile count/duration/errors + `workqueue_depth` + controller-runtime + Go process metrics |

The operator sets `prometheus.io/scrape=true`, `prometheus.io/port=9091`,
`prometheus.io/path=/metrics` on every generated Knative Service, so annotation-
based Prometheus scrapes the app `:9091` with no extra config. For a **Prometheus
Operator** setup (CRD-based discovery, annotations ignored) ship the CRs in
`packages/kn-next-operator/config/prometheus/`: `monitor.yaml` (ServiceMonitor
for the operator) and `app-podmonitor.yaml` (PodMonitor for the per-app `:9091`).

### Why the app metrics ride a cross-process bridge

The golden-signal / cold-start / DB-wake metrics are **derived from core-owned
OpenTelemetry hooks** — the inbound HTTP SERVER span lifecycle, the
`ColdStartSpanProcessor`, and the `instrumentPoolForDbWake` pool wrapper (the
same hooks that emit the tracing spans, [tracing.md](./tracing.md)). There is
**no app route-handler wiring**: knext-core is the runtime supervisor, it does
not own the app's route chain, so per-request signals are read off the OTel
spans, not by wrapping handlers.

Those hooks run in the **Next.js child process**; the operator scrapes the
**supervisor's `:9091`**. So the child serves its core registry on a
localhost-only port (`KN_CHILD_METRICS_PORT`, default 9092) and the supervisor's
`:9091` handler merges it in (best-effort — a not-yet-up / scaled-to-zero child
just yields the process metrics). Because the metrics ride the OTel spans they
share tracing's **default-off** gate: they appear once
`spec.observability.tracing.enabled` (⇒ `OTEL_TRACING_ENABLED=true`) is set on
the `NextApp`.

## App runtime series (`:9091`)

Labels are deliberately **bounded** — `app` (from `KN_APP_NAME`), `method` (HTTP
verb), `status_class` (`2xx`..`5xx`, never the raw code), `role`
(`writer`|`reader`). No raw path/route, user, or session labels (unbounded
cardinality).

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `knext_http_requests_total` | counter | `app`, `method`, `status_class` | request RATE; the `status_class="5xx"` slice is the ERROR rate |
| `knext_http_request_duration_seconds` | histogram | `app`, `method`, `status_class` | request LATENCY |
| `knext_http_inflight_requests` | gauge | `app` | SATURATION (concurrently-handled requests) |
| `knext_coldstart_total` | counter | `app` | cold starts (app boot / first-request wake) observed |
| `knext_coldstart_duration_seconds` | histogram | `app` | cold-start wake duration |
| `knext_db_wake_total` | counter | `app`, `role` | scale-zero-pg 0→1 DB wakes (first connect) |
| `knext_db_wake_duration_seconds` | histogram | `app`, `role` | DB 0→1 wake / first-connect duration |

### Also on the app scrape (app-owned, not from the OTel hooks)

These predate #315 and are emitted by the app itself on `/api/metrics` (see
`apps/file-manager/src/app/api/_metrics/registry.ts`): the RED series
`kn_next_http_requests_total` / `kn_next_http_request_duration_seconds`
(hand-instrumented per route via `withRedMetrics`), the Web-Vitals RUM
histograms `kn_next_web_vitals_*`, and the **bytecode-cache** series —
`kn_next_bytecode_cache_files_total`, `kn_next_bytecode_cache_size_bytes`,
`kn_next_bytecode_cache_warm_start`, `kn_next_bytecode_cache_write_count`,
`kn_next_startup_duration_seconds{cache_status}`. The bytecode-cache hit/miss
signal is `kn_next_bytecode_cache_warm_start` (1 = warm/hit, 0 = cold/miss) plus
the `cache_status` label on the startup histogram. These live where the cache
decision is made (the app's compile-cache scan), which is why they are on
`/api/metrics` rather than the core `:9091` bridge — see the deferred note below.

## Operator series (operator `/metrics`)

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `knext_nextapp_reconcile_total` | counter | `result` (`success`\|`error`) | reconcile loops |
| `knext_nextapp_reconcile_duration_seconds` | histogram | — | reconcile loop duration |
| `knext_nextapp_reconcile_errors_total` | counter | — | reconcile loops that errored |
| `workqueue_depth` | gauge | `name` (`nextapp`), `priority` | control-plane WORK-QUEUE DEPTH (registered by controller-runtime's workqueue provider for the named `nextapp` queue) |

`workqueue_depth{name="nextapp"}` is the control-plane saturation signal — a
sustained non-zero depth means reconciles are queuing faster than the operator
drains them. It is exported automatically by controller-runtime for the operator's
named queue; no knext code registers it.

`knext_nextapp_condition{type,status,namespace,name}` is exported by
kube-state-metrics reading `NextApp.status.conditions` — see
[slos.md](./slos.md) "kube-state-metrics".

## Scrape setup (Prometheus Operator)

```bash
kubectl apply -k packages/kn-next-operator/config/prometheus/
```

This installs the operator `ServiceMonitor` and the per-app `PodMonitor`
(`nextapp-metrics`), which selects every knext-generated pod by the
`generated-by: kn-next-operator` label and scrapes port `9091`. Narrow to a
single app by adding `app: <NextApp name>` to the PodMonitor selector.

Plain (non-operator) Prometheus needs no CRs: it honors the
`prometheus.io/scrape` annotations the operator already injects.

## Deferred: core-owned bytecode-cache hit/miss

Issue #315 lists a bytecode-cache hit/miss metric. It already exists as
`kn_next_bytecode_cache_warm_start` (+ the `cache_status` startup-histogram
label), but on the **app-owned** `/api/metrics` registry, not the core `:9091`
bridge — because the cache decision is made in the app's compile-cache scan
(`_metrics/registry.ts`), which knext-core does not own (the runtime supervisor
does not participate in the child's `NODE_COMPILE_CACHE` warm/cold decision).
Moving it onto the core bridge would require a core-owned hook at the compile-
cache decision point; that is tracked as a follow-up rather than duplicated
here.
