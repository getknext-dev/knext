# Connecting your application

Your app talks to an ordinary Postgres. It never needs to know the database sleeps.

## The DSN

```
postgres://cloud_admin:cloud_admin@pggw.scale-zero-pg.svc:55432/<database>?sslmode=require
```

- **Host is always the gateway** (`pggw`), never the compute. The gateway routes,
  wakes, and holds your connection during cold start.
- **`sslmode=require`** — the gateway now terminates TLS on the Postgres wire itself
  (TLS 1.2+). The connection is encrypted end-to-end to the gateway; no ingress/mesh
  TLS layer is needed. The shipped cert is **self-signed** (cluster-local infra), so
  use `sslmode=require` (encrypt, don't verify the CA) — **not** `verify-full` — until
  you front the gateway with a real CA. See [operations](operations.md#tls-certificate-rotation).
- **`sslmode=disable` still works** — TLS is optional, not enforced. Existing plaintext
  DSNs keep connecting unchanged; enforcing TLS-only is a future flag. If the gateway
  has no cert configured, it declines TLS (answers `N`) and only `sslmode=disable`
  connects.
- **Credentials** — `cloud_admin`/`cloud_admin` is the dev default, enforced by the
  compute spec on every boot. Rotation: see [operations](operations.md#password-rotation).

## What your app experiences

| Situation | Behavior |
|---|---|
| DB awake | Normal Postgres. The gateway is a transparent byte pipe. |
| DB asleep (idle > `GW_IDLE_MS`) | First connection blocks ~2.5s while the compute wakes, then completes normally. No error, no retry needed. |
| DB mid-startup | The gateway absorbs Postgres's transient "database system is starting up" and retries internally — your app never sees it. |
| Wake fails (storage down, image missing) | After `GW_WAKE_TIMEOUT_MS` your app gets a clean Postgres error: `FATAL 57P03 compute unavailable`. |

Set your client's connect timeout ≥ 10s so cold starts never race it.

## Choosing a tier: cold-zero (default) vs warm

Every database picks one of two tiers. **Nothing in your application changes** —
same DSN, same driver, same SQL. The only difference is first-connection latency
after idle, and what it costs while idle.

| | **Cold-zero** (default) | **Warm** (opt-in) |
|---|---|---|
| Wake after idle | ~2.5–3.7 s | **~0.4 s** (p50; bound tested < 1.5 s) |
| RAM/CPU reserved while idle | **0** — no pod exists | **256 MiB + 250 m, 24/7** — one parked pod |
| Scales to true zero? | yes | no (warm-**RAM** tier) |
| Cost model | pay per wake | pay to keep one pod parked |
| What your app sees | first query blocks on the wake | first query blocks ~9× less |

**Default is cold-zero** (ADR-0002): `deploy/25-compute-warm.yaml` ships with
`replicas: 0`, so no warm RAM is reserved unless you opt a workload in. Cold-zero
is the right choice for the overwhelming majority of apps — the wake is absorbed
transparently and costs nothing at rest.

**Choose warm** only for latency-sensitive workloads where a ~2.5 s first-hit
after idle is unacceptable and you accept paying for 256 MiB reserved around the
clock. To enable it:

1. Scale up the warm deployment: `kubectl -n scale-zero-pg scale deploy/compute-warm --replicas=1`.
2. Point it at a gateway running in **warmpool** mode (`GW_COMPUTE_MODE=warmpool`,
   `GW_GATE_PORT=9091`) via `WARM_GATE_ADDR` on the warm deployment.

The warm compute attaches to the **same** timeline as the cold one, so the
gateway enforces the single-writer invariant in-band: it opens the warm pod's
gate **only** after verifying the cold `compute` deployment is fully drained
(0 replicas, 0 pods). Two computes never attach at once. `deploy/_verify-warmtier.sh`
drills this (wake latency, the single-writer refusal, and idle re-park) and is
part of the test battery.

## Scaling reads: `DATABASE_URL_RO` (opt-in read-only pool)

The writer DSN above is a single primary (single-writer is intrinsic to Neon).
To scale **reads** horizontally, KS-PG ships an optional **read-only pool** — a
separate set of read-only computes on the **same** timeline, fronted by a second
gateway port. Your app opts in with a **two-DSN** pattern; there is **no SQL
parsing** and nothing is automatic — you decide which queries are reads.

```
# writes + read-your-writes  (the primary; unchanged)
DATABASE_URL    = postgres://cloud_admin:cloud_admin@pggw.scale-zero-pg.svc:55432/<db>?sslmode=require
# read-only queries          (the pool; port 55434)
DATABASE_URL_RO = postgres://cloud_admin:cloud_admin@pggw.scale-zero-pg.svc:55434/<db>?sslmode=require
```

| | `DATABASE_URL` (writer) | `DATABASE_URL_RO` (read pool) |
|---|---|---|
| Routes to | the single primary compute | the `compute-ro` pool (0→N→0) |
| Writes | yes | **rejected** — `ERROR: cannot execute … in a read-only transaction` |
| Wake | wakes the primary | wakes **only** the pool; the primary stays asleep |
| Scaling | one writer | N replicas, load-balanced by the Service; HPA-driven (deploy/27) |
| Idle | primary sleeps after `GW_IDLE_MS` | pool sleeps after `GW_RO_IDLE_MS` |

**Staleness caveat — read carefully.** The pool is **eventually consistent**
with the primary. The read-only computes boot in one of two modes
(`RO_MODE`, on `deploy/26-compute-ro.yaml`):

- **`Replica` (default, tip-following):** each RO compute streams WAL from the
  safekeepers and tracks the timeline tip with only **replication lag** (typically
  sub-second). A row committed on the writer becomes visible on the pool shortly
  after — but **not** synchronously. Do **not** use `DATABASE_URL_RO` for
  read-your-own-writes right after a commit; use the writer for that.
- **`Static` (honest fallback):** each RO compute is pinned to a **fixed LSN**
  captured when it attached. Reads are frozen at that point; the pool advances
  only when a replica is **re-rolled** (an HPA scale-up naturally brings
  fresh-LSN pods online). Use this only where a bounded, known-stale read is
  acceptable. Which mode you actually get is confirmed by
  `deploy/_verify-readpool.sh` and recorded in
  [BENCHMARKS](BENCHMARKS.md#read-only-pool-issue-66).

**When to use it:** read-heavy workloads (dashboards, analytics, fan-out reads)
that tolerate slight staleness. **When not to:** anything needing
read-your-writes or a strongly-consistent read — point those at `DATABASE_URL`.

Enabling and operating the pool (HPA vs scale-to-zero trade-off included):
[operations](operations.md#read-only-pool-issue-66).

## Connection pooling rules

Pools + scale-to-zero interact in one important way: **idle pooled connections look
like activity** and keep the database awake.

1. **Pool idle timeout < `GW_IDLE_MS`** (gateway default here: 60s). If your pool
   holds idle connections forever, the DB never sleeps — that's the #1 cause of
   "never scales to zero".
2. Keep `min_connections`/`minIdle` at **0** for apps that should let the DB sleep.
3. Size the pool normally otherwise; the gateway doesn't cap connections.

## knext apps

knext binds databases via a Secret only. Apply `deploy/30-knext-secret.yaml` (edit
name/namespace per app), then reference it in the `NextApp` CR. The operator CRD
(`apps.kn-next.dev/v1alpha1`, verified on cluster) takes `envMap` as a **map** of
`ENV_VAR → {secretName, secretKey}`:

```yaml
spec:
  secrets:
    envMap:
      DATABASE_URL:
        secretName: myapp-database
        secretKey: DATABASE_URL
```

`@knext/lib`'s `getDbPool()` reads `DATABASE_URL` and already uses scale-to-zero-sane
defaults (`DB_POOL_MAX=5`, idle timeout **10s**). Sizing rule: `maxScale × DB_POOL_MAX`
bounds the connections that can hit the gateway; keep the pool's idle timeout below
`GW_IDLE_MS`. App and database then sleep and wake together — the app's cold start
(Knative activator) and the DB's wake overlap, so users mostly pay only one of them.

**A full, runnable end-to-end example** — operator install, a `NextApp` that
queries Postgres, and a measured drill proving both wake on one cold request —
lives in [`demo/`](../demo/README.md). Combined-wake numbers:
[BENCHMARKS](BENCHMARKS.md#combined-wake-knext-demo-issue-8).

## Multi-app / branch-per-app

Each app gets its own database — a Neon **branch** (timeline) off a shared
**template**, on one storage plane. N apps, one pageserver + safekeeper quorum,
each with its own compute that sleeps and wakes independently. This is the
DB-per-app product promise; the design, evidence and caveats are in
[ADR-0003](adr-0003-multi-tenancy.md).

**Provision an app** (operator/CI, from `deploy/`):

```sh
# one-time: create the apps tenant + template timeline + base schema
./provision-app.sh init-plane --schema testdata/app-base-schema.sql
# per app: branch the template + stand up a scale-to-zero compute
./provision-app.sh create orders          # replicas 0 (wakes on first connect)
./provision-app.sh list                   # show apps tenant timelines
./provision-app.sh destroy orders --delete-timeline   # tear down (frees the branch pin)
```

Provisioning an app is one pageserver branch call + one rendered per-app compute
(`compute-app.template.yaml`) — **~4s** end-to-end
([BENCHMARKS](BENCHMARKS.md#branch-per-app-provisioning-adr-0003)), no initdb, no
migration replay: the branch inherits the template schema copy-on-write.

**Connect** through the **apps-gateway** (`deploy/81-apps-gateway.yaml`, a second
gateway in `template` mode — the primary single-DB `pggw` is untouched):

```
postgres://cloud_admin:cloud_admin@pggw-apps.scale-zero-pg.svc:55432/<app>?sslmode=disable
```

The DSN **database name is the app handle**: it routes to `compute-<app>` and wakes
it. The gateway rewrites the database to the served DB (`postgres`) before
replaying startup, so every branch serves its inherited schema — you do **not**
create a database named `<app>` yourself. For knext, set each app's
`DATABASE_URL` Secret to its own `/<app>` DSN.

**Isolation is at the timeline level, not the tenant level:** app data is isolated
(proven by `deploy/_verify-multitenant.sh`), but all apps share one pageserver and
safekeeper quorum — a plane-wide stall hits every app. Dropping an app must delete
its timeline (`destroy --delete-timeline`) or the branch pins template history.
Full caveats: [ADR-0003](adr-0003-multi-tenancy.md#consequences--caveats-blast-radius--isolation).

## Time-series data

`CREATE EXTENSION timescaledb;` works out of the box (Apache-2 tier):
hypertables, chunk pruning, and `drop_chunks()` retention. Columnar compression and
continuous aggregates are **not** available on this platform — background policy jobs
can't run on a compute that scales to zero. Details: `adr-0001-timescale-and-sharding.md`.
Big regular tables: `pg_partman` is also preinstalled.
