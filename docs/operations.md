# Operations guide

Day-2 reference for running the platform: configuration, monitoring, failure
behavior, and troubleshooting.

## Gateway configuration (env on `deploy/pggw`)

| Variable | Default | Meaning |
|---|---|---|
| `GW_PORT` | 55432 | Postgres wire listener |
| `GW_METRICS_PORT` | 9090 | `/metrics` (Prometheus), `/metrics.json`, `/healthz` |
| `GW_COMPUTE_MODE` | static | `static` \| `exec` \| `kubectl` \| `template` \| `warmpool` |
| `GW_TARGET` | 127.0.0.1:55432 | compute address (static/exec/kubectl; warmpool: compute-warm svc:55433) |
| `GW_K8S_NAMESPACE` / `GW_K8S_DEPLOYMENT` | scale-zero-pg / compute | what `kubectl` mode scales 0↔1 |
| `GW_TARGET_TEMPLATE` / `GW_K8S_DEPLOYMENT_TEMPLATE` | — | `template` mode: `{system}` = database name (multi-DB, parked) |
| `GW_GATE_PORT` | 9091 | `warmpool` mode: TCP port the parked warm pod polls; the gateway opens it (accept) only after the single-writer check passes |
| `GW_WARM_DEPLOYMENT` / `GW_WARM_COLD_DEPLOYMENT` | compute-warm / compute | `warmpool` mode: the gated warm deployment, and the cold deployment that must be fully drained before the gate opens |
| `GW_IDLE_MS` | 300000 | idle window before scale-to-zero (deployed: 60000) |
| `GW_WAKE_TIMEOUT_MS` | 60000 | give up waking after this (deployed: 120000) |
| `GW_CONNECT_TIMEOUT_MS` / `GW_RETRY_MS` | 1000 / 250 | per-attempt connect timeout / poll interval (deployed retry: 100) |
| `GW_MAX_CONNS` | 0 (unlimited) | connection cap; excess gets a clean `53300`. Deployed: 90 — MUST stay under compute `max_connections=100` |
| `GW_PEER_SELECTOR` | — | label selector for sibling gateways (peer-aware idle); empty disables |
| `GW_POD_NAMESPACE` / `GW_POD_IP` | — | downward API; self-exclusion for the peer check |
| `GW_TLS_CERT_FILE` / `GW_TLS_KEY_FILE` | — | front-door TLS keypair (PEM paths). Both set + loadable → gateway answers `SSLRequest` with `S` and wraps the wire (TLS 1.2+). Set-but-unloadable or half-set → gateway **fails fast at startup**. Unset → `SSLRequest` gets `N` (plaintext only). Deployed: mounted from Secret `pggw-tls` at `/etc/pggw-tls/`. |

Every `GW_*` var passes through verbatim — there is deliberately no whitelist.

## Monitoring

Scrape each gateway pod's `:9090/metrics` (Prometheus text) or read `/metrics.json`:

| Metric | Meaning |
|---|---|
| `pggw_wakes_total` / `pggw_wake_failures_total` | cold starts triggered / failed |
| `pggw_wake_latency_ms_last` | last wake duration (per pod — take max across pods, don't sum) |
| `pggw_active_connections` | live client connections (per pod — sum across pods) |
| `pggw_sleeps_total` | scale-to-zero events |
| `pggw_system_*{system=...}` | the same, per database key |

**Alerting is deployed and drilled**, not aspirational: Prometheus
(`deploy/60-prometheus.yaml`, PVC-backed, 15d retention) evaluates three rules —
wake failures, wake-latency drift >5s, and phantom keepalive (state-based:
connections never idle for 30m; see [connecting](connecting.md#connection-pooling-rules))
— and routes via Alertmanager (`61-alertmanager.yaml`) to a logging webhook sink.
**Swap the sink URL in `alertmanager-config` for Slack/PagerDuty in production.**
Prove the whole pager path any time: `sh deploy/_verify-alerting.sh` (idempotent,
safe to re-run).

Quick look without Prometheus: `sh deploy/_metrics.sh`.

## Durability model (what you can lose, and when)

- A **committed write is durable once 2/3 safekeepers ack** its WAL. Losing any one
  safekeeper pod/PVC loses nothing and doesn't block writes (drill-verified).
- The **compute is disposable** — kill it any time; no volume, no restore. Data is
  never in the pod.
- **Pageserver loss** (single, MVP): reads stop until it restarts, OR until a warm
  standby is promoted — the drill-measured failover is **~7 s** (see "Pageserver
  failover"). PVC-backed; history also lives in MinIO.
- **MinIO loss**: running computes keep serving from safekeepers+pageserver; new
  timeline creation and long-term history offload pause. PVC-backed.
- **Both gateways down**: new connections fail (existing pipes drop); data unaffected.
- **Node loss / both storage PVCs gone**: recoverable **only** from the off-cluster
  backup (below). Everything durable lives in the MinIO `neon` bucket; the backup is
  the copy that survives losing the cluster. See "Backup & disaster recovery".

## Backup & disaster recovery

Closes the standing CRITICAL finding ("no backups anywhere"). Manifests:
`deploy/62-backup.yaml`; rehearsed drill: `deploy/_verify-restore.sh`.

### What is the backup

The durable truth is the MinIO `neon` bucket — **pageserver layer uploads**
(`/pageserver`) + **safekeeper WAL offload** (`/safekeeper`) — plus the config the
bucket alone cannot rebuild: the `compute-config` / `compute-files` /
`pageserver-config` ConfigMaps (fixed tenant/timeline IDs, compute spec) and the
`storage-s3-creds` Secret. The pageserver PVC is a rebuildable cache; safekeeper
PVCs hold only recent WAL. So **a faithful backup = a copy of the bucket + the
config**, and **a faithful restore = a fresh storage plane attached to a restored
bucket copy**.

### How it runs

- **`CronJob/backup`** (daily 03:00) mirrors the `neon` bucket **off-cluster to OCI
  Object Storage** over its native S3-compatible endpoint (pinned `minio/mc`,
  signature v4, path-style), and dumps the ConfigMaps + Secret alongside it under
  the destination bucket's `neon/` and `neon-config/` prefixes. The config dump
  runs in an initContainer on a pinned kubectl image under a **scoped
  ServiceAccount** (`backup-operator`: `get`/`list` on configmaps+secrets in
  `scale-zero-pg` only). `src` (in-cluster MinIO) authenticates with
  `storage-s3-creds`; `dst` (OCI OS) uses a **separate least-privilege**
  `backup-s3-target` Secret.
- **On demand:** `kubectl -n scale-zero-pg create job backup-now --from=cronjob/backup`.
- **The `backup-s3-target` Secret** (endpoint / access / secret / bucket) is
  created by `deploy/gen-secrets.sh` from an **OCI Customer Secret Key** — the
  S3 access/secret pair, minted **once per tenancy** for the API-key user and
  shown only at creation. Provision (owner, once):

  ```sh
  NS=axfqznklsd2t                # OCI Object Storage namespace (oci os ns get)
  REGION=me-abudhabi-1
  # 1. bucket with versioning + a 30-day lifecycle on non-current versions:
  oci --profile DEFAULT os bucket create -ns $NS --name ks-pg-backup \
      --compartment-id <compartment-ocid> --versioning Enabled
  oci --profile DEFAULT os object-lifecycle-policy put -ns $NS \
      --bucket-name ks-pg-backup --from-json file://lifecycle.json --force
  # (lifecycle.json: DELETE previous-object-versions after 30 DAYS. Requires an
  #  IAM policy: "Allow service objectstorage-$REGION to manage object-family in
  #  tenancy" — otherwise the put returns InsufficientServicePermissions.)
  # 2. the S3 access/secret pair (Customer Secret Key):
  oci --profile DEFAULT iam customer-secret-key create --user-id <user-ocid> \
      --display-name ks-pg-backup-s3 --query 'data.{access:id,secret:key}'
  # 3. the cluster Secret:
  BACKUP_S3_ENDPOINT=https://$NS.compat.objectstorage.$REGION.oraclecloud.com \
  BACKUP_S3_ACCESS=<access> BACKUP_S3_SECRET=<secret> BACKUP_S3_BUCKET=ks-pg-backup \
    sh deploy/gen-secrets.sh
  ```

  `gen-secrets.sh` is idempotent (won't rotate an existing Secret) and, if the
  Secret is missing **and** no credentials are supplied, prints these steps and
  fails loudly rather than creating a half-empty Secret.
- **Retention/pruning:** the mirror runs `mc mirror --remove`, so deleting an
  object in the live `neon` bucket removes it from the OCI copy too; with bucket
  **versioning** on, that becomes a non-current version which the **lifecycle
  policy deletes after 30 days**. This closes the incident where un-pruned mirror
  copies accumulated to ~60 GB. If the lifecycle API is ever unavailable on the
  compat endpoint, fall back to `mc rm --recursive --force --older-than 30d
  dst/ks-pg-backup/neon` as a scheduled prune.
- **Proven envelope:** the earlier in-cluster path was verified green at **~18 GB**
  bucket size with the shipped mc-client sizing (1Gi); the OCI OS path uses the
  same client and retry loop. The retry loop has live evidence (a mid-run mirror
  read race converged on retry).

### The honesty rule (critical)

A backup is only trustworthy for data the **pageserver has already uploaded to the
bucket** — i.e. `remote_consistent_lsn ≥ the write's LSN`. A restore stands up
**fresh, empty safekeepers**, so anything still only in safekeeper WAL (not yet in
a pageserver layer) is **not** restorable. The pageserver flushes+uploads a layer
after ~`checkpoint_distance` (256 MB) of WAL or on its checkpoint timer. The drill
forces this and asserts `remote_consistent_lsn` passed the marker LSN before taking
the backup. Operationally: **do not treat a just-written row as backed up until the
pageserver has uploaded it** (watch `remote_consistent_lsn` on
`GET :9898/v1/tenant/<t>/timeline/<tl>`).

### Rehearsed restore drill — `deploy/_verify-restore.sh`

Writes a tagged marker through the live compute, forces it into the bucket, takes a
backup **to OCI Object Storage**, then in a **throwaway `restore-drill` namespace**
stands up minio (seeded from the OCI OS backup) + broker + 1 safekeeper +
pageserver + compute, **reconstructed from the backed-up config**, and reads the
marker back. Self-cleaning; leaves the live compute as found (scaled to 0).
**Measured RTO (backup start → first query in the rebuilt plane): ~417 s** on
OKE (context-ckmva7v7zvq, 2026-07-03) — up from the ~304 s in-cluster path because
it now adds two cross-internet bucket copies to/from OCI OS (upload the neon
bucket, then re-download it into the drill minio) on top of the storage-plane
boot; still not bounded by Postgres. See docs/BENCHMARKS.md.

### What we learned (tribal knowledge, now written down)

- **Re-attach at a HIGHER generation.** The live tenant/index are at generation 1;
  the drill re-attaches at **generation 2** (`location_config` `AttachedSingle`,
  `generation:2`). The pageserver picks the newest `index_part.json-<gen>` with
  generation ≤ its own, so gen 2 reads the gen-1 index and writes forward at gen 2 —
  a clean control-plane-style re-attach. Attaching at the **same** generation risks
  overwriting the index; attaching **lower** would not see the latest index.
- **A restore is READ-ONLY on 8464 OSS.** A read-write compute needs the safekeepers
  to confirm WAL continuity from the basebackup LSN; fresh safekeepers report
  `flush_lsn 0/0`, so Postgres aborts with *"cannot start in read-write mode from
  this base backup"*. On 8464 there is **no safekeeper HTTP API to (re)create a
  timeline at an existing LSN** (`GET`/`DELETE` exist; `POST`/`PUT` → 404) and **no
  storage controller** to drive it — fresh safekeepers can only be bootstrapped at
  LSN 0 by the compute's walproposer. So the faithful restore is a **STATIC
  read-only compute** pinned to the restored pageserver LSN
  (`spec.mode = {"Static":"<lsn>"}`), which reads pages directly from the pageserver
  and needs **no safekeepers**. This proves durability + readability of the backup.
- **Promoting a restore to a writable primary** additionally requires re-seeding the
  safekeepers' WAL from the restored point (import from the backed-up `/safekeeper`
  prefix, or a storage-controller-driven timeline create). **Not yet automated** —
  it is the manual follow-on step and the main gap between "data recovered, readable"
  and "service fully back". Track alongside the second-pageserver work.

### Production hardening

- **Off-cluster target — DONE (issue #4).** The mirror writes to **OCI Object
  Storage** with **bucket versioning + a 30-day lifecycle policy** on non-current
  versions and a **separate least-privilege credential** (`backup-s3-target`). The
  retired in-cluster `backup-store` MinIO PVC survived losing a storage PVC but
  **not** node loss; the off-cluster copy is what closes the node-loss /
  `kubectl delete pvc` incident. On a cluster still running the old workload,
  after the first OCI backup is green:
  `kubectl -n scale-zero-pg delete deploy/backup-store svc/backup-store pvc/backup-store-data`.
- **Remaining:** longer-horizon retention tiers (e.g. monthly beyond 30 days) if
  policy demands; a second region copy for regional durability.
- Alert on backup Job failure (`kube_job_status_failed{job_name=~"backup.*"}`) and on
  backup age (last successful completion older than ~26 h).

## Pageserver failover

The single pageserver is the MVP's read authority — lose it and reads stall (writes
still reach the safekeeper quorum). The reviews flagged this as an *unbounded* read
outage. Assessment + rehearsal: `deploy/_verify-pageserver-failover.sh`.

### Verdict (hands-on, neon:8464 OSS)

- **A second pageserver is feasible.** 8464 accepts a **warm Secondary** location
  (`location_config` `mode:"Secondary"`, `secondary_conf.warm:true`) that
  pre-downloads layers from the bucket without serving — verified in the drill.
- **Failover is MANUAL** (no storage controller here — we run
  `control_plane_emergency_mode`). It is the same generation+1 re-attach learned in
  the restore drill: promote the standby to `AttachedSingle` at **generation+1**
  (fences the dead primary), then re-point the compute at it. The surviving
  safekeeper carries the WAL, so the promoted pageserver streams forward and the DB
  stays **read-WRITE** across the failover.
- **Measured failover RTO: ~7 s** (kill → cold compute reads restored) in the
  self-contained drill. This converts the SPOF from an *unbounded* outage into a
  *known, small* RTO — a genuine reliability change even without automation.

### The failover runbook (manual, until automated)

Given a warm-standby pageserver `pageserver-b` (Secondary) alongside the primary:

1. Confirm the primary is actually gone (don't split-brain a slow one):
   `kubectl -n scale-zero-pg delete statefulset/pageserver --cascade=foreground`.
2. Promote the standby at generation+1 (read the live generation from
   `GET :9898/v1/location_config`, add 1):
   `curl -X PUT .../v1/tenant/<T>/location_config -d '{"mode":"AttachedSingle","generation":<N+1>,"tenant_conf":{}}'`.
3. Re-point reads at the standby: flip the `pageserver` Service selector to the
   standby (so the compute's `neon.pageserver_connstring host=pageserver` is
   unchanged) **or** update the connstring; then bounce the compute
   (`rollout restart deploy/compute`) so a cold wake basebackups from the standby.
4. Verify a read; the DB is read-write again.

### To productize (make it automatic)

- Run `pageserver-b` as a standing warm Secondary (a second StatefulSet, distinct
  `identity.toml` id, same bucket) and front both with the `pageserver` Service.
- Drive steps 1–3 from a tiny controller/liveness watcher (promote + flip selector
  on primary-down). That is the missing automation; the generation+1 + Service-flip
  mechanism above is proven and ready for it. (Pairs with the writable-restore
  safekeeper re-seed gap from "Backup & disaster recovery".)

## Password rotation

`ALTER USER ... PASSWORD` does **not** stick — `compute_ctl` re-applies the spec's
roles on every boot. To rotate:

1. Compute the hash: `md5` of `password + username`, e.g.
   `printf 'NEWPASScloud_admin' | md5`.
2. Put it in `roles[].encrypted_password` inside `deploy/54-compute-files.yaml`
   (the `config.json` key) and `kubectl apply -f deploy/54-compute-files.yaml`.
3. Update the app Secrets (`30-knext-secret.yaml`) and restart the compute:
   `kubectl -n scale-zero-pg rollout restart deploy/compute`.

## TLS certificate rotation

The gateway terminates TLS on the Postgres wire when `GW_TLS_CERT_FILE` +
`GW_TLS_KEY_FILE` are set (see the config table). The keypair lives in the Secret
`pggw-tls`, mounted at `/etc/pggw-tls/`. This closes the "plaintext Postgres on an
external LoadBalancer" review finding — clients connect with `sslmode=require`.

**Generate it (once):** `sh deploy/gen-tls.sh`. Idempotent — it self-signs a cert
(CN `pggw.scale-zero-pg.svc`; SANs cover `pggw`, `pggw-lb`, `localhost`, `127.0.0.1`)
into Secret `pggw-tls` **only if absent**, so it never rotates silently. The pods
require the Secret to start, so run this **before** `kubectl apply -f deploy/10-gateway.yaml`.

**Self-signed, on purpose.** This is cluster-local infra. Clients use
`sslmode=require` (encrypt without CA verification) — **not** `verify-full`. Moving
to `verify-full` needs a cert from a CA the clients trust (cert-manager + an issuer,
or your org CA); swap the Secret contents and clients can then verify.

**To rotate (deliberate):**

1. Regenerate the keypair (self-signed example):
   ```
   kubectl -n scale-zero-pg delete secret pggw-tls
   sh deploy/gen-tls.sh
   ```
   Or `kubectl -n scale-zero-pg create secret tls pggw-tls --cert=… --key=… \
   --dry-run=client -o yaml | kubectl apply -f -` for a CA-issued pair.
2. Roll the gateway so it reloads the mount: `kubectl -n scale-zero-pg rollout
   restart deploy/pggw`. A mounted Secret update also propagates to the file on
   its own, but the gateway loads the cert once at startup — the restart is what
   picks it up.
3. Verify: `sh deploy/_verify-tls.sh` (proves `sslmode=require` is encrypted,
   `sslmode=disable` still works, and the wake path works over TLS).

**Disabling TLS** (revert to plaintext): unset the two env vars in
`deploy/10-gateway.yaml` and restart. `SSLRequest` then gets `N` again and only
`sslmode=disable` clients connect.

## Network isolation caveat

`deploy/70-networkpolicy.yaml` (default-deny + per-flow allows; compute reachable
only from the gateway) is declaratively correct but **only enforced if your CNI
enforces NetworkPolicy**. OrbStack's bundled Kubernetes does NOT — the policies
are inert there (verified; `deploy/_verify-netpol.sh` warns instead of faking a
pass). Before relying on isolation in production, run on Calico/Cilium (or any
enforcing CNI) and re-run `_verify-netpol.sh`, which hard-asserts once
enforcement is detected.

## Common operations

```sh
# force the DB awake / asleep manually
kubectl -n scale-zero-pg scale deploy/compute --replicas=1   # or 0

# change the idle window (e.g. 5 min)
kubectl -n scale-zero-pg set env deploy/pggw GW_IDLE_MS=300000

# scale gateways (peer-aware idle keeps sleep decisions safe at any count)
kubectl -n scale-zero-pg scale deploy/pggw --replicas=3

# watch the wake loop live
kubectl -n scale-zero-pg get pods -l app=compute -w
kubectl -n scale-zero-pg logs -l app=pggw -f --prefix | grep 'gw]'
```

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Client: `compute unavailable` after ~2 min | Wake timed out. `kubectl -n scale-zero-pg describe pod -l app=compute` — image pull? Pending (resources)? `wait-timeline` init stuck (pageserver down or storage-init never ran)? |
| Compute crashloops with `TENANT_ID ... must set` | `compute-config` ConfigMap missing/edited — re-apply `54-compute-files.yaml`, re-run `55-storage-init.yaml`. |
| Compute Running but clients hang | Check pageserver/safekeeper pods; `kubectl logs deploy/compute -c compute` (look at `total_startup_ms` line — healthy is ~150ms). |
| DB never scales to zero | An app pool is holding idle connections (`pggw_active_connections` > 0), or a peer gateway is unreachable (peer check fails ⇒ sleep is postponed by design — see gateway logs "postponing sleep"). |
| First query after idle is slow | That's the wake (~2.5s). Only sub-second option today: keep it awake (`replicas: 1` + `GW_IDLE_MS=0`) or wait for the warm-standby pool (TASKS.md phase 3). |
| `password authentication failed` after redeploy | The spec reset the role password (by design). See rotation above. |
| Verify scripts fail on a fresh cluster | Order matters only the first time: storage pods Ready → `storage-init` Complete → everything else is self-healing. |

## Upgrades

- **Gateway**: build a new image, `rollout restart deploy/pggw` — zero client impact
  beyond dropped in-flight pipes (clients reconnect).
- **Compute ↔ storage are a version PAIR.** The compute (`compute-node-v17:8464`)
  and storage plane (`neon:8464`) are built from the same Neon release and must be
  upgraded together — the pageserver wire protocol and layer formats are internal
  interfaces with no cross-version guarantee. Supported pair today: **8464 + 8464**.
- **Upgrade procedure** (both images): bump both tags in `deploy/` on a throwaway
  cluster, run the full verify battery, then promote. Never `:latest` anywhere.
  The compute is stateless so its rollback is trivial; storage rollback is NOT
  (layer formats may migrate forward) — take an on-demand backup before a storage
  bump (`kubectl -n scale-zero-pg create job backup-now --from=cronjob/backup`; see
  "Backup & disaster recovery").
