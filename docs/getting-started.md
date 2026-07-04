# Getting started

Deploy a scale-to-zero PostgreSQL on any Kubernetes cluster — the canonical
deployment runs on OKE (Oracle); local clusters (OrbStack, kind, minikube, k3s)
work the same way in about five minutes. Note: OCI block volumes have a 50 GB
minimum, so small PVC requests round up there.

## Prerequisites

- A Kubernetes cluster and `kubectl` pointed at it (`kubectl get nodes` works).
- Docker (to build the gateway image). On OrbStack/minikube the cluster shares the
  local image store; on kind use `kind load docker-image` after building.
- ~6 GiB free disk for images + PVCs. No registry, no Helm, no operators.

## 1. Gateway image

The manifests reference the **v0.6.0 release image** in OCIR
(`me-abudhabi-1.ocir.io/axfqznklsd2t/ks-pg/gateway:v0.6.0@sha256:9ee6497826…` — the
amd64 image that the `v0.6.0` tag/index `sha256:e6bc0306…` resolves to, which is what
the kubelet reports as the running imageID; digest-pinned per the #56 scheme). The
same multi-binary image backs `deploy/10-gateway.yaml`, `58-pswatcher.yaml`
(`/pswatcher`), and `61-alertmanager.yaml` (`/alertsink`), so live == release ==
manifests for the single-DB gateway + control plane and `_verify-drift.sh` is green on
the release digest for those (issue #82). The **apps-gateway** (`81-apps-gateway.yaml`,
`/gateway` template mode) carries its own security image on the v0.6.1 tenant-security
lane; its `live == release == manifest` reconciliation lands at the v0.6.1 tag. Private
pulls need
the `ocir-pull` Secret (created by `deploy/gen-secrets.sh` when registry creds
are available, or `kubectl create secret docker-registry ocir-pull ...`).

For a purely local cluster instead: build and retag —

```sh
docker build -t scale-zero-pg/gateway:dev gateway/
# kind: kind load docker-image scale-zero-pg/gateway:dev
# then point the image fields in deploy/10-gateway.yaml + 61-alertmanager.yaml at it
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
sh deploy/_verify-cronjob-alerting.sh     # a failing CronJob pages via KSM; KSM+pswatcher targets UP
sh deploy/_verify-ksm-down.sh             # KSM down => KubeStateMetricsDown pages (producer self-guard, #48)
sh deploy/_verify-wal-janitor.sh          # janitor prunes ONLY below-horizon WAL; fail-closed; idempotent (#37/#42)
sh deploy/_verify-drift.sh                # declared workloads exist AND are ready/not-suspended (#27/#51)
sh deploy/_verify-netpol.sh               # network isolation contracts (warns on non-enforcing CNI)
sh deploy/_verify-restore.sh              # backup -> restore in a throwaway namespace (~110s RTO)
sh deploy/_verify-pageserver-failover.sh  # pageserver loss -> promoted standby (~7s RTO)
sh deploy/_verify-multitenant.sh          # branch-per-app: two apps, one plane, isolated + independent 0<->1 (ADR-0003)
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

## 5. (Optional) A database per app

For DB-per-app multi-tenancy — each app its own Neon **branch** on one storage
plane, sleeping/waking independently — deploy the apps-gateway and provision apps:

```sh
kubectl apply -f deploy/81-apps-gateway.yaml          # template-mode gateway (pggw-apps)
cd deploy
./provision-app.sh init-plane --schema testdata/app-base-schema.sql   # one-time: template
./provision-app.sh create orders                       # branch + scale-to-zero compute (~4s)
# connect: postgres://cloud_admin:cloud_admin@pggw-apps.scale-zero-pg.svc:55432/orders?sslmode=disable
```

Design, evidence and caveats: [ADR-0003](adr-0003-multi-tenancy.md) ·
[connecting → multi-app](connecting.md#multi-app--branch-per-app).

Next: [connecting your app](connecting.md) · [operations guide](operations.md)
