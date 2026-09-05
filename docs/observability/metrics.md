# knext metrics (Prometheus)

Every Prometheus series knext exports for a `NextApp` and its control plane —
name, type, labels, and how to scrape them. The four **golden signals** (rate,
errors, latency, saturation) plus cold-start / DB-wake / bytecode-cache series
come from the runtime; reconcile + work-queue series come from the operator.

Related: [SLOs / SLIs](./slos.md) (the objectives these signals feed) ·
[distributed tracing](./tracing.md) (the `knext.cold_start` / `knext.db_wake`
spans these counters mirror) · [structured logging + correlation IDs](./logging.md)
· [OTel tracing backend](../adr/0012-otel-tracing-backend.md).

## Scrape targets

| Target | Process | Port / path | Series |
| --- | --- | --- | --- |
| **App runtime (default — compiled executable)** | the single-exec entry (`knext-bun-entry.mjs`) | `:9464/metrics` | `knext_bunexec_*`: http_requests_total{status_class} + duration histogram + in-flight + startup_duration + process RSS/uptime — the ONLY series on the shipped scrape path |
| **App runtime (legacy standalone supervisor)** | `node-server.ts` | `:9464/metrics` | golden signals + cold-start + DB-wake (merged from the child) and the Node process metrics — this shape only |
| **Operator** | the controller manager | its `/metrics` (HTTPS `:8443` by default) | reconcile count/duration/errors + `workqueue_depth` + controller-runtime + Go process metrics |

The operator sets `prometheus.io/scrape=true`, `prometheus.io/port=9464`,
`prometheus.io/path=/metrics` on every generated Knative Service, so annotation-
based Prometheus scrapes the app `:9464` with no extra config. For a **Prometheus
Operator** setup (CRD-based discovery, annotations ignored) ship the CRs in
`packages/kn-next-operator/config/prometheus/`: `monitor.yaml` (ServiceMonitor
for the operator) and `app-podmonitor.yaml` (PodMonitor for the per-app `:9464`).

### Why the LEGACY shape's app metrics ride a cross-process bridge

> Everything in this section describes the retired standalone-supervisor shape
> only. The compiled executable is one process: its entry registers the
> `knext_bunexec_*` series directly, no bridge, no child registry.

The golden-signal / cold-start / DB-wake metrics are **derived from core-owned
OpenTelemetry hooks** — the inbound HTTP SERVER span lifecycle, the
`ColdStartSpanProcessor`, and the `instrumentPoolForDbWake` pool wrapper (the
same hooks that emit the tracing spans, [tracing.md](./tracing.md)). There is
**no app route-handler wiring**: knext-core is the runtime supervisor, it does
not own the app's route chain, so per-request signals are read off the OTel
spans, not by wrapping handlers.

Those hooks run in the **Next.js child process**; the operator scrapes the
**supervisor's `:9464`**. So the child serves its core registry (only the
`knext_*` families) on a localhost-only port (`KN_CHILD_METRICS_PORT`, default
9092) and the supervisor's `:9464` handler merges it in (best-effort — a
not-yet-up / scaled-to-zero child just yields the process metrics). The default
process metrics (`process_*`, `nodejs_*`) are seeded **only** on the persistent
supervisor registry, never on the child, so the merged exposition carries each
default family exactly once (no duplicate `# HELP`/`# TYPE` that Prometheus would
reject). Because the metrics ride the OTel spans they share tracing's
**default-off** gate: they appear once `spec.observability.tracing.enabled` (⇒
`OTEL_TRACING_ENABLED=true`) is set on the `NextApp`.

## App runtime series (`:9464`)

**Since ADR-0048 the app scrape is served by the compiled single executable**
(`renderMetrics` in the runtime contract the scaffolder emits), not by the
node-server supervisor. That endpoint is what the shipped `PodMonitor` scrapes,
so the table below is the whole of what a turnkey dashboard or alert can use.

Labels are deliberately **bounded**, and the bound is the design rather than a
default. A scale-to-zero fleet churns pods and every pod is a fresh series set,
so an unbounded label multiplies fleet-wide: the counter carries `status_class`
only (five values, fixed) — never the raw status, and never a route/path label,
which is unbounded by construction (one crawler mints a series per URL). The
duration histogram carries no labels at all: its 13 buckets already multiply it,
and crossing them with `status_class` would make one histogram the dominant term
in the fleet's series count for no SLO that needs it. **Total: 23 series per
pod, constant.**

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `knext_bunexec_http_requests_total` | counter | `status_class` (`1xx`..`5xx`) | request RATE; the `status_class="5xx"` slice is the ERROR rate |
| `knext_bunexec_http_request_duration_seconds` | histogram | — | request LATENCY. Buckets 5ms…10s, five of them under 100ms (a warm SSR hit is tens of ms, so coarser buckets cannot resolve a p50) |
| `knext_bunexec_http_inflight_requests` | gauge | — | SATURATION (concurrently-handled requests) |
| `knext_bunexec_startup_duration_seconds` | gauge | — | COLD START: seconds from process start to both listeners bound. Set once per process; absent until then |
| `knext_bunexec_process_uptime_seconds` | gauge | — | seconds since process start |
| `knext_bunexec_process_resident_memory_bytes` | gauge | — | RSS |

The `app` label every query uses is added by the scrape, not by the runtime: the
`PodMonitor` relabels the pod's `app` label onto each series, and pins
`job="knext-nextapp"` so the staleness meta-alerts can name their own targets.

### NOT on the shipped scrape: app-owned registries

An app may register its own prom-client metrics — `knext_http_*`,
`knext_coldstart_*`, `knext_db_wake_*`, `knext_deep_health_state`
(`@getknext/core/adapters/metrics`), or the `kn_next_*` RED / RUM / bytecode
series in `apps/file-manager/src/app/api/_metrics/registry.ts`. These are real,
but they are served on the **app port** through an `/api/metrics` route. The
node-server supervisor used to merge them onto `:9464`; the compiled binary does
not, and the shipped `PodMonitor` scrapes `:9464` only.

So a query naming one of them is **empty on a default knext deployment** unless
you add a scrape config for your app's `/api/metrics`. That is why the
`knext.app.node-legacy` alert group is kept separate from `knext.app`, and why
the DB-wake panels on the scale-to-zero dashboard say so in their descriptions.

### The contract is gated, because its failure is silent

PromQL over a series nobody emits returns an empty vector: no error, no red — a
blank panel and an alert that never fires. That is exactly how the whole
`knext.app` group went dead when ADR-0048 changed the runtime's metric names.
`packages/kn-next/src/__tests__/observability-metric-contract.test.ts` now
extracts every metric name from every shipped alert and dashboard and resolves
it against an emitter **scanned from that emitter's own source**. Renaming a
series moves the set and reds every query that still names the old one.

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
`generated-by: kn-next-operator` label and scrapes port `9464`. Narrow to a
single app by adding `app: <NextApp name>` to the PodMonitor selector.

Plain (non-operator) Prometheus needs no CRs: it honors the
`prometheus.io/scrape` annotations the operator already injects.

## Closed: core-owned bytecode-cache hit/miss

Issue #315 listed a bytecode-cache hit/miss metric, deferred because the
warm/cold decision lived in the app's `NODE_COMPILE_CACHE` scan rather than in
core. **ADR-0048 closed it by removing the subject, not by building it:** the
compiled single executable has no V8 compile cache to be warm or cold about —
every start is a cold start, and `knext_bunexec_startup_duration_seconds`
measures it directly. The `kn_next_bytecode_cache_*` series and the
`cache_status` label survive only for apps still on the node-server path, on
their own `/api/metrics` registry. The Grafana bytecode dashboard was deleted
rather than repointed (#792): its subject no longer exists, and a blank
dashboard reads as a quiet system.
