---
"@getknext/core": patch
---

The deep-health alerts (`KnextDeepHealthStuckWaking`, `KnextDeepHealthDown`) can now fire on a default install. The `knext_deep_health_state` gauge was served on a loopback port that the shipped `PodMonitor` does not scrape; the runtime contract now forwards that one family onto the app metrics port (`9464`), and both rules moved into the live `knext.app` group. Nothing else from the app's metric registry is forwarded, and the `NetworkPolicy` grant is unchanged. The gauge still exists only when tracing is enabled (`observability.tracing.enabled`), so with tracing off these two alerts stay silent. Newly scaffolded apps carry the forward; an existing app keeps its own copy of `runtime-contract.mjs` until that file is updated.
