---
"@getknext/core": patch
---

`knext create`: the scaffolded `src/instrumentation.ts` now checks the tracing switch (`OTEL_TRACING_ENABLED=true`) before it imports `src/instrumentation-node.ts`. With tracing off, which is the default, the app no longer loads the OpenTelemetry, metrics and client modules at startup, so cold starts are faster. On GKE e2-standard-4 nodes with a 1-CPU limit and pre-pulled images, the median scale-from-zero first request dropped by about 0.9 s on Bun and 0.8 s on Node. With tracing on, the app loads the same modules and registers the same span processors as before. Apps created earlier can copy the change by hand; the observability docs show how.
