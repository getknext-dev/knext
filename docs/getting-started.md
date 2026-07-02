# Getting started

Deploy a scale-to-zero PostgreSQL on any local or single-node Kubernetes cluster
(OrbStack, kind, minikube, k3s) in about five minutes.

## Prerequisites

- A Kubernetes cluster and `kubectl` pointed at it (`kubectl get nodes` works).
- Docker (to build the gateway image). On OrbStack/minikube the cluster shares the
  local image store; on kind use `kind load docker-image` after building.
- ~6 GiB free disk for images + PVCs. No registry, no Helm, no operators.

## 1. Build the gateway image

```sh
docker build -t scale-zero-pg/gateway:dev gateway/
# kind only: kind load docker-image scale-zero-pg/gateway:dev
```

## 2. Deploy everything

```sh
kubectl apply -f deploy/
```

This creates the `scale-zero-pg` namespace with:

| Component | Kind | Purpose |
|---|---|---|
| `minio` | Deployment + PVC | S3 object storage (durable history) |
| `storage-broker` | Deployment | safekeeper ↔ pageserver coordination |
| `safekeeper` ×3 | StatefulSet + PVCs | durable WAL, 2/3 write quorum |
| `pageserver` | StatefulSet + PVC | page storage, GetPage@LSN |
| `storage-init` | Job | creates the tenant + timeline (one-shot, idempotent) |
| `compute` | Deployment (**replicas: 0**) | native Postgres 17 — your database |
| `pggw` ×2 | Deployment + Service | wake-on-connect gateway |

The compute starts at zero. That's correct — it wakes on the first connection.

## 3. Verify

```sh
sh deploy/_validate.sh                    # manifests + contracts (incl. version-pair gate)
sh deploy/_verify-storage.sh              # data survives a compute kill; safekeeper quorum drill
sh deploy/_verify-wake.sh                 # the full 0→1→0 wake loop
sh deploy/_verify-ha.sh                   # 2-gateway no-SPOF / no-split-brain drill
sh deploy/_verify-alerting.sh             # an alert fires and REACHES the receiver
sh deploy/_verify-netpol.sh               # network isolation contracts (warns on non-enforcing CNI)
sh deploy/_verify-restore.sh              # backup -> restore in a throwaway namespace (~110s RTO)
sh deploy/_verify-pageserver-failover.sh  # pageserver loss -> promoted standby (~7s RTO)
```

Expected: all green; wake latency ~2.5s on a warm node (or ~0.4s on the opt-in
warm tier — see [connecting](connecting.md#choosing-a-tier-cold-zero-default-vs-warm)).

## 4. Connect

From inside the cluster (any pod):

```
postgres://cloud_admin:cloud_admin@pggw.scale-zero-pg.svc:55432/postgres?sslmode=disable
```

From your laptop: `kubectl -n scale-zero-pg port-forward svc/pggw 55432:55432`, then
`psql "postgres://cloud_admin:cloud_admin@localhost:55432/postgres?sslmode=disable"`.

The first connection after idle takes ~2.5s (the database is waking); every
connection after that is normal Postgres latency. Watch it happen:

```sh
kubectl -n scale-zero-pg get pods -l app=compute -w
```

Next: [connecting your app](connecting.md) · [operations guide](operations.md)
