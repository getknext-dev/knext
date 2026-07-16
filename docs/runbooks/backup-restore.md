# Runbook — Backup & restore

knext holds three classes of state, and the backup story is different for each.
**Know which one you are protecting before you act:**

| State | System of record? | Backup story | RPO / RTO |
| --- | --- | --- | --- |
| **`scale-zero-pg` (Postgres)** | **Yes** — user data. | Continuous WAL + a **backup CronJob → OCI Object Storage**; full DR is the authoritative pg runbook (below). | RPO = last WAL flushed to the bucket (seconds–minutes of writes may be lost; the pg "honesty rule"). RTO = a function of bucket size (measured ~15–20 min for ~14 GiB). |
| **Redis (ISR / data cache)** | **No** — rebuildable derivative of origin renders. | **No backup needed.** Optionally persist for a warm restart (AOF / managed HA). | RPO = full cache flush is *acceptable by design*. RTO = immediate (MISS → origin, refills lazily). |
| **Object store (static assets)** | **No** — regenerable by re-deploy, but retained for skew protection. | Bucket-level durability/versioning; "restore" = re-deploy re-uploads. | Losing it is a skew/latency event, not user-data loss. |

> **The one thing that actually needs backing up is Postgres.** Redis and the
> object store are rebuildable derivatives (see
> [`../operator/data-plane-durability.md`](../operator/data-plane-durability.md)
> for the full RPO/RTO model). Do not spend RTO budget "restoring" a cache you can
> rebuild for free.

---

## 1. Postgres (`scale-zero-pg`) — the system of record

`scale-zero-pg` is knext's database layer: native Postgres compute on Neon's OSS
storage stack, scaled 0↔1 behind a wake-on-connect gateway. Its durability lives
in the storage plane (safekeeper WAL + pageserver layers offloaded to object
storage), and a **backup CronJob** copies the plane's bucket to **OCI Object
Storage** (e.g. bucket `ks-pg-backup`).

### Backup — verify it is running and healthy

The backup is a scheduled job in the `scale-zero-pg` namespace; there is no manual
step in steady state. Confirm it exists and is succeeding, and that the target
bucket has recent objects:

```sh
# The backup CronJob + its recent runs:
kubectl get cronjob -n scale-zero-pg
kubectl get jobs -n scale-zero-pg --sort-by=.metadata.creationTimestamp | tail

# Sanity-check the OCI backup bucket has fresh content (mc = MinIO client):
#   BK_* are the backup-s3-target Secret's endpoint/access/secret/bucket.
mc alias set bak "$BK_ENDPOINT" "$BK_ACCESS" "$BK_SECRET" --api S3v4 --path on
mc ls "bak/$BK_BUCKET/neon" && mc ls "bak/$BK_BUCKET/neon-config"
```

> **The honesty rule.** A backup is trustworthy only for writes the pageserver had
> already flushed to the bucket (`remote_consistent_lsn ≥ the write's LSN`). A
> restore stands up fresh, empty safekeepers, so the last few seconds–minutes of
> WAL-only writes are **not** recoverable. This is intrinsic to the architecture,
> not a defect — plan RPO around it.

### Restore — follow the authoritative pg DR runbook

Do **not** improvise a Postgres restore. The full, copy-paste, step-numbered
procedure — fresh namespace + secrets, seeding an in-cluster MinIO from the OCI
backup, re-attaching the storage plane at generation+1, read-only vs writable
promotion, cutting the gateway back over, and per-app (branch-per-app) restore —
lives here and is kept current with the plane's real manifests:

➡️ **[`packages/scale-zero-pg/docs/runbook-dr.md`](../../packages/scale-zero-pg/docs/runbook-dr.md)**

Key facts to set expectations before you start it:

- **Two RTO regimes.** A single pageserver pod/node death **self-heals** via
  `pswatcher` failover (~8 s pod death / ~40 s node death) — do **not** invoke the
  DR runbook for that. The DR runbook is only for an actual plane/bucket loss.
- **RTO scales with bucket size** (two cross-internet bucket copies dominate);
  quote it as a function of size, not a fixed number.
- **Read-only restore is the minimum-RTO, always-safe path**; writable promotion
  adds a bounded, size-independent delta (~164 s measured).
- **Multi-tenant note:** apps are Neon branches on one shared plane; the same
  restore mechanism brings every branch back (see the runbook's multi-tenant
  section).

### How the app finds the restored database

knext apps bind Postgres **only** via a K8s Secret (`DATABASE_URL`), referenced
from `NextApp.spec` (ADR-0018/0019 — `secretRef`, no managed-database mode per
ADR-0025). After a restore that keeps the same gateway Service name, the app needs
no change. If the restore lands behind a new host/credentials:

```sh
# Update the Secret the NextApp references, then re-roll the app to pick up new env:
kubectl get nextapp <app> -n <ns> -o jsonpath='{.spec.database}{"\n"}'   # which Secret/key
# edit that Secret, then force a fresh revision so the pod re-reads env:
kn-next deploy        # from the app dir (re-emits the CR)
```

---

## 2. Redis (ISR / data cache) — rebuildable, no backup

The Redis cache backs Incremental Static Regeneration and the data cache
(`cache-handler.js`). It is a **derivative** of origin renders — **no user data
lives in Redis** — so:

- **RPO on total loss = a full cache flush, and that is acceptable by design.**
- **RTO = immediate:** the app keeps serving the instant Redis is gone
  (MISS → origin render) and the cache refills lazily. There is no manual rebuild
  step and no downtime window. A cold cache is a *latency/CPU* event (more origin
  renders, more cold starts for `minScale: 0` apps) — not an availability incident.

So there is nothing to back up. What you can do is make a **restart** warmer:

- **Managed Redis (recommended)** — Memorystore / ElastiCache / Azure Cache with
  multi-AZ replica failover; point `cache.url` at it via the `REDIS_URL` Secret.
  Survives node/AZ loss transparently.
- **Self-managed with AOF** — `appendonly yes` + `appendfsync everysec`, backed by
  a PVC on durable storage, plus a replica + Sentinel for AZ-loss survival.

Full recipes and the fallback-mode caveats:
[`../operator/data-plane-durability.md`](../operator/data-plane-durability.md).

If Redis is *down* (not lost) and firing `KnextCacheUnreachable`, that is an
incident, not a restore — see
[incident.md § Scenario 3](./incident.md#scenario-3-rediscache-down).

---

## 3. Object store (static assets) — durable tier, regenerable

The object store (GCS / S3-compatible) holds each build's static assets under the
app-namespaced, build-id prefix `<app>/_next/static/<BUILD_ID>/...` plus public
files. Two properties make its "backup" story trivial:

- **Uploads are additive and build-id namespaced (ADR-0011).** A new deploy never
  clobbers a prior build's chunks — that is what lets a canary/rollback serve the
  old build's assets (skew protection).
- **It is regenerable.** The assets are a deterministic output of the app build;
  a `kn-next deploy` re-uploads them.

Therefore:

- **Backup = the bucket's own durability + (optionally) object versioning.** Enable
  the provider's versioning/lifecycle so an accidental delete is recoverable.
- **Restore = re-deploy.** If a bucket/prefix is lost, `kn-next deploy` re-uploads
  the current build's assets. Older builds no longer in your CI history are gone,
  but only *in-flight* clients on those exact builds are affected (skew), and they
  refresh on next navigation.
- **Retention is governed, not manual:** the build-id GC (`kn-next gc`, ADR-0011)
  is **fail-safe — it over-keeps, never over-deletes**, and it treats any revision
  named in `status.currentTraffic` as live. Do not hand-delete asset prefixes; let
  the GC reap them.

```sh
# Inspect what a live app has in the object store (assets are under <app>/_next/static/<build-id>/):
mc ls "<store-alias>/<bucket>/<app>/_next/static/"

# Re-upload the current build's assets (the exact path kn-next deploy runs):
kn-next deploy        # from the app dir
```

---

## See also

- **[`packages/scale-zero-pg/docs/runbook-dr.md`](../../packages/scale-zero-pg/docs/runbook-dr.md)** — authoritative Postgres DR (the restore procedure).
- [`../operator/data-plane-durability.md`](../operator/data-plane-durability.md) — RPO/RTO model for cache + object store, Redis HA recipes.
- [incident.md § Scenario 3](./incident.md#scenario-3-rediscache-down) — Redis/cache *down* (vs lost).
- [ADR-0011](../adr/0011-asset-retention-and-build-id-versioning.md) — build-id assets + retention GC.
- [ADR-0019](../adr/0019-database-binding-secretref.md) / [ADR-0025](../adr/0025-remove-managed-database-mode.md) — how apps bind Postgres (`DATABASE_URL` Secret).
