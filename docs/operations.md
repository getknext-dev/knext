# Operations guide

Day-2 reference for running the platform: configuration, monitoring, failure
behavior, and troubleshooting.

## Gateway configuration (env on `deploy/pggw`)

| Variable | Default | Meaning |
|---|---|---|
| `GW_PORT` | 55432 | Postgres wire listener |
| `GW_METRICS_PORT` | 9090 | `/metrics` (Prometheus), `/metrics.json`, `/healthz` |
| `GW_COMPUTE_MODE` | static | `static` \| `exec` \| `kubectl` \| `template` |
| `GW_TARGET` | 127.0.0.1:55432 | compute address (static/exec/kubectl) |
| `GW_K8S_NAMESPACE` / `GW_K8S_DEPLOYMENT` | scale-zero-pg / compute | what `kubectl` mode scales 0↔1 |
| `GW_TARGET_TEMPLATE` / `GW_K8S_DEPLOYMENT_TEMPLATE` | — | `template` mode: `{system}` = database name (multi-DB, parked) |
| `GW_IDLE_MS` | 300000 | idle window before scale-to-zero (deployed: 60000) |
| `GW_WAKE_TIMEOUT_MS` | 60000 | give up waking after this (deployed: 120000) |
| `GW_CONNECT_TIMEOUT_MS` / `GW_RETRY_MS` | 1000 / 250 | per-attempt connect timeout / poll interval (deployed retry: 100) |
| `GW_PEER_SELECTOR` | — | label selector for sibling gateways (peer-aware idle); empty disables |
| `GW_POD_NAMESPACE` / `GW_POD_IP` | — | downward API; self-exclusion for the peer check |

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

**Alert on:** `wake_failures_total` increasing; a system whose `active_connections`
is 0 for hours but never sleeps (phantom keepalive — usually a client pool holding
idle connections; see [connecting](connecting.md#connection-pooling-rules));
`wake_latency_ms_last` drifting above ~5s (node image/pressure problem).

Quick look without Prometheus: `sh deploy/_metrics.sh`.

## Durability model (what you can lose, and when)

- A **committed write is durable once 2/3 safekeepers ack** its WAL. Losing any one
  safekeeper pod/PVC loses nothing and doesn't block writes (drill-verified).
- The **compute is disposable** — kill it any time; no volume, no restore. Data is
  never in the pod.
- **Pageserver loss** (single, MVP): serving stops until it restarts (PVC-backed);
  history also lives in MinIO. Production: add a secondary pageserver.
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

- **`CronJob/backup`** (daily 03:00) mirrors the `neon` bucket into a dedicated
  second store (`backup-store`, an in-cluster MinIO PVC for the MVP) with pinned
  `minio/mc`, and dumps the ConfigMaps + Secret alongside it. The config dump runs
  in an initContainer on a pinned kubectl image under a **scoped ServiceAccount**
  (`backup-operator`: `get`/`list` on configmaps+secrets in `scale-zero-pg` only).
- **On demand:** `kubectl -n scale-zero-pg create job backup-now --from=cronjob/backup`.

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
backup, then in a **throwaway `restore-drill` namespace** stands up minio (seeded
from the backup) + broker + 1 safekeeper + pageserver + compute, **reconstructed
from the backed-up config**, and reads the marker back. Self-cleaning; leaves the
live compute as found (scaled to 0). **Measured RTO (backup start → first query in
the rebuilt plane): ~110 s** on orbstack — dominated by two multi-GB bucket copies
+ storage-plane boot, not by Postgres.

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

### Production hardening (before relying on this)

- **Point the mirror at OFF-CLUSTER object storage** (real S3/GCS) with **bucket
  versioning + a lifecycle policy** (e.g. keep 30 daily / 12 monthly) and a
  **separate least-privilege credential**; then drop the in-cluster `backup-store`
  (change the `dst` alias + creds Secret in `CronJob/backup`). The in-cluster copy
  survives losing a storage PVC but **not** node loss — off-cluster is what closes
  the node-loss / `kubectl delete pvc` incident.
- Alert on backup Job failure (`kube_job_status_failed{job_name=~"backup.*"}`) and on
  backup age (last successful completion older than ~26 h).

## Password rotation

`ALTER USER ... PASSWORD` does **not** stick — `compute_ctl` re-applies the spec's
roles on every boot. To rotate:

1. Compute the hash: `md5` of `password + username`, e.g.
   `printf 'NEWPASScloud_admin' | md5`.
2. Put it in `roles[].encrypted_password` inside `deploy/54-compute-files.yaml`
   (the `config.json` key) and `kubectl apply -f deploy/54-compute-files.yaml`.
3. Update the app Secrets (`30-knext-secret.yaml`) and restart the compute:
   `kubectl -n scale-zero-pg rollout restart deploy/compute`.

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
