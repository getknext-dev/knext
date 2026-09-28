---
"@getknext/core": patch
---

`kn-next status` now surfaces an `EnvMapCollision` row (human output) and an
`envMapCollision` key (`--json` output) when a `spec.secrets.envMap` entry
collides with a platform-managed system environment variable (e.g.
`HOSTNAME`, `NODE_ENV`, or a conditionally-injected one like
`STORAGE_PROVIDER`). The row/key mirror the operator's `EnvMapCollision`
status condition: `True` while a collision exists (naming which side won),
`False`/not reported otherwise. The documented connection-string pattern
(binding `REDIS_URL`, `KAFKA_BROKER_URL`, or `OTEL_EXPORTER_OTLP_ENDPOINT`
via `envMap`) renders calmly as informational rather than as an alarm.
