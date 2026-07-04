# The knext database layer: scale-to-zero PostgreSQL

knext is **two layers on one cluster**. The **application layer** — this repo — scales your
Next.js apps to zero on Knative and wakes them on an HTTP request. The **database layer** —
[scale-zero-pg](https://github.com/getknext-dev/scale-zero-pg) — does the same for their
PostgreSQL: an idle database consumes **zero compute**, and the first client connection wakes
it. Both layers sleep at zero; both wake on demand. An app and its database can sleep together
and **wake together on a single visitor request**.

This guide explains how the two layers fit, why the database needs its own wake mechanism, and
how you wire an app to a database with exactly one Kubernetes Secret.

> Related reading:
> - [ARCHITECTURE.md — Database layer](../ARCHITECTURE.md#database-layer-scale-zero-pg) — where
>   the database layer sits in the knext system.
> - scale-zero-pg [getting-started](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/getting-started.md)
>   — deploy a sleeping database in ~5 minutes.
> - scale-zero-pg [connecting](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/connecting.md)
>   — the canonical DSN, tier table, pooling rules, and knext integration notes.
> - scale-zero-pg [ADR-0003](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/adr-0003-multi-tenancy.md)
>   — branch-per-app multi-tenancy design and caveats.

## TL;DR

- **One platform, two scale-to-zero layers.** knext (apps, this repo) + scale-zero-pg
  (databases). Same cluster, joined by a single `DATABASE_URL` Secret.
- **Two wake mechanisms by necessity.** Apps wake through Knative's **HTTP** activator;
  databases wake through scale-zero-pg's **TCP** wake-on-connect gateway — because Knative's
  activator is HTTP-only and cannot wake on a raw Postgres connection.
- **The seam is one Secret.** `NextApp.spec.secrets.envMap` maps `DATABASE_URL` to a Secret.
  knext builds **no** database machinery; scale-zero-pg ships alongside as cluster infra.
- **v1.0.0 GA.** Per-app databases (branch-per-app via an `AppDatabase` CRD), read replicas,
  a warm tier, backups/DR, and multi-tenant isolation. Built on [Neon](https://github.com/neondatabase/neon)
  OSS below the wire.

## 1. The unified platform

```
                          ONE KUBERNETES CLUSTER
  ┌───────────────────────────────────────────────────────────────────────┐
  │                                                                         │
  │   APPLICATION LAYER  (knext — this repo)                                │
  │   ┌───────────────────────────────────────────────┐                    │
  │   │ Knative Serving                                │                    │
  │   │   NextApp  →  Knative Service  (replicas 0↔N)  │                    │
  │   │              Next.js standalone server         │                    │
  │   └───────────────────────────────────────────────┘                    │
  │            ▲                              │                             │
  │      HTTP  │ (activator wakes app)        │ DATABASE_URL (one Secret)   │
  │            │                              ▼                             │
  │   visitor ─┘                     ┌──────────────────────────────┐       │
  │                                  │ pg wire (TCP)                 │       │
  │   DATABASE LAYER  (scale-zero-pg)▼                              │       │
  │   ┌───────────────────────────────────────────────┐            │       │
  │   │ GATEWAY (Go, always on) — wake-on-connect      │◀───────────┘       │
  │   │   parse startup ▸ scale compute 0→1 ▸ pipe     │                    │
  │   │   ▸ idle → scale 1→0                            │                    │
  │   │            │                                    │                    │
  │   │            ▼                                    │                    │
  │   │  COMPUTE (Deployment, replicas 0↔1)            │                    │
  │   │  native Postgres 17 — stateless                │                    │
  │   │            │                                    │                    │
  │   │            ▼                                    │                    │
  │   │  STORAGE (StatefulSets, never scale to zero)   │                    │
  │   │  safekeeper · pageserver · object store        │                    │
  │   └───────────────────────────────────────────────┘                    │
  └───────────────────────────────────────────────────────────────────────┘
```

One visitor hits a sleeping app. Knative's activator wakes the app pod (0→1); the app opens
`DATABASE_URL`; scale-zero-pg's gateway wakes the database compute (0→1) and holds the
connection through the cold start. The app's cold start and the database's wake **overlap**, so
the visitor mostly pays only one of them. When traffic stops, both idle back to zero
independently.

## 2. Why two wake mechanisms

knext apps wake via **Knative's HTTP activator** — it buffers an inbound HTTP request while a
scaled-to-zero Knative Service spins a pod up, then forwards it. That is exactly right for a
web app, and exactly wrong for a database: **Knative's activator is HTTP-only.** A Postgres
client speaks the raw Postgres wire protocol over TCP, not HTTP, so the activator cannot see
the connection, cannot buffer it, and cannot trigger a wake.

That is *why the database layer is a separate, purpose-built component* and not "just another
Knative Service." scale-zero-pg ships a small **Go wake-on-connect gateway** that:

1. accepts the raw TCP connection and parses the Postgres startup packet,
2. scales the compute Deployment 0→1 via the Kubernetes API (client-go),
3. holds the client through the ~2.5 s cold start (absorbing Postgres's transient
   "database system is starting up"), replays startup, and pipes bytes,
4. scales the compute back to 0 after an idle window with no connections.

Deliberately **not Knative Serving** for the database — TCP-triggered scaling is the whole
reason the database layer exists as its own component.

## 3. The integration seam: one `DATABASE_URL` Secret

knext binds a database via **a single Secret**, referenced from the `NextApp` CR. knext builds
no connection pooling, no provisioning, no failover — that all lives in the database layer.
Apply the Secret into the app's namespace, then reference it:

```yaml
# 1. the Secret (scale-zero-pg ships deploy/30-knext-secret.yaml as a template)
apiVersion: v1
kind: Secret
metadata:
  name: myapp-database
  namespace: my-app-ns
stringData:
  DATABASE_URL: postgres://cloud_admin:cloud_admin@pggw.scale-zero-pg.svc:55432/postgres?sslmode=require
---
# 2. reference it from the NextApp CR
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: myapp
spec:
  secrets:
    envMap:
      DATABASE_URL:
        secretName: myapp-database
        secretKey: DATABASE_URL
```

The app talks to an ordinary Postgres and never knows the database sleeps. The host is
**always the gateway** (`pggw`), never the compute — the gateway routes, wakes, and holds the
connection during cold start. `sslmode=require` (self-signed, cluster-local infra) or
`sslmode=disable` both work.

**One pooling rule matters** where the two scale-to-zero layers meet: idle pooled connections
look like activity and keep the database awake. Keep your **pool's idle timeout below the
gateway's idle window** (`GW_IDLE_MS`, default 60 s) and `minIdle`/`min_connections` at `0`, or
the database never sleeps. `@knext/lib`'s `getDbPool()` already ships scale-to-zero-sane
defaults (`DB_POOL_MAX=5`, 10 s idle). Full DSN reference, the cold-start client experience,
and the tier table are in scale-zero-pg's
[connecting](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/connecting.md).

## 4. What the database layer provides (v1.0.0)

| Capability | What it gives a knext app |
|---|---|
| **Scale-to-zero Postgres** | Idle → 0 compute; first connection wakes it (**~2.5 s** cold). |
| **Warm tier** (opt-in) | A parked pod for latency-sensitive apps — **~0.4 s** wake, at the cost of 256 MiB reserved 24/7. |
| **Per-app databases** | Branch-per-app: each app gets its **own** scale-to-zero Postgres — a Neon branch on one shared storage plane, provisioned declaratively via an `AppDatabase` CRD + operator. Isolated by both data (separate timeline) and access (per-app credential; the gateway refuses a wrong `(user, database)` pair before waking anything). |
| **Read replicas** | An optional read-only pool via a second DSN (`DATABASE_URL_RO`, port 55434) — reads scale 0→N→0, eventually consistent with a bounded ~9 s staleness ceiling. |
| **Backups / DR** | Rehearsed backup→restore (~110 s RTO) and pageserver failover (~7 s RTO); durability is Neon's WAL quorum, not rebuilt. |
| **Time-series** | `CREATE EXTENSION timescaledb` (Apache-2 tier: hypertables, retention). |

**Per-app databases in practice** — declare one with `kubectl apply`; the operator branches the
shared template, stands up a scale-to-zero compute, and mints a per-app credential Secret whose
`DATABASE_URL` you wire straight into that app's `NextApp.spec.secrets.envMap`:

```sh
kubectl apply -f - <<'EOF'
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata: { name: orders, namespace: scale-zero-pg }
spec:
  appName: orders
  tier: cold                    # cold = scale-to-zero at rest (default)
EOF
kubectl -n scale-zero-pg get secret app-db-orders -o jsonpath='{.data.DATABASE_URL}' | base64 -d
# -> postgres://app_orders:<pw>@pggw-apps.scale-zero-pg.svc:55432/orders?sslmode=disable
```

Design, evidence and caveats: scale-zero-pg
[getting-started](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/getting-started.md)
· [connecting](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/connecting.md)
· [ADR-0003](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/adr-0003-multi-tenancy.md).

## 5. Status & attribution

- **scale-zero-pg is v1.0.0 GA.** Integration with knext is **one Secret** — nothing to build
  on the app side.
- The database layer runs on the cluster **alongside** knext as infrastructure; the two are
  developed as separate repos but positioned as one platform.
- **Built on [Neon](https://github.com/neondatabase/neon) OSS (Apache-2.0)** — reused, not
  forked. Everything durable — WAL quorum, page storage, lazy attach, branching/PITR — is
  Neon's engineering; scale-zero-pg adds the Kubernetes glue: the wake-on-connect gateway,
  the scale-to-zero lifecycle, and the knext integration seam. Object storage is a configurable
  S3 endpoint (managed cloud S3, on-prem, or bundled [MinIO](https://github.com/minio/minio)).
