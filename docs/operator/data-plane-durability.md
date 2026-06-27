# Data-Plane Durability & DR

> Honest, no-overclaim record of what survives a failure, what is rebuildable, and how to harden
> each store. Pairs with the chaos tests that PROVE the degradation behavior described here
> (`packages/kn-next/src/__tests__/cache-handler-chaos.test.ts`,
> `packages/kn-next/src/__tests__/asset-upload-chaos.test.ts`).

knext's data plane has **two stores with deliberately different durability postures**. Knowing which
is which is the whole point of this doc:

| Store | Holds | Durability posture | On loss |
|---|---|---|---|
| **Redis** | ISR / data cache (`cache-handler.js`) | **Ephemeral, rebuildable** | App serves MISS → origin render; cache refills lazily |
| **Object store (GCS / S3-compatible)** | Static assets (`_next/static/<BUILD_ID>/...`), public files, image-optimization variants | **Durable source of artifacts** | App 404s its own JS/CSS/images — must NOT happen silently |

The reliability contract is asymmetric on purpose:

- The **cache fails OPEN** — a dead Redis degrades to origin render, never an outage.
- The **asset store fails LOUD** — a missing object aborts the *deploy* with a non-zero exit, so a
  broken artifact set never reaches production.

---

## 1. Redis ISR cache — rebuildable-on-loss

### What it stores
ISR page/data cache entries and revalidation tag→key sets. `revalidateTag()` / `revalidatePath()`
delete shared Redis keys, so invalidation is **fleet-wide across all pods already** — no cross-pod
fan-out is needed for correctness within an app.

### Degradation behavior (PROVEN by the chaos test, not just by reading)
When Redis is unreachable, `cache-handler.js`:

- **`get()` → returns `null` (a MISS)**. Next.js re-renders the route from origin. No throw, no hang.
- **`set()` → best-effort, never throws**. The write is attempted; on failure it is swallowed (the
  process falls back to an in-process in-memory `Map` for that pod). A dead cache cannot take a
  request down.
- **`revalidateTag()` → never throws**.
- **No process crash** across a full `get → set → get` cycle under connection-refused.

> The in-memory fallback is per-pod and is a **degraded** mode: during a Redis outage different pods
> may briefly diverge and entries are unbounded-until-restart. This is acceptable because it is
> strictly more available than failing closed, and it self-heals when Redis returns. It is **not** a
> substitute for Redis HA in steady state.

### RPO / RTO

- **RPO (data loss on total Redis loss): full cache flush.** Every cached ISR entry is lost. This is
  *acceptable by design* — the cache is a rebuildable derivative of origin renders, not a system of
  record. No user data lives in Redis.
- **RTO (time to correct serving): immediate.** The app keeps serving the moment Redis is gone
  (MISS → origin). "Recovery" is just the cache refilling lazily on subsequent requests; there is no
  manual rebuild step and no downtime window.
- **Cost of loss:** a latency/CPU spike (cold cache → more origin renders) and, for `minScale: 0`
  apps, more cold starts — **not** an availability incident.

### Persistence / HA recipe (choose one)

knext does **not** run Redis for you in production (the in-cluster `infrastructure.redis` is a
dev/demo convenience). For production pick one:

1. **Managed Redis (recommended)** — Memorystore (GCP), ElastiCache (AWS), Azure Cache, etc. with
   multi-AZ / replica failover enabled. Point `cache.url` at it via a K8s Secret (`REDIS_URL`).
   Survives a node or AZ loss transparently; this is the lowest-ops path.
2. **Self-managed Redis with AOF** — enable append-only persistence so a restart replays recent
   writes instead of starting empty:

   ```
   appendonly yes
   appendfsync everysec      # durability/throughput trade-off; "always" = safest, slowest
   ```

   Add a replica + Sentinel (or Redis Cluster) for AZ-loss survival; a single AOF'd node only
   survives a *restart*, not a node loss. Back the AOF with a PVC on durable (replicated) storage.

> Either way, **losing Redis is a performance event, not a data event** — so even "no persistence at
> all" is a valid (if hot-cache-cold-after-restart) choice for cost-sensitive deployments. Set
> `REDIS_KEY_PREFIX` to the app name so multiple apps don't share a keyspace (the handler warns if
> it is unset while `REDIS_URL` is set).

---

## 2. Object store (GCS / S3-compatible) — the durable tier

### What it stores
The build's static assets under the app-namespaced prefix `<app>/_next/static/<BUILD_ID>/...` plus
public files and (when image optimization ships) cached image variants. Uploads are **additive** —
a new deploy never clobbers a prior build's chunks (skew protection, #93), so in-flight clients on
the old build keep working.

### Degradation behavior (PROVEN by the chaos test)
The asset store is the **artifact source of truth**, so it fails **LOUD at deploy time**:

- After the bulk upload, the deploy **lists the remote prefix and diffs it against the local file
  set**, re-uploads anything missing, and if any object is *still* absent it **throws → the deploy
  exits non-zero**, naming the offending keys.
- If the store is unreachable / empty (total loss), the verification listing is empty → **every key
  is reported missing and the deploy aborts**. Assets are never silently skipped; a half-uploaded
  build cannot go live.

### RPO / RTO

- **RPO:** the durable store is the system of record for serving artifacts; with a multi-region or
  versioned bucket the practical RPO is **zero** (object versioning + cross-region replication).
- **RTO on bucket/region loss:** bounded by **re-running a deploy** (`kn-next deploy`) against a
  healthy bucket — the build output is reproducible from source, and the additive uploader will
  repopulate `<app>/...`. There is no bespoke restore tool; the deploy *is* the restore.
- **What a node/AZ loss does to assets:** nothing — GCS/S3 are regional+ managed object stores with
  their own multi-AZ durability (e.g. GCS 11-nines). knext relies on the provider's durability here
  rather than reimplementing it.

### Hardening recipe

- Enable **object versioning** on the bucket (lets you recover an accidentally-overwritten or
  GC'd object, and underpins safe rollback of `_next/static/<BUILD_ID>/`).
- Use a **regional or multi-region** bucket matching your serving region(s).
- Keep the **asset retention window** (`storage.assetRetention`, default 3) ≥ the number of builds
  that may still be serving traffic, so a rollback/canary's chunks are never GC'd out from under
  live clients.

---

## 3. What survives a node / AZ loss — summary

| Failure | ISR cache (Redis) | Assets (object store) | App availability |
|---|---|---|---|
| Single pod dies | unaffected (shared Redis) | unaffected | Knative reschedules; scale-from-zero if needed |
| Redis node/AZ loss | cache flushed → MISS→origin (degraded perf) | unaffected | **Stays up** (fail-open) |
| Object store region loss | unaffected | re-deploy to a healthy bucket to restore | serving continues from CDN/cache until cache TTL; new deploys blocked until restored |
| Total cluster loss | rebuild on redeploy | durable in provider (regional+) | redeploy to a new cluster; assets already durable |

## 4. Out of scope (honest boundaries)

- **Postgres** zone databases (CloudNativePG) are an **application/zone** concern with their own
  backup/DR (PITR, replicas) — they are the real systems of record and are **not** covered here;
  this doc is about knext's adapter-owned data plane (cache + assets).
- **Kafka ISR revalidation** is deferred/opt-in (the consumer is unbuilt); it carries no durable
  state knext owns. See `kafka-eventing.md`.
- knext does **not** run production Redis or the object store for you — it integrates with managed
  services. Durability of those stores is the provider's responsibility; this doc tells you which
  posture to configure them for.
