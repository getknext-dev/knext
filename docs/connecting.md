# Connecting your application

Your app talks to an ordinary Postgres. It never needs to know the database sleeps.

## The DSN

```
postgres://cloud_admin:cloud_admin@pggw.scale-zero-pg.svc:55432/<database>?sslmode=disable
```

- **Host is always the gateway** (`pggw`), never the compute. The gateway routes,
  wakes, and holds your connection during cold start.
- **`sslmode=disable`** — the gateway declines TLS on the Postgres wire; terminate TLS
  in front of it (ingress/mesh) if you need encryption in transit.
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
name/namespace per app), then reference it in the `NextApp` CR:

```yaml
spec:
  secrets:
    envMap:
      - env: DATABASE_URL
        secret: myapp-database
        key: DATABASE_URL
```

`@knext/lib`'s `getDbPool()` reads `DATABASE_URL` and already uses scale-to-zero-sane
defaults (`DB_POOL_MAX=5`, idle timeout). Sizing rule: `maxScale × DB_POOL_MAX`
bounds the connections that can hit the gateway; keep the pool's idle timeout below
`GW_IDLE_MS`. App and database then sleep and wake together — the app's cold start
(Knative activator) and the DB's wake overlap, so users mostly pay only one of them.

## One database per app

Each application/zone gets its own database (its own Neon tenant + timeline). Don't
share a database between apps — that's a platform rule (data sovereignty), and it's
what makes per-app scale-to-zero and future per-app sharding possible.

## Time-series data

`CREATE EXTENSION timescaledb;` works out of the box (Apache-2 tier):
hypertables, chunk pruning, and `drop_chunks()` retention. Columnar compression and
continuous aggregates are **not** available on this platform — background policy jobs
can't run on a compute that scales to zero. Details: `adr-0001-timescale-and-sharding.md`.
Big regular tables: `pg_partman` is also preinstalled.
