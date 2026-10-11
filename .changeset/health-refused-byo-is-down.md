---
"@getknext/lib": patch
---

The deep health check now reports a refused Postgres connection as `down` unless the app's database is the scale-to-zero gateway. Before, every connection-level failure (refused, timed out, DNS) was reported as `waking`, which is only accurate for the scale-zero-pg gateway, so a bring-your-own database that refused connections looked like a wake in progress. `waking` is now reserved for a refused connection to a `*.scale-zero-pg.svc` host, and a refused connection to any other database is `down`. The verdict is immediate with default settings: it does not wait for the connection retry budget (`DB_WAKE_RETRY_BUDGET_MS`, 8 s) to run out, which used to coincide with the deep-check timeout (`HEALTH_DEEP_TIMEOUT_MS`, 8 s) and leave a refused database reading `waking`. Request-path retries are unchanged. Timeouts and dropped connections still read `waking` on any host. Health reporting only; readiness is not affected.
