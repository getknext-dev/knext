---
"@getknext/core": minor
---

Move the app metrics port default from 9091 to 9464 (#951). On a stock Knative
Serving install (default `config-observability`), the queue-proxy sidecar binds
`:9091` in every revision pod for its own user-metrics server, so an app
defaulting to 9091 lost the port race and crash-looped with `EADDRINUSE`. The
runtime entries' `METRICS_PORT` default, the operator's `prometheus.io/port`
annotation, the default NetworkPolicy's metrics-scrape grants and the shipped
PodMonitor all move to 9464 together (locksteped by
`metrics-port-lockstep.test.ts`), and `kn-next doctor` now detects the
collision condition (queue-proxy user metrics active + an app pinned onto
`METRICS_PORT=9091`) and says how to resolve it. Upgrade order matters as
always (#548): operator/CRD first, then CLI — a new runtime image scraped by an
old operator (or vice versa) scrapes the wrong port until both sides are on the
same release.
