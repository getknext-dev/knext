# Postgres under scale-to-zero — the CloudNativePG `Pooler` recipe

> **Scope honesty (read first).** This is a **cluster-infrastructure recipe**, not a knext
> feature. **knext does NOT provision Postgres or the connection pooler** — the cluster does
> (CloudNativePG, or a managed/serverless provider). knext's only job is to **bind the zone's
> `DATABASE_URL`** from a Kubernetes Secret into the app (`spec.secrets.envMap`) and to bound
> instance fan-out with the scaling knobs. Everything below tells you what to run *alongside*
> knext so a scale-to-zero zone does not storm Postgres with connections.
>
> Two distinct API groups appear here — keep them straight:
> - `postgresql.cnpg.io/v1` — CloudNativePG's `Cluster` and `Pooler` (the database + the pooler).
> - `apps.kn-next.dev/v1alpha1` — knext's `NextApp` (the zone's app).

Related reading:
- **[Per-zone Scaling & Cold-start Tuning](./scaling-cold-start.md)** — the scaling knobs
  (`minScale`/`maxScale`/`containerConcurrency`) and the cold-start mitigations. This doc is the
  deep-dive on the database half of that page's connection-storm note.
- **[`.claude/rules/scs-zones.md`](../../.claude/rules/scs-zones.md)** — the data-sovereignty
  contract: a zone owns its own store, reaches it via `DATABASE_URL` from a Secret, and never
  connects to another zone's database.
- The app-side pool half — see [App-side settings](#4-app-side-settings) below — is the companion
  work in **PGS-1 (#133)**, in review and not yet merged.

---

## 1. The problem

A scale-to-zero zone runs **0..N** Next.js instances depending on traffic. Each instance opens its
own `pg.Pool` to Postgres. Postgres, by contrast, has a hard `max_connections` ceiling (often
~100–200), and **every** backend connection costs real memory on the primary. The danger is a
**connection storm**: a traffic spike scales the zone wide, every new instance opens a full pool,
and the primary exhausts `max_connections` — at which point *all* zones sharing that cluster start
getting `FATAL: sorry, too many clients already`.

The bounding rule:

```
peak_backend_conns ≈ maxScale × app_pool_max
```

where `app_pool_max` is the per-instance `pg.Pool` max. With PGS-1's bounded pool (default
`DB_POOL_MAX=5`, see §4 — companion work, in review) and the operator's default `maxScale: 10`, a
single zone can demand up to **50** backend connections — and that is *one* zone. Several zones on
one cluster overrun Postgres quickly.

**Co-tenant caveat:** a pooler caps *one* zone's backend connections, but every zone's pooler still
lands on the *same* shared Postgres. Size for the sum across all co-tenant zones:
`Σ(default_pool_size across all zones' poolers) + reserved < cluster max_connections`.

You bound `peak_backend_conns` from **two** sides, and you should use both:

1. **Cap instance count** with `spec.scaling.maxScale`, and admit more requests *per* instance with
   `spec.scaling.containerConcurrency` (fewer, busier instances instead of many thin ones).
2. **Put a transaction-mode connection pooler in front of Postgres.** A pooler decouples the
   *client* connection count (one per app pool slot) from the *backend* connection count (a small,
   fixed `default_pool_size`). This is the robust fix when you cannot keep `maxScale` low —
   `peak_backend_conns` is then capped by the pooler regardless of how wide the zone scales.

The recommended default below is the CloudNativePG-native `Pooler` (PgBouncer in transaction mode).

---

## 2. Recommended default — the CloudNativePG `Pooler` (PgBouncer)

CloudNativePG ships a first-class `Pooler` CRD that runs **PgBouncer** in front of a `Cluster` and
exposes a Service on port `5432`. You point the zone's `DATABASE_URL` at the **pooler Service**
instead of the cluster's `-rw` primary Service, and the pooler holds a small, fixed pool of real
backend connections to the primary.

### The `Pooler` manifest (transaction mode)

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: shop-zone-rw-pooler
  namespace: shop-zone
spec:
  # Immutable: which CNPG Cluster this pooler fronts. To repoint it at a
  # different cluster you must DELETE and re-create the Pooler.
  cluster:
    name: shop-zone-db
  # rw => routes to the cluster primary (read-write). Use `ro` for a read pooler (§6).
  type: rw
  instances: 2          # PgBouncer replicas (HA); not the backend pool size
  pgbouncer:
    poolMode: transaction          # see the caveat in §3 before choosing this
    parameters:
      # Client connections PgBouncer will accept (app instances × app_pool_max headroom)
      max_client_conn: "200"
      # REAL backend connections PgBouncer opens to the primary, per (user,db) pair.
      # This is the number that actually lands on Postgres — keep it well under
      # the cluster's max_connections.
      default_pool_size: "20"
```

This deploys PgBouncer pods and a Service named after the `Pooler` (`shop-zone-rw-pooler` in the
namespace above), listening on `5432`.

**Requirements & operability:**

- **PgBouncer ≥ 1.19** — the CNPG `Pooler` relies on PgBouncer's `auth_dbname` support.
- **Metrics:** the `Pooler` exposes Prometheus metrics with the `cnpg_pgbouncer_*` prefix
  (pool saturation, client/server connection counts, wait times). Scrape these to see when
  `default_pool_size` is the bottleneck.
- `default_pool_size` — **not** `instances` — is what caps real backend connections. `instances`
  is just PgBouncer HA replicas; raising it does **not** raise the backend pool.

### Binding `DATABASE_URL` to the pooler (not the primary)

The zone's `DATABASE_URL` lives in a Kubernetes Secret. Point its **host** at the pooler Service,
then bind it into the `NextApp` with `spec.secrets.envMap`:

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: shop-zone
  namespace: shop-zone
spec:
  image: registry.example.com/shop-zone@sha256:<digest>   # digest-pinned; never :latest
  scaling:
    maxScale: 3                # cap fan-out (write zone — see §6)
    containerConcurrency: 200  # fewer, busier instances
  secrets:
    envMap:
      DATABASE_URL:
        # Secret whose value's host points at the POOLER Service
        # (shop-zone-rw-pooler.shop-zone:5432), NOT shop-zone-db-rw.
        secretName: shop-zone-db-app
        secretKey: pooler-url
```

The Secret value looks like
`postgresql://app:<pw>@shop-zone-rw-pooler.shop-zone:5432/app` — host = the pooler, not the
`shop-zone-db-rw` primary. knext binds the Secret; it does not create it or the pooler.

---

## 3. The transaction-mode caveat (must read)

Transaction pooling is what makes the pooler effective at scale-to-zero (a backend connection is
returned to the pool at the end of *every transaction*, not held for the whole client session). But
because no client owns a stable server session, **anything that relies on session state breaks**:

- **`SET` / `RESET`** — session-level `SET` (e.g. `SET search_path`, `SET timezone`, `SET role`)
  does not persist across transactions. Use per-transaction `SET LOCAL`, or set defaults on the
  role/database instead.
- **`LISTEN` / `NOTIFY`** — the listening session is not kept; pub/sub over `LISTEN` does not work.
- **SQL-level `PREPARE` / `DEALLOCATE`** — named prepared statements created via the `PREPARE`
  statement are not visible on a later transaction's (possibly different) backend.
- **Session-level advisory locks** — `pg_advisory_lock()` is tied to the session and won't be held.
  Use transaction-scoped `pg_advisory_xact_lock()` instead.
- **`WITH HOLD` cursors** — cursors declared to survive past their transaction won't.

**Protocol-level prepared statements are the important exception.** PgBouncer **≥ 1.21** supports
protocol-level (extended-query) prepared statements in transaction mode **when you set
`max_prepared_statements`** (e.g. `pgbouncer.parameters.max_prepared_statements: "100"`). This is
the kind of prepared statement most drivers and ORMs use under the hood.

**What this means for ORMs / drivers** — Payload v3, Prisma, and Drizzle all lean on prepared
statements:

- **Preferred:** run **PgBouncer ≥ 1.21** and set `max_prepared_statements` so protocol-level
  prepared statements work transparently.
- **Otherwise:** disable client-side statement caching so the driver stops issuing named prepared
  statements:
  - **Prisma** — append `?pgbouncer=true` to the `DATABASE_URL` (disables prepared statements).
  - **Drizzle / `postgres.js`** — construct the client with `prepare: false`.
  - **node-postgres (`pg`)** — avoid the named-statement (`name:`) query form.

Pick **session** pooling (`poolMode: session`) only if you genuinely need full session semantics —
but session mode pins one backend connection per client for the whole session, which **defeats the
scale-to-zero connection-storm protection**. Transaction mode is the right default here.

---

## 4. App-side settings

The pooler caps the *backend* side; the app must also bound the *client* side and release
connections cleanly when an instance scales to zero. This app-side half is the companion work in
**PGS-1 (#133)** — in review, **not yet merged**. (On `main` today, `getDbPool()` in
`packages/lib/src/clients.ts` is still an unbounded `new Pool({ connectionString })` with no
SIGTERM drain.) PGS-1 provides, in `getDbPool()`:

- **A bounded per-instance pool** — a bounded `max` (default **5**, override with the `DB_POOL_MAX`
  env var); this is the `app_pool_max` in the bounding rule. Keep it small: with a transaction
  pooler in front, the app only needs a handful of client connections per instance.
- **A SIGTERM drain** — on `SIGTERM` (Knative scale-down / revision rollout) the pool is drained so
  the instance closes its connections instead of leaking them until timeout, keeping
  `peak_backend_conns` honest as instances churn.

Even with a pooler, keep `DB_POOL_MAX` small: `max_client_conn` on the pooler must comfortably
exceed `maxScale × DB_POOL_MAX` or instances will queue waiting for a pooler client slot.

---

## 5. Option — serverless Postgres (the database also scales to zero)

If you want the **database** to scale to zero too (not just the zone), use a serverless Postgres
provider. You adopt it by pointing `DATABASE_URL` at the provider — **zero knext code change**, same
`spec.secrets.envMap` binding as §2.

**Neon.**
- Compute **suspends after idle** (~5 min default) and **resumes in a few hundred milliseconds** on
  the next connection — a natural fit for scale-to-zero zones.
- Ships a **built-in PgBouncer pooler**: use the **`-pooler`** endpoint host in `DATABASE_URL` (so
  the §3 transaction-mode caveats apply there too).
- Offers an **HTTP / WebSocket serverless driver** for a connection-per-request model that avoids
  holding a TCP pool at all — useful from edge/serverless runtimes.

**Aurora Serverless v2** (AWS) is an equivalent managed option (autoscaling ACUs; does not fully
suspend to zero the way Neon does, but scales capacity down under low load).

### Readiness/liveness MUST stay shallow when the DB scales to zero (ADR-0026)

When the database itself scales to zero (the scale-zero-pg `compute-<app>`, Neon
suspend, etc.), it legitimately sleeps and takes ~2–6s to wake on the next
connection. **Do not let readiness/liveness deep-check the DB** — an asleep DB is
normal, and a deep probe would fail during the wake window, flap readiness, and
compound cold-start latency under load (Knative won't route to a not-Ready pod,
so the wake never completes).

The operator generates SHALLOW readiness + liveness probes at `spec.healthCheckPath`
(default `/api/health`), served by `checkShallowHealth()` — process-only, no DB
dial. Deep DB/Redis reachability is exposed separately at `/api/health/deep`
(`checkDeepHealth()`) for monitoring/alerting only and is **never** wired to a
probe. The deep check is wake-aware (a connection-refused/timeout on a
scale-to-zero DB reports `waking`, not `down`) with a configurable
`HEALTH_DEEP_TIMEOUT_MS` (default 8s, aligned with the wake budget).

Operator-generated probe config (both readiness and liveness → the shallow path):

```yaml
readinessProbe:
  httpGet: { path: /api/health, port: 3000 }   # shallow — no DB dial
  initialDelaySeconds: 2
  periodSeconds: 3
livenessProbe:
  httpGet: { path: /api/health, port: 3000 }   # shallow — no DB dial
  initialDelaySeconds: 5
  periodSeconds: 10
```

Point Prometheus/alerting at `/api/health/deep`, not at the probe path.

**Deep health as a scrapable metric (activity-gated, #348).** The deep verdict
is also exported on the runtime `:9091` registry as
`knext_deep_health_state{app,dependency,state}` (active state=1, others=0), which
the `KnextDeepHealthStuckWaking` alert keys on to page when a permanent
connection-level DB outage sits at `waking` past the wake budget (a case
`down`/503 alerts miss). Critically, this gauge is refreshed **only when the app
used its writer pool recently** (`DB_ACTIVITY_BUDGET_MS`, default 45s — below
the 60s gateway idle window). That activity-gate is what keeps observability
from breaking scale-to-zero: an unconditional deep probe on every ~30s scrape
would issue a `SELECT 1` that re-arms the gateway idle timer and keep an idle
app's DB permanently awake. An **idle** app is never probed by the scrape, so
its DB sleeps; a genuinely-**in-use** DB stuck `waking` still pages.

**Flags — read before adopting:**
- **Lock-in / not the default.** These are **managed, provider-hosted** options. knext's default
  and the SCS data-sovereignty contract assume an **in-cluster CloudNativePG** database; a managed
  serverless DB moves the data store outside the cluster and ties the zone to a vendor. Treat it as
  a deliberate trade, not the recommended path.
- **Neon self-hosting is unsupported for production.** Neon's core is open source (Apache-2.0), but
  the project documents self-hosting as **experimental / not supported for production use**. So Neon
  is viable as a **managed** option only — it is *not* a self-host replacement for CloudNativePG.

---

## 6. Worked example — write-heavy vs read-heavy zones

### Write-heavy zone — low `maxScale`, higher `containerConcurrency`, an `rw` pooler

A zone dominated by writes must go through the primary. Cap fan-out hard and let each instance do
more work; front the primary with a **`type: rw`** transaction pooler.

```yaml
# postgresql.cnpg.io/v1 — the rw pooler in front of the primary
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata: { name: shop-zone-rw-pooler, namespace: shop-zone }
spec:
  cluster: { name: shop-zone-db }
  type: rw
  instances: 2
  pgbouncer:
    poolMode: transaction
    parameters: { max_client_conn: "100", default_pool_size: "15", max_prepared_statements: "100" }
---
# apps.kn-next.dev/v1alpha1 — the zone, capped low
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata: { name: shop-zone, namespace: shop-zone }
spec:
  image: registry.example.com/shop-zone@sha256:<digest>
  scaling:
    maxScale: 3                 # low ceiling => bounded primary connections
    containerConcurrency: 200   # fewer, busier instances
  secrets:
    envMap:
      DATABASE_URL: { secretName: shop-zone-db-app, secretKey: pooler-rw-url }
```

`peak_backend_conns` here is capped by the pooler's `default_pool_size: 15` against the primary,
independent of how the zone scales — and `maxScale: 3 × DB_POOL_MAX 5 = 15` client connections fits
comfortably under `max_client_conn: 100`.

### Read-heavy zone — a CNPG read replica + an `ro` pooler

A zone dominated by reads can offload to a replica. Run a **`type: ro`** pooler (CNPG routes `ro` to
the cluster's read-only replica service) and let the zone scale wider, since reads don't contend on
the primary.

```yaml
# postgresql.cnpg.io/v1 — read pooler over the replica(s)
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata: { name: catalog-zone-ro-pooler, namespace: catalog-zone }
spec:
  cluster: { name: catalog-zone-db }   # this Cluster must declare instances > 1 (a replica exists)
  type: ro                              # routes to the read-only (replica) service
  instances: 2
  pgbouncer:
    poolMode: transaction
    parameters: { max_client_conn: "300", default_pool_size: "30", max_prepared_statements: "100" }
---
# apps.kn-next.dev/v1alpha1 — wider fan-out is fine for reads
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata: { name: catalog-zone, namespace: catalog-zone }
spec:
  image: registry.example.com/catalog-zone@sha256:<digest>
  scaling:
    maxScale: 10                # operator default; wide read fan-out is safe behind the ro pooler
    containerConcurrency: 100
  secrets:
    envMap:
      DATABASE_URL: { secretName: catalog-zone-db-app, secretKey: pooler-ro-url }
```

The read replica is provisioned by the CNPG `Cluster` (set `spec.instances > 1`), **not** by knext.

---

## 7. Recap — who owns what

| Concern | Owner | knext's role |
| --- | --- | --- |
| The Postgres `Cluster` / replicas | CloudNativePG (`postgresql.cnpg.io/v1`) | none — operated outside knext |
| The `Pooler` (PgBouncer) | CloudNativePG (`postgresql.cnpg.io/v1`) | none — operated outside knext |
| `DATABASE_URL` Secret value (→ pooler host) | cluster admin | **binds it** via `spec.secrets.envMap` |
| Instance fan-out (`maxScale`/`containerConcurrency`) | knext | reconciled by the operator |
| App-side pool `max` + SIGTERM drain | knext (`getDbPool`) | companion work in **PGS-1 (#133)**, in review — not yet merged |

knext binds the secret and writes this recipe. The cluster runs the database and the pooler.
