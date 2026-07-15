# compute spec (config.json) — the WHYs that JSON can't hold

`config.json` is the compute_ctl spec: `compute_ctl` re-applies `cluster.roles`
and `cluster.settings` on **every** boot (so `ALTER SYSTEM`/`ALTER USER` do not
survive a restart — change them here).

Non-obvious settings, with rationale:

- **`fsync=off` is safe HERE and only here.** Durability does not live in this
  pod: every commit is WAL-shipped to the safekeeper quorum and is durable on
  2/3 ack (see `docs/operations.md` "Durability model"). Local fsync would only
  protect a disk that is wiped on every pod restart anyway. Turning it ON buys
  nothing and slows the WAL path. On any NON-Neon Postgres this setting would
  be a data-loss bug — do not copy it elsewhere.
- **`restart_after_crash=off`** — compute_ctl owns the lifecycle; Kubernetes
  restarts the pod, which re-attaches to storage. In-place PG restart would
  race the single-writer attach.
- **`shared_buffers=256MB`** (~25% of the pod's 1Gi limit). The rest of the
  working set is served by Neon's local file cache + pageserver. The old value
  (1MB) came from Neon's compose *test* fixture and made every read a
  pageserver round-trip.
- **`max_connections=100`** — deliberate ceiling: 100 × `work_mem 8MB` worst
  case + 256MB buffers fits the 1Gi limit. knext sizing rule: apps' total pool
  (`maxScale × DB_POOL_MAX`) must stay under this; put a pooler in front before
  raising it.
- **`password_encryption=md5`** + `roles[].encrypted_password` — the hash is
  md5(password + username). Rotation procedure: `docs/operations.md`.
- **`neon.safekeepers` / `TENANT_ID` / `TIMELINE_ID`** — the storage plane
  wiring; TENANT/TIMELINE placeholders are sed-substituted by `entrypoint.sh`
  from the `compute-config` ConfigMap (created with fixed IDs by
  `55-storage-init.yaml`).
- **`cluster_id`/`name` = `ks-pg`** — was `docker_compose_test` (inherited from
  the fixture; renamed for honesty, no functional effect).
