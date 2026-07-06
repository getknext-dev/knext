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

**Staleness contract — this is a guarantee, not a surprise.** The pool is
**eventually consistent** with the primary. Treat the following as a contract you
can design against:

> **Contract (`RO_MODE=Replica`, the default):** a row committed on the writer
> becomes visible on `DATABASE_URL_RO` within a **bounded staleness ceiling of
> ~9 s**, and usually much faster (true streaming-replication lag is typically
> sub-second; the ~9 s ceiling is the worst case measured end-to-end by
> `deploy/_verify-readpool.sh`, poll-granularity inflated). Visibility is
> **never synchronous** and there is **no read-your-writes guarantee** on the RO
> DSN. If you commit on `DATABASE_URL` and must read that exact write back
> immediately, read it from `DATABASE_URL` — not the pool.

The read-only computes boot in one of two modes (`RO_MODE`, on
`deploy/26-compute-ro.yaml`):

- **`Replica` (default, tip-following):** each RO compute streams WAL from the
  safekeepers and tracks the timeline tip, honoring the ~9 s ceiling above. This
  holds **under read load too** — `deploy/_verify-readpool.sh` (HPA section)
  re-measures the catch-up while the pool is saturated and the HPA has scaled it
  to N>1 (see [BENCHMARKS](BENCHMARKS.md#read-only-pool-under-load-hpa-n1-issue-99)).
- **`Static` (honest fallback):** each RO compute is pinned to a **fixed LSN**
  captured when it attached. Reads are frozen at that point; the pool advances
  only when a replica is **re-rolled** (an HPA scale-up naturally brings
  fresh-LSN pods online). Use this only where a bounded, known-stale read is
  acceptable. Which mode you actually get is confirmed by
  `deploy/_verify-readpool.sh` and recorded in
  [BENCHMARKS](BENCHMARKS.md#read-only-pool-issue-66).

**When to use it:** read-heavy workloads (dashboards, analytics, fan-out reads)
that tolerate the ~9 s staleness ceiling. **When not to:** anything needing
read-your-writes or a strongly-consistent read — point those at `DATABASE_URL`.

Enabling and operating the pool (HPA vs scale-to-zero trade-off, and the GA
n>1-under-load drill) is in
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
./provision-app.sh destroy orders         # tear down — reclaims the timeline BY DEFAULT (no orphan, #91)
#   destroy orders --keep-timeline        # explicit opt-out: retain the branch for PITR (prints reclaim cmd)
```

Provisioning an app is one pageserver branch call + one rendered per-app compute
(`compute-app.template.yaml`) — **~4s** end-to-end
([BENCHMARKS](BENCHMARKS.md#branch-per-app-provisioning-adr-0003)), no initdb, no
migration replay: the branch inherits the template schema copy-on-write. `create`
also mints a **per-app credential** (role `app_<app>` + a random password) into a
Secret `app-db-<app>` — this is the app's DSN. Re-running `create` is idempotent
and crash-safe (the timeline id is persisted before the branch call, so an
interrupted create leaves no orphan; `./provision-app.sh fsck` surfaces any).

**Each app has its own credential (issue #74).** The DSN user is the per-app role
`app_<app>`, and the apps-gateway **refuses** any startup whose `(user, database)`
is not `app_<app>/<app>` — *before* it wakes anything. So knowing one app's DSN
does not grant access to another, and `cloud_admin` does **not** work through the
apps-gateway (admin is direct-to-compute only). Read the DSN from the Secret:

```sh
kubectl -n scale-zero-pg get secret app-db-<app> -o jsonpath='{.data.DATABASE_URL}' | base64 -d
# postgres://app_<app>:<per-app-password>@pggw-apps.scale-zero-pg.svc:55432/<app>?sslmode=disable
```

**No tenant-existence oracle (issue #92).** Every refusal on the apps-gateway —
a wrong `(user,database)` pair, a reserved name (`tmpl`/`warm`/`ro`), a malformed
name, **and** a syntactically-valid pair for an app that does **not exist** — is
collapsed to the byte-identical error `FATAL: password authentication failed for
user "<user>"` (SQLSTATE `28P01`, the same message Postgres itself gives for a bad
password). The gateway never returns "deployment not found" or any internal k8s
object name, so an unauthenticated client on the open front door cannot enumerate
which apps exist. The real cause is logged **server-side only**. A constant-floor
delay (`GW_AUTH_FAIL_FLOOR_MS`, default 250 ms) equalises the latency of the
gateway-side refusals so timing does not separate "unknown app" from "wrong pair".
*Honest limit:* this closes the message-content oracle and the fast-fail timing
gap; it does **not** mask the multi-second cold-**wake** latency a real app incurs
on a wrong password (that path wakes the compute first) — closing that fully would
mean delaying every refusal by a full wake, a DoS lever we deliberately avoid.

The DSN **database name is the app handle**: it routes to `compute-<app>` and wakes
it. The gateway rewrites the database to the served DB (`postgres`) before
replaying startup, so every branch serves its inherited schema — you do **not**
create a database named `<app>` yourself. For **knext**, wire each app's
`DATABASE_URL` Secret (`NextApp.spec.secrets.envMap`) straight from `app-db-<app>`
(same shape as the primary contract) — one Secret per app, isolated by credential.

**Per-app read DSN (`DATABASE_URL_RO`).** When an app requests the read-replica
pool (`AppDatabase.spec.roPool.enabled`, which knext maps from
`NextApp.spec.database.readReplicas`), the AppDatabase operator also emits a
`DATABASE_URL_RO` key into `app-db-<app>` — the same per-app role/password/host/
database as the writer, on the gateway **RO port** (`55434`):

```sh
kubectl -n scale-zero-pg get secret app-db-<app> -o jsonpath='{.data.DATABASE_URL_RO}' | base64 -d
# postgres://app_<app>:<per-app-password>@pggw-apps.scale-zero-pg.svc:55434/<app>?sslmode=disable
```

✅ **The per-app RO serving endpoint is LIVE (issue #127).** `DATABASE_URL_RO` on
`app-db-<app>` is a real, tenant-isolated read endpoint: the apps-gateway runs a
second listener on `55434` in **template mode**, so `database=<app>` reads route to
**that app's own** read-only compute (`compute-ro-<app>`, attached to the app's own
timeline), scaled `0↔N` on connect. It is **not** the primary `compute-ro` pool on
`pggw:55434` (that is the single-DB path). App A's reads can never reach app B's RO
compute (or the primary pool): the RO port enforces the identical `(user,database)`
authz as the writer port, and each app resolves to a distinct `compute-ro-<app>`.
Point per-app reads at `DATABASE_URL_RO` and writes at `DATABASE_URL`. Isolation +
staleness are proven by `deploy/_verify-perapp-ro.sh` (A reads A, never B, both
ways; writes rejected on RO). See
[AppDatabase API reference](appdatabase-api.md#3-output-secret-contract).

**Isolation is at two layers.** *Data* isolation is the Neon timeline (each app is
a separate branch — app A's rows are invisible to app B, proven by
`deploy/_verify-multitenant.sh`). *Access* isolation is the per-app credential +
the gateway `(user,database)` refusal (proven by the same drill: app A's DSN is
denied against app B, and `cloud_admin` is denied through the gateway). What is
**shared** is availability: all apps ride one pageserver + safekeeper quorum, so a
plane-wide stall hits every app. Dropping an app reclaims its timeline **by default**
(`destroy <app>`, #91) so a routine teardown never pins template history or leaks
safekeeper WAL; `--keep-timeline` retains it deliberately (and tells you how to
reclaim later). Full caveats:
[ADR-0003](adr-0003-multi-tenancy.md#consequences--caveats-blast-radius--isolation).

### Rotating an app credential (issue #93b)

The per-app password can be rotated without changing the DSN **shape** — the role
(`app_<app>`), host, database, and `sslmode` are all unchanged; only the password
**value** rotates. The operator runs:

```sh
deploy/provision-app.sh rotate-cred <app>            # new password into Secret app-db-<app>
deploy/provision-app.sh rotate-cred <app> --bounce   # + apply it to the running compute now
```

Because your app reads `DATABASE_URL` from the Secret **at pod start**, a rotation
only reaches the app when its pods restart: after a rotate, **roll your consumer
Deployment** so it picks up the new `DATABASE_URL`. A compute that was scaled to
zero applies the new password automatically on its next wake; a running compute
keeps the old password until it is bounced (`--bounce`, a single-writer-safe
`Recreate`). Operator runbook: [operations](operations.md#rotating-an-app-credential-issue-93b).

## Time-series data

`CREATE EXTENSION timescaledb;` works out of the box (Apache-2 tier):
hypertables, chunk pruning, and `drop_chunks()` retention. Columnar compression and
continuous aggregates are **not** available on this platform — background policy jobs
can't run on a compute that scales to zero. Details: `adr-0001-timescale-and-sharding.md`.
Big regular tables: `pg_partman` is also preinstalled.
