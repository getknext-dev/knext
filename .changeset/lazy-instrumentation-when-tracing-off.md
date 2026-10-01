---
"@getknext/core": patch
---

`knext create`: the scaffolded `src/instrumentation.ts` now checks the tracing switch (`OTEL_TRACING_ENABLED=true`) before it imports `src/instrumentation-node.ts`. With tracing off, which is the default, the app no longer loads the OpenTelemetry, metrics and client modules at startup, which removes about 0.8–0.9 s from every cold start in our measurements. With tracing on, the app loads the same modules and registers the same span processors as before. Apps created earlier can copy the change by hand; the observability docs show how.
