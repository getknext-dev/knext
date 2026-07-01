# scale-zero-pg

**Scale-to-zero PostgreSQL on Kubernetes** — a database that consumes zero compute while idle
and wakes on the first client connection. Native Postgres on Neon's open-source storage stack
(Apache-2.0); the only custom piece is a small Go gateway. Built to pair with
[knext](../..//alpheya/pocs/knext) (scale-to-zero Next.js on Knative): app and database both
sleep at zero and wake on demand.

> Proven on a local cluster: cold connect → compute wakes 0→1 and serves data (**5.2s** wake,
> **1–2s** when the pod is merely recreated), 60s idle → back to **0**, reconnect re-wakes —
> data always intact. See *Verification*.

## How it works

```
client ──pg wire──▶ GATEWAY (Go, always on, stateless)
                      │  parse startup ▸ compute asleep? ▸ scale 0→1 (client-go)
                      │  ▸ hold ▸ replay ▸ pipe bytes ▸ idle 60s → scale 1→0
                      ▼
                    COMPUTE (Deployment, replicas 0↔1)
                    native Postgres 17 + neon ext — stateless, no volume
                      │ WAL out                ▲ GetPage@LSN
                      ▼                        │
                    STORAGE (StatefulSets, never scale to zero)
                    safekeeper (durable WAL) · pageserver (pages) · MinIO (S3)
```

The compute keeps **no state**: killing its pod loses nothing; a fresh pod attaches to the
tenant/timeline and lazily fetches pages. Durability, replication, branching and PITR come
from Neon's storage components — reused, not rebuilt.

## Layout

```
gateway/   Go wake-on-connect proxy (client-go; stdlib otherwise). go test ./...
deploy/    All Kubernetes manifests + verification scripts:
           00 namespace · 10 gateway+RBAC · 20 compute (replicas:0) · 30 knext Secret
           40 KEDA (optional) · 50 minio · 51 broker · 52 safekeeper · 53 pageserver
           54 compute ConfigMaps · 55 storage-init Job
docs/      knext research + integration notes
```

## Quickstart (any local k8s: OrbStack, kind, minikube)

```sh
docker build -t scale-zero-pg/gateway:dev gateway/   # local image, no registry needed
kubectl apply -f deploy/                              # storage plane + compute(0) + gateway
sh deploy/_verify-storage.sh                          # data survives a compute kill
sh deploy/_verify-wake.sh                             # the full 0→1→0 wake loop
```

Connect like any Postgres (`sslmode=disable`; dev creds `cloud_admin`/`cloud_admin`):

```
postgres://cloud_admin:cloud_admin@pggw.scale-zero-pg.svc:55432/postgres?sslmode=disable
```

## knext integration

knext apps consume Postgres via a `DATABASE_URL` Secret — nothing else. Apply
`deploy/30-knext-secret.yaml` into the app namespace and reference it:

```yaml
# NextApp CR
spec:
  secrets:
    envMap:
      - env: DATABASE_URL
        secret: myapp-database
        key: DATABASE_URL
```

The app never knows the DB sleeps. Sizing rule: keep the app pool's idle timeout **below**
the gateway's `GW_IDLE_MS`, or pooled keepalives block scale-to-zero.

## Verification (measured on OrbStack k8s, 2026-07-02)

| Check | Result |
|---|---|
| Data survives compute pod kill (no volume, no restore) | ✅ 3/3 rows |
| Kill-to-first-query (pod recreate in place) | 1–2s |
| Cold wake 0→1 through gateway (schedule + init + attach) | 5.2s |
| Idle 60s → compute reaches zero | ✅ |
| Reconnect after zero re-wakes, data intact | ✅ |

Wake-latency budget & tuning: the 5.2s is dominated by pod scheduling, the wait-timeline
init container (2s poll), and the 1s readiness probe — not by Neon (compute attach is
sub-second). Tighten probes/init or pre-pull images to shrink it.

## Operations notes

- **Storage plane must never scale to zero** — it *is* the database.
- MVP ships 1 safekeeper / 1 pageserver; production = 3 safekeepers across failure domains.
- Gateway is stateless — scale it horizontally (`replicas: 2+`) for no-SPOF.
- `deploy/40-keda-scaledobject.yaml.optional` swaps gateway-driven sleep for KEDA if you
  want fleet-wide policies.
- Rotate the dev password by changing `roles[].encrypted_password`
  (md5 of `password+username`) in `deploy/54-compute-files.yaml` — `compute_ctl`
  re-applies spec roles on every boot, so `ALTER USER` alone won't stick.

## License note

Neon storage + compute are Apache-2.0. Re-confirm the license on the exact
components/versions you deploy.
