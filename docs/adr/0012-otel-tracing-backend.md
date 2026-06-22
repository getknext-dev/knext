# ADR-0012: OTel tracing — default-off gating, env plumbing, and a self-hostable backend

- Status: Accepted
- Date: 2026-06-22
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), #94 (RUM env plumbing — the
  pattern this mirrors), #30 (salvage observability/loadtest from #10), CLAUDE.md §8 (no
  lock-in), `.claude/rules/security.md`.

## Context

The runtime already wired `@vercel/otel` in `apps/file-manager/src/instrumentation.ts`, but
**tracing was unconditionally ON and unconfigurable**: `register()` always called
`registerOTel(...)` regardless of whether a backend existed. That means every cold start paid
the cost of spinning up the OTel SDK / exporter even when no collector was reachable, and there
was no `config → CR → operator → pod` path to turn it on/off or point it at a backend.

PR #10 (the closed vinext-era branch `feat/loadtest-prometheus-grafana-observability`) carried a
zero-config OTel adapter and a k6 load-test harness that never landed on the adapter-based `main`.
#30 salvages the **tracing gating** and the **loadtest harness** onto the official-adapter
approach. Prometheus metrics + RUM (#94) already exist on `main` and are **out of scope** here.

A trace backend must be chosen. knext's positioning (CLAUDE.md §8) is **multi-cloud / no
lock-in**, matching Vercel's compute layer, not its proprietary observability SaaS. So the
exporter must target a **self-hostable** OTLP backend, never a hosted SaaS by default.

## Decision

1. **Tracing is DEFAULT-OFF, env-gated.** A pure helper
   `packages/kn-next/src/adapters/otel-config.ts` exports `resolveOtelOptions(env)` which returns
   `null` unless `OTEL_TRACING_ENABLED === 'true'`. The instrumentation hook returns **without
   initializing OTel** when it gets `null` — zero overhead (no exporter, no span processors) for
   apps that have not opted in. When non-null it returns the resolved service name, OTLP endpoint,
   sample rate, and Knative resource attributes (`K_REVISION`/`K_SERVICE`/`K_CONFIGURATION`/
   `HOSTNAME`), which `instrumentation.ts` maps onto `registerOTel(...)`.

2. **Config → CR → operator plumbing mirrors RUM (#94).** `observability.tracing
   {enabled, endpoint?, sampleRate?}` in `config.ts` → `spec.observability.tracing` in the
   `NextApp` CR (sampleRate emitted as a **string** for OpenAPI validation, same reason as RUM) →
   operator appends `OTEL_TRACING_ENABLED=true` (and `OTEL_EXPORTER_OTLP_ENDPOINT` /
   `OTEL_TRACES_SAMPLER_ARG` when set) to the ksvc pod env. The operator stays the single source of
   truth (ADR-0001); the app reads env only.

3. **Transport = OTLP/gRPC to a cluster-local collector.** The runtime default endpoint is
   `http://otel-collector.monitoring:4317` (in-cluster, no public ingress). `@vercel/otel` already
   honours `OTEL_EXPORTER_OTLP_ENDPOINT`; we pass it through from the CR.

4. **Backend: recommend Grafana Tempo; Jaeger as the alternative.** Both are open-source,
   self-hostable, OTLP-native, and integrate with the existing Prometheus/Grafana stack (Tempo
   shares Grafana; trace→metric exemplars are first-class). **Reject SaaS exporters** (Honeycomb,
   Datadog, Vercel OTel integrations, etc.) as a default — they reintroduce lock-in (CLAUDE.md §8).
   Users may still point `endpoint` at any OTLP backend they run.

## Options considered

| Backend | Self-hostable | OTLP-native | Grafana integration | Verdict |
| --- | --- | --- | --- | --- |
| **Grafana Tempo** | yes | yes | native (same Grafana, exemplars) | **Recommended** |
| Jaeger | yes | yes (OTLP receiver) | via plugin / separate UI | Alternative |
| SaaS (Honeycomb/Datadog/Vercel) | no | yes | n/a | **Rejected — lock-in** |

| Gating approach | Verdict |
| --- | --- |
| Always-on `registerOTel` (status quo) | Rejected — cost with no backend, unconfigurable |
| **`resolveOtelOptions` returns null when disabled** | **Chosen — zero overhead default-off** |

## Consequences

- Apps that do not set `observability.tracing.enabled` pay nothing — the OTel SDK is never
  initialized. Verified by `otel-config.test.ts` (`resolveOtelOptions({})` → `null`).
- Turning tracing on is a one-line config change; the operator handles env propagation.
- The collector + Tempo/Jaeger deployment itself is **not provisioned by this ADR** — knext emits
  OTLP and assumes an in-cluster collector at the default endpoint (or an override). Wiring a
  bundled collector/Tempo manifest is deferred (see action items).
- Sampling is head-based via `OTEL_TRACES_SAMPLER_ARG`; `sampleRate >= 1` → `always_on`, else
  `parentbased_traceidratio`.

## Action items / what is NOT covered here (honest scope)

- **PR-gated by this change:** `resolveOtelOptions` gating, `cr-builder` tracing threading,
  operator CRD round-trip + env propagation. All have tests.
- **Deferred (TODO(#30)):** shipping an in-cluster OTel Collector + Tempo/Jaeger manifest under
  `k8s/`; a Grafana trace dashboard; trace↔metric exemplar wiring. Today knext only *emits* OTLP.
- The **loadtest harness** (k6 script/manifest generators + `kn-next loadtest` + `scripts/load-test.sh`
  + `apps/file-manager/docs/loadtest-runbook.md`) is a **manual/nightly runbook, NOT a PR gate**;
  only the generator output shape is unit-tested.
