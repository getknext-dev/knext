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
- **Pageserver loss** (single, MVP): reads stop until it restarts, OR until the warm
  standby is **automatically** promoted — the drill-measured failover is **~8 s, hands
  off** (see "Pageserver failover"). PVC-backed; history also lives in MinIO.
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
marker back. It then **promotes the restore to a read-WRITE primary** (STEP 5,
`deploy/_restore-writable.sh`) and asserts an INSERT **survives a compute kill +
fresh re-basebackup** — proving the restore comes back as a *service*, not just
readable data. Self-cleaning; leaves the live compute as found (scaled to 0).
**Measured RTO** on OKE (context-ckmva7v7zvq, 2026-07-03, **after the issue #19
WAL prune**): **read-only 1045 s** (backup start → first drill read) and
**writable 1226 s** (backup start → durable INSERT). The bulk — and the run-to-run
spread — is the two cross-internet bucket copies to/from OCI OS (upload the neon
bucket, then re-download it into the drill minio), which scale with bucket size.
The **read→write promotion delta is only ~181 s** (safekeeper WAL re-seed × 2
phases + one pageserver catch-up + the PRIMARY boot) and is independent of bucket
size. Pruning stale safekeeper WAL (below) took this drill from **>60 min
(unbounded, at a 13 GiB bucket)** to a **bounded ~20 min**; the remaining RTO is
now dominated by the **~11 GiB of pageserver layer files** (real data + the 7-day
PITR history), not safekeeper WAL. Still not bounded by Postgres. See
docs/BENCHMARKS.md.

### What we learned (tribal knowledge, now written down)

- **Re-attach at a HIGHER generation.** The live tenant/index are at generation 1;
  the drill re-attaches at **generation 2** (`location_config` `AttachedSingle`,
  `generation:2`). The pageserver picks the newest `index_part.json-<gen>` with
  generation ≤ its own, so gen 2 reads the gen-1 index and writes forward at gen 2 —
  a clean control-plane-style re-attach. Attaching at the **same** generation risks
  overwriting the index; attaching **lower** would not see the latest index.
- **Read-only is the first, always-safe proof.** The faithful *readability* check is
  a **STATIC read-only compute** pinned to the restored pageserver LSN
  (`spec.mode = {"Static":"<lsn>"}`), which reads pages directly from the pageserver
  and needs **no safekeepers**. This proves durability + readability of the backup
  independently of the writable-promotion machinery, and is the fallback if
  promotion ever fails.
- **A restore can now be promoted to READ-WRITE on 8464 OSS** (issue #2,
  `deploy/_restore-writable.sh`). The blocker was that a read-write compute needs a
  safekeeper that confirms WAL continuity from the basebackup LSN, and a fresh drill
  safekeeper reports `flush_lsn 0/0`, so Postgres aborts with *"cannot start in
  read-write mode from this base backup"*. On 8464 there is **no safekeeper HTTP API
  to create a timeline at an existing LSN** (`GET`/`DELETE` exist; `POST` timeline
  and `PUT .../control_file` → 404) and **no storage controller**, so the fix is
  **on-disk reconstruction**:
  1. The backup's `/safekeeper` prefix holds the **real offloaded WAL segments**.
     Seed the fresh safekeeper PVC with those segments plus a **crafted
     `safekeeper.control`** — a small binary struct (magic `0xcafeceef`, format v9,
     **CRC32C** trailer) written by `deploy/skctl.py` (format reverse-engineered from
     a live safekeeper; the serializer round-trips a real control file
     byte-identically). The safekeeper then reports the correct `flush_lsn`.
  2. First read-write attempt *still* failed — root cause was the **basebackup
     emitting `prev LSN 0/0`**: the pageserver loses `prev_record_lsn` on a cold load
     from remote storage. Fix: seed the safekeeper a couple of segments **past** the
     pageserver's `last_record_lsn` (Y); the pageserver streams the real WAL delta
     `Y→Z` and **re-derives `prev_record_lsn`**.
  3. Re-seed the safekeeper **truncated at exactly Z** (`flush == commit == Z ==`
     pageserver `last_record`), keep the pageserver up so the re-derived prev
     persists, then boot the compute as a **plain PRIMARY** (no `Static` mode). It
     basebackups at Z with a valid prev and comes up **read-write**.
  The drill asserts an INSERT then **survives a compute kill + fresh re-basebackup**.
  All inputs are **disaster-available** (bucket WAL + pageserver
  `initdb_lsn`/`last_record_lsn` + `system_id`/`pg_version`/`wal_seg_size` read from
  the read-only compute) — **no surviving safekeeper is required**.
- **Upgrade carrot.** A newer neon release ships a first-class **safekeeper timeline
  import / HTTP timeline-create** (the `POST /v1/tenant/<t>/timeline/<tl>` this 8464
  build 404s) and a **storage controller** to drive promotion — adopting it would
  replace the on-disk `skctl.py` craft with an API call. Until then, the on-disk
  re-seed above is the working, automated path on 8464 OSS.

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

### Bounding safekeeper WAL growth — `wal-janitor` (issue #19)

**The problem.** Every restore/failover drill fills ~360 MB of WAL through the
live compute. The safekeepers offload that WAL to the bucket's `/safekeeper`
prefix as their durability backup, and **nothing trimmed it**: the bucket
lifecycle policy ages out only non-current *versions* (not current
accumulation), and neon's pageserver **GC does not touch safekeeper WAL at all**
— `gc_horizon` / `pitr_interval` govern only pageserver *layer* reclamation. So
`/safekeeper` grew unbounded (measured **~5.6 GB / ~360 × 16 MiB segments** on the
live bucket), and since a restore re-downloads the whole `neon` bucket twice
across the internet, that bloat directly inflated restore RTO.

**What GC actually reclaims (and does not).** Neon 8464 `PUT
:9898/v1/tenant/<t>/timeline/<tl>/do_gc` returns `200` but reclaims only
pageserver layer files older than `max(gc_horizon, pitr_interval)`. With a 7-day
PITR window and data younger than 7 days it reclaims **nothing**, and it never
has any notion of the `/safekeeper` prefix. GC is therefore **not** a tool for
this problem — an explicit janitor is required.

**What is safe to prune.** A safekeeper WAL segment is dead weight once it is
**both**:
1. **below the pageserver's `remote_consistent_lsn`** — the honesty-rule LSN,
   meaning the WAL is already ingested *and* uploaded into pageserver layers, so
   no pageserver will ever re-stream it; **and**
2. **outside the window the writable restore re-seeds.** `deploy/_restore-writable.sh`
   reads only a handful of segments around `last_record_lsn`
   (`[last_record − 2 seg .. + ~1 seg]`) to reconstruct the safekeeper. We keep a
   **`KEEP_SEGMENTS` safety horizon (default 32 = 512 MiB) below
   `remote_consistent_lsn`** — 8× the ~4 segments the restore actually needs and
   2× the 256 MB `checkpoint_distance`.

Everything **at or above** the horizon, and **every `.partial` segment** (the
live tail the safekeepers are still writing), is **never** touched. Pruning is
purely LSN/segment based — it does **not** key off the PITR *time* window,
because point-in-time reads are served from retained **pageserver layers**, not
from raw safekeeper WAL.

**The janitor.** A sibling `wal-janitor` CronJob in `deploy/62-backup.yaml` runs
daily at **02:30** (30 min before the 03:00 backup, so the next `mc mirror
--remove` propagates the trim to the OCI copy the same night):
1. an initContainer reads `remote_consistent_lsn` from the pageserver and writes
   the threshold segment name (`segno(rcl) − KEEP_SEGMENTS`, as a 24-hex WAL
   filename) — **fail-closed**: if `remote_consistent_lsn` can't be read the job
   aborts and prunes nothing;
2. the `mc` container deletes only complete 16 MiB segment objects whose 24-hex
   name sorts *strictly before* the threshold (fixed-width hex sorts in LSN
   order), keeping the tail + all partials.

Run it on demand (and preview first with `DRY_RUN`):

```
# supervised preview — list what WOULD be pruned, delete nothing. Patch the
# CronJob env first (patching a running Job's pod template has no effect), then
# create a Job from it.
kubectl -n scale-zero-pg set env cronjob/wal-janitor --containers=prune DRY_RUN=true
kubectl -n scale-zero-pg create job wal-janitor-preview --from=cronjob/wal-janitor
kubectl -n scale-zero-pg logs job/wal-janitor-preview --all-containers   # inspect the range + count
kubectl -n scale-zero-pg set env cronjob/wal-janitor --containers=prune DRY_RUN=false  # restore default

# real prune (the shipped default, DRY_RUN=false)
kubectl -n scale-zero-pg create job wal-janitor-now --from=cronjob/wal-janitor
kubectl -n scale-zero-pg logs job/wal-janitor-now --all-containers
```

A supervised live prune on 2026-07-03 reclaimed **325 of 357 segments (~5.2 GB;
`/safekeeper` 5.6 GB → 534 MB)**, keeping 32 segments + 3 partials, with live
reads/writes verified healthy immediately after. Tune the horizon by editing
`KEEP_SEGMENTS` on the `resolve-horizon` initContainer.

## Pageserver failover

The single pageserver is the MVP's read authority — lose it and reads stall (writes
still reach the safekeeper quorum). The reviews flagged this as an *unbounded* read
outage. It is now **automatic**: a standing warm-Secondary standby plus the
`pswatcher` controller promote-and-flip on primary-down, no human step. Manifests:
`deploy/57-pageserver-standby.yaml` (standby + generation ledger),
`deploy/58-pswatcher.yaml` (watcher). Rehearsal: `deploy/_verify-pageserver-failover.sh`.

### The components

- **Standby pageserver (`pageserver-standby`, 57).** A second StatefulSet, distinct
  node identity (`id=1235` vs the primary's `1234`), **same bucket + broker**. Its
  init Job registers a **warm Secondary** location for the live tenant
  (`location_config` `mode:"Secondary"`, `secondary_conf.warm:true`) so it
  pre-downloads layers from MinIO without serving — a promotion is a fast re-attach,
  not a cold restore.
- **Generation ledger (`pageserver-generation` ConfigMap).** Holds the last generation
  the tenant was attached at (seed `1`, matching `storage-init`). Each failover reads
  it, promotes at **value+1**, and writes the new value back — so repeated failovers
  stay monotonic and a restarted watcher never re-uses a stale generation.
- **Stable liveness handle (`pageserver-primary` Service).** Always selects the primary
  STS, so the watcher probes the *primary's* health even after it flips the
  client-facing `pageserver` Service.
- **The watcher (`pswatcher`, 58).** Polls `pageserver-primary:9898/v1/status`
  (`PSW_POLL_MS`, default 2 s). After `PSW_FAIL_THRESHOLD` consecutive misses
  (default 3 ≈ 6 s — long enough not to split-brain a slow primary) it runs the same
  runbook the restore drill proved, in order:
  1. **Promote** the standby to `AttachedSingle` at **generation+1** — the higher
     generation fences the dead primary (single-writer is intrinsic to Neon; the
     pageserver picks the newest `index_part.json-<gen>` ≤ its own).
  2. **Persist** the advanced generation in the ledger ConfigMap.
  3. **Flip** the `pageserver` Service selector to the standby, so the compute's
     unchanged `neon.pageserver_connstring host=pageserver` now resolves to it.
  4. **Bounce** the compute (delete its pod) so a cold wake basebackups from the
     promoted standby.
  The surviving safekeeper carries the WAL, so the standby streams forward and the DB
  stays **read-WRITE** across the failover. The watcher is single-shot per failover
  and idempotent on restart (if the `pageserver` selector already points at the
  standby it adopts that state rather than re-promoting). It exposes `/healthz` and
  `pswatcher_promotions_total` / `pswatcher_primary_up` on `:9091`; RBAC is minimal
  (services get/patch, configmaps get/update/patch, pods list/delete).
- **Measured automated RTO: 8 s on OKE** (kill → reads restored on the promoted
  standby, **no human step**) in the self-contained drill (see `docs/BENCHMARKS.md`).
  This converts the SPOF from an *unbounded* outage into a *known, small, hands-off*
  RTO — on par with the manual mechanism (~9 s) but with zero operator involvement.

### Operating it

- **Deploy:** `kubectl apply -f deploy/57-pageserver-standby.yaml -f deploy/58-pswatcher.yaml`
  (the watcher is the `/pswatcher` binary in the same gateway image). Confirm the
  standby is a warm Secondary: `kubectl -n scale-zero-pg logs job/pageserver-standby-init`.
- **Verify hands-off:** `sh deploy/_verify-pageserver-failover.sh` — stands up a
  throwaway 2-pageserver plane + the watcher, kills the primary, and asserts reads
  recover with the `pageserver` Service selector flipped **by the watcher** (proof no
  human acted) and the generation ledger advanced 1→2.
- **After a failover:** the standby is now the primary and the ledger holds the new
  generation. To restore redundancy, bring up a fresh warm Secondary (re-seed
  `pageserver-standby` against the now-primary); the watcher adopts the flipped
  selector and will not re-promote.
- **Manual fallback** (watcher down): the identical steps run by hand —
  `sh deploy/_verify-pageserver-failover.sh --manual` documents the exact commands
  (kill → `PUT location_config AttachedSingle generation+1` → flip the `pageserver`
  selector → `rollout restart deploy/compute`). Failover keeps the same safekeeper,
  so WAL continuity holds and the DB stays read-write. (The sibling **writable-restore**
  safekeeper re-seed — needed only for a full-plane rebuild from backup, where the
  safekeepers are fresh — is now also automated; see "Backup & disaster recovery".)

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
