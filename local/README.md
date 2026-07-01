# local/ — self-hosted Neon storage plane + one native-Postgres compute

A dev-scale copy of the Neon storage stack plus a single native-Postgres compute,
derived from the upstream `neondatabase/neon` `docker-compose/` example and
**simplified for the KS-PG MVP** (1 safekeeper instead of 3, 1 pageserver, 1 compute).
Its whole job is to let us develop the routing plane (gateway + provisioner) against a
real Neon storage backend, and to prove the headline property the MVP depends on:

> **Postgres compute is stateless. Kill it, recreate it from the image, and the data is
> still there — no restore step.** Durability lives in the safekeeper (WAL) and
> pageserver (pages, offloaded to object storage), never in the compute.

## What runs (three planes)

| Service          | Image                         | Role |
|------------------|-------------------------------|------|
| `minio`          | `quay.io/minio/minio:RELEASE.2022-10-20T00-55-09Z` | S3-compatible object storage (pageserver + safekeeper offload) |
| `minio_create_buckets` | `minio/mc`              | one-shot: creates the `neon` bucket, then exits |
| `storage_broker` | `neondatabase/neon:8464`      | pub/sub coordination between safekeeper ↔ pageserver |
| `safekeeper1`    | `neondatabase/neon:8464`      | **durable WAL + single-writer authority** (stateful) |
| `pageserver`     | `neondatabase/neon:8464`      | materializes pages from WAL; offloads to minio (stateful) |
| `compute`        | `ks-pg-compute:8464` (built from `neondatabase/compute-node-v17:8464`) | **native Postgres 17**, stateless, scaled 0↔1 in prod |

**Storage plane = `minio` + `storage_broker` + `safekeeper1` + `pageserver`.** Stateful.
Never put these on Knative and never scale them to zero (see repo invariant #2).
**Compute plane = `compute`.** Stateless; this is what KEDA scales to zero in the cluster.

### Pinned versions (do not use `:latest`)
- Storage + compute images pinned to Neon **release `8464`** (Docker Hub, published 2025-08-26,
  same digest as that day's `latest`). Both `neondatabase/neon:8464` and
  `neondatabase/compute-node-v17:8464` exist and share the tag.
- Postgres **17.5** (`PG_VERSION=17`).

## Ports (host → container)

| Host | Container | Service | Purpose |
|------|-----------|---------|---------|
| `55432` | `compute:55433` | compute | **Postgres** (the gateway will front this) |
| `3080`  | `compute:3080`  | compute | `compute_ctl` HTTP |
| `9898`  | `pageserver:9898` | pageserver | mgmt API — create/list tenant & timeline |
| `7676`  | `safekeeper1:7676` | safekeeper | safekeeper HTTP |
| `50051` | `storage_broker:50051` | broker | broker gRPC |
| `9000`/`9001` | `minio` | minio | S3 API / console (`minio`/`password`) |

Host has **no** `psql`; connect from inside a container:
```sh
docker compose exec compute psql -h localhost -p 55433 -U cloud_admin postgres
```

## Bring up / down

```sh
cd local
docker compose up -d --build     # first run pulls several GB + builds the compute wrapper
docker compose ps                # wait until all services are Up
docker compose logs -f compute   # watch tenant/timeline init + Postgres boot

docker compose down              # stop + remove containers (storage data persists in named/anon volumes)
docker compose down -v           # also wipe volumes → next up starts a brand-new empty tenant
```

## How the tenant / timeline init works

There is **no storage controller** in this compose (it needs a way to reconfigure running
computes, which this minimal setup doesn't provide — upstream omits it too). Instead the
compute container's entrypoint, `compute_wrapper/shell/compute.sh`, bootstraps storage on
startup:

1. Wait for the pageserver's page port (`nc -z pageserver 6400`).
2. `GET http://pageserver:9898/v1/tenant` — if a tenant already exists, **reuse `[0]`**.
   Otherwise generate a random id and `PUT …/location_config` with
   `{mode: AttachedSingle, generation: 1}`.
3. `GET …/{tenant}/timeline` — reuse `[0]` if present, else `POST …/timeline/` with a new id.
4. Substitute `TENANT_ID` / `TIMELINE_ID` into `compute_wrapper/var/db/postgres/configs/config.json`
   (the compute spec) and launch `compute_ctl`, which starts Postgres, connects to the
   safekeeper/pageserver, and lazy-fetches pages on demand.

Because step 2–3 **discover** existing storage via the pageserver API, a fresh compute
container attaches to the same tenant/timeline that earlier computes wrote — that is the
stateless property, and why data survives a compute rm.

You can pin the ids explicitly by setting `TENANT_ID` / `TIMELINE_ID` in the environment
before `up` (the provisioner will do this per-system later); left unset, the script
auto-discovers/creates.

Current tenant/timeline in this running stack:
```
tenant_id:   18d5349d7bc0dc71077c36c9dfb23c39
timeline_id: 799a8635700a9134b9a2fb0448054328
```
(yours will differ if you `down -v` and recreate)

### Single-safekeeper note
`config.json` sets `neon.safekeepers = safekeeper1:5454` and keeps
`synchronous_standby_names = walproposer`; walproposer forms a quorum of 1 over the single
safekeeper. This is the intended MVP simplification — **not** production HA (upstream runs 3).

## Proof: data survives a compute kill (measured)

```
1. CREATE TABLE t(id int); INSERT (1),(2),(3);  → SELECT count(*) = 3
2a. docker compose stop compute && start compute
    → cold start to first query: ~1340 ms (incl. docker-exec poll overhead); count still 3
2b. docker compose rm -sfv compute && up -d compute   # brand-new container, no pgdata
    → cold start to first query: ~949 ms (sub-second); count still 3
    → logs show it re-attached to the SAME tenant 18d5349d… via the pageserver API
```

The `rm -sfv` case is the strong proof: the container's filesystem (and its
`/var/db/postgres/compute` pgdata) is thrown away, a fresh one is created from the image,
and all three rows are still readable — no dump, no restore. **~0.9–1.3s cold start** on this
laptop; the sub-second target in the Definition of Done applies to concurrent KEDA-driven
wakes on-cluster, but this local single wake already lands there.

Reproduce:
```sh
docker compose exec -T compute psql -h localhost -p 55433 -U cloud_admin postgres \
  -c "CREATE TABLE IF NOT EXISTS t(id int);" -c "INSERT INTO t VALUES (1),(2),(3);" -c "SELECT count(*) FROM t;"
docker compose rm -sfv compute && docker compose up -d compute
# poll until ready, then:
docker compose exec -T compute psql -h localhost -p 55433 -U cloud_admin postgres -c "SELECT count(*) FROM t;"
```

## Files in this directory

```
docker-compose.yml                              # the stack (edited: 1 safekeeper, pinned 8464, PG17)
pageserver_config/pageserver.toml               # broker/minio wiring; emergency mode (no controller)
pageserver_config/identity.toml                 # pageserver id
compute_wrapper/Dockerfile                      # adds curl/jq/netcat to compute-node-v17 image
compute_wrapper/shell/compute.sh                # tenant/timeline bootstrap + compute_ctl launch
compute_wrapper/var/db/postgres/configs/config.json  # compute spec (edited: neon.safekeepers = 1 SK)
compute_wrapper/{private,public}-key.pem, public-key.der  # JWKS keys matching config.json compute_ctl_config
```
All of the above are vendored from upstream `neondatabase/neon` `docker-compose/` at release
8464 and kept self-contained here; the only edits are the two noted (safekeeper count).

## TROUBLESHOOTING

- **`docker`/`node` not on PATH** — this environment needs
  `export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:$PATH"` (OrbStack docker shim +
  Homebrew node) before the commands work.
- **`curl`/`wget` are blocked on the host.** For pageserver/safekeeper HTTP calls, exec a
  container that has its own curl, e.g.
  `docker compose exec pageserver curl -s http://localhost:9898/v1/tenant`,
  or use `node -e` with `net`/`fetch`.
- **Compute logs spam `BatchSpanProcessor.ExportError … localhost:4318 Connection refused`.**
  Harmless — `compute_ctl` tries to export OTEL traces to a collector we don't run. Ignore,
  or add an OTLP collector on 4318 if you want traces.
- **Compute won't come up / stuck "Waiting pageserver become ready".** The pageserver page
  port (6400) isn't reachable yet. Check `docker compose logs pageserver` — usually it's
  waiting on `minio_create_buckets` to create the `neon` bucket. `minio_create_buckets` is a
  one-shot that exits 0; that's expected, not a crash.
- **First `up` is slow / looks stuck.** The compute image is large (multi-GB) and the wrapper
  runs `apt-get install curl jq netcat-openbsd` at build time. Poll `docker compose ps`;
  be patient on the first pull+build only.
- **Want a clean slate.** `docker compose down -v` wipes minio + safekeeper/pageserver
  volumes; the next `up` bootstraps a fresh empty tenant (data from before is gone).
- **`psql: command not found` on the host.** Expected — there is no host Postgres client.
  Always go through `docker compose exec compute psql …`.
