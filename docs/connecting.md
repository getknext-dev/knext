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
