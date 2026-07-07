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
| `minio` | Deployment + PVC | S3 object storage — **optional** local default (see below) |
| `storage-broker` | Deployment | safekeeper ↔ pageserver coordination |
| `safekeeper` ×3 | StatefulSet + PVCs | durable WAL, 2/3 write quorum |
| `pageserver` | StatefulSet + PVC | page storage, GetPage@LSN |
| `storage-init` | Job | ensures the bucket on the configured store + creates the tenant/timeline (idempotent) |
| `compute` | Deployment (**replicas: 0**) | native Postgres 17 — your database |
| `pggw` ×2 | Deployment + Service | wake-on-connect gateway |

The compute starts at zero. That's correct — it wakes on the first connection.

### Choose your object storage (#105)

The durable object store is a **configured S3 endpoint**, not bundled MinIO. Run
`deploy/gen-secrets.sh` **before** `kubectl apply` — it creates the
`storage-s3-creds` Secret (S3 access/secret) and the `storage-objstore` ConfigMap
(`endpoint` / `bucket` / `region`). With no override, it defaults to the
in-cluster MinIO above — nothing else to do for local/dev.

**External backend (managed cloud S3, or on-prem SeaweedFS / Ceph RADOS Gateway /
Garage).** Point `storage-objstore` at it and **do not apply `deploy/50-minio.yaml`**:

```sh
# OCI Object Storage S3-compat example (mint a Customer Secret Key first):
STORAGE_OBJSTORE_ENDPOINT=https://<ns>.compat.objectstorage.<region>.oraclecloud.com \
STORAGE_OBJSTORE_BUCKET=ks-pg-pages STORAGE_OBJSTORE_REGION=me-abudhabi-1 \
STORAGE_S3_USER=<access> STORAGE_S3_PASSWORD=<secret> \
  sh deploy/gen-secrets.sh
# apply everything EXCEPT the in-cluster MinIO:
ls deploy/[0-9][0-9]-*.yaml | grep -v '50-minio.yaml' | xargs -I{} kubectl apply -f {}
```

Details, alternatives, and the posture rationale: [operations.md — Object-storage
backend](operations.md#object-storage-backend-105) and
[ADR-0005](adr-0005-object-storage-backend.md). Path-style + SigV4 are handled
automatically (neon forces path-style for any custom endpoint).

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
plane, sleeping/waking independently — deploy the apps-gateway, the CRD + operator,
bootstrap the plane once, then declare apps with an `AppDatabase` custom resource:

```sh
kubectl apply -f deploy/81-apps-gateway.yaml   # template-mode gateway (pggw-apps)
kubectl apply -f deploy/82-appdb-crd.yaml      # AppDatabase CRD (v1.0 provisioning interface)
kubectl apply -f deploy/83-appdb-operator.yaml # the appdb-operator (reconciles AppDatabases)

# one-time plane bootstrap (apps tenant + shared template timeline + base schema):
cd deploy && ./provision-app.sh init-plane --schema testdata/app-base-schema.sql
```

**Provision an app declaratively** — `kubectl apply` an `AppDatabase`; the operator
branches the template, renders the compute, mints the per-app credential Secret, and
wires the apps-gateway routing:

```sh
kubectl apply -f - <<'EOF'
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata:
  name: orders
  namespace: scale-zero-pg
spec:
  appName: orders
  tier: cold                                   # cold = scale-to-zero at rest (default)
  quotas: { cpu: "1000m", mem: "1Gi", maxConnections: 100 }
EOF

kubectl -n scale-zero-pg get appdatabases      # PHASE Ready, TIMELINE set, READY <bool>
kubectl -n scale-zero-pg get secret app-db-orders -o jsonpath='{.data.DATABASE_URL}' | base64 -d
# -> postgres://app_orders:<pw>@pggw-apps.scale-zero-pg.svc:55432/orders?sslmode=disable
```

`kubectl delete appdatabase orders` runs the finalizer's **safe deprovision** (removes
the k8s objects and reclaims the Neon timeline on the pageserver + all safekeepers —
no orphan) unless you set `spec.keepTimelineOnDelete: true`. Drift self-heals: a
hand-deleted Deployment is re-created on the next reconcile. Drill:
`sh deploy/_verify-operator.sh`.

> The imperative `provision-app.sh create/destroy/…` remains as a **break-glass / CI**
> tool (and is what `init-plane` uses); the `AppDatabase` CR is the v1.0 interface —
> see [ADR-0004](adr-0004-provisioning-bless-or-build.md). The DSN contract is
> identical either way.

Design, evidence and caveats: [ADR-0003](adr-0003-multi-tenancy.md) ·
[ADR-0004](adr-0004-provisioning-bless-or-build.md) ·
[connecting → multi-app](connecting.md#multi-app--branch-per-app) ·
[operations → operator runbook](operations.md#appdatabase-operator-runbook-96).

## 6. Zones — one logical system across consistency boundaries

The **Zone CRD + zone-operator ship as STANDARD cluster infrastructure** —
`deploy/86-zone-crd.yaml` + `deploy/87-zone-operator.yaml`, so the standard deploy
glob in step 2 (`ls deploy/[0-9][0-9]-*.yaml | ... | kubectl apply`) already installs
them alongside the apps-gateway + appdb-operator. `deploy/_verify-drift.sh` asserts
their live presence (the `zones` CRD installed + the zone-operator ready 1/1), so a
cluster where they were never applied fails the drift gate rather than passing
silently (issue #151 — the flagship must not be drill-only). **Authoring Zone CRs is
the opt-in part**; the reconciler that makes them work is always present.

To install (or re-apply) just the zone axis on an existing cluster:

```sh
kubectl apply -f deploy/86-zone-crd.yaml        # Zone CRD (zones.scale-zero-pg.dev)
kubectl apply -f deploy/87-zone-operator.yaml   # the zone-operator (runs 1/1, sustained)
```

A multi-zone system **shares a declared subset of data** across zones (the SCS use
case — e.g. an EU zone and a US zone that each own their writes but see an
eventually-consistent view of each other's data). A `Zone` COMPOSES an `AppDatabase`
(its strong-consistency in-zone DB) and adds the
cross-zone fabric. A zone **exports nothing by default** — `spec.publishes` is the
opt-in export boundary; `spec.dataDependencies` declares what it imports from peers:

```sh
kubectl apply -f - <<'EOF'
apiVersion: zones.scale-zero-pg.dev/v1alpha1
kind: Zone
metadata: { name: zone-eu, namespace: scale-zero-pg }
spec:
  database: { tier: cold, readReplicas: true }
  publishes:
    - { name: orders_pub, tables: [orders, order_lines] }   # what THIS zone exports
  dataDependencies:
    - { fromZone: zone-us, tables: [customers], mode: replicate }  # imported copy (eventual)
    # mode: federate  ->  live postgres_fdw read instead of a maintained copy
EOF

kubectl -n scale-zero-pg get zones   # PHASE Ready, DB (composed AppDatabase), plus
                                     # status.subscriptions[].state = streaming|federated|denied
```

The operator is the **sole author** of the cross-zone SQL: the per-zone
`repl_<zone>` role, the publications, and each subscription (whose connection points
at the apps-gateway, so a sleeping publisher is woken on demand). A dependency is
wired **only when both sides agree** — the peer must `publishes` every requested
table, else it shows `state: denied` in status (never a silent grant). A table may be
published by **at most one zone** (single-writer-per-replicated-table). `kubectl
delete zone zone-eu` runs the finalizer's cross-zone hygiene (drops the
subscription + the slot on each peer, then the composed AppDatabase reclaims the
timeline). Consistency is **strong in-zone, eventual across-zone, no cross-zone
ACID** (use sagas). Design + evidence: [ADR-0007](adr-0007-zoned-consistency.md);
live drill `deploy/_verify-zones.sh`; runbook
[operations → zone operator](operations.md#zone-operator--cross-zone-fabric-v2-2-139).

Next: [connecting your app](connecting.md) · [operations guide](operations.md)
