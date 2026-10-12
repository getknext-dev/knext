---
"@getknext/core": patch
"@getknext/lib": patch
---

The deep-health alerts (`KnextDeepHealthStuckWaking`, `KnextDeepHealthDown`) can now fire on a default install, where tracing is off. The `knext_deep_health_state` gauge used to exist only with tracing on, because the module that registers it is not loaded otherwise (loading it costs about 0.9 s of every cold start). A small dependency-free module now serves the same series on the same loopback port the runtime contract already forwards onto the app metrics port: it imports only `node:http` at startup, reads the database-activity slot `@getknext/lib` already writes, and loads the health check on the first scrape that needs it. Newly scaffolded apps start it from `instrumentation.ts`; an existing app keeps its own copy of that file until it is regenerated.

An idle app now serves no deep-health series, with tracing on or off. Previously the gauge kept its last value when the app went idle, so a `waking` or `down` recorded just before idle could keep an alert firing for an app that was simply not in use. The scrape still never wakes an idle scale-to-zero database. The two alerts therefore resolve once the app goes idle and fire again, after their 2-minute hold, if the dependency is still broken when the app is used again.
