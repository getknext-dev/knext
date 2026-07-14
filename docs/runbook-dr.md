# Runbook — Disaster recovery: restore the REAL plane into a fresh cluster

**Audience:** an on-call operator who may have never seen this repo. Every step is
copy-paste. This restores **service** (a live, queryable Postgres behind the
gateway) from the **OCI Object Storage backup** after the cluster and/or the live
`neon` bucket are lost.

> This is **not** the rehearsal drill. `deploy/_verify-restore.sh` stands up a
> throwaway `restore-drill` namespace, proves the mechanism, then **self-cleans and
> leaves the live plane untouched**. This runbook restores into the **real**
> `scale-zero-pg` namespace and **keeps** it. Read the honesty rule first.

---

## 0. Read this first — the honesty rule (what is recoverable)

A backup is trustworthy **only for data the pageserver had already uploaded to the
bucket**, i.e. `remote_consistent_lsn ≥ the write's LSN` at backup time. A restore
stands up **fresh, empty safekeepers**, so any write that lived **only** in
safekeeper WAL (not yet flushed into a pageserver layer) is **not** recoverable.
Expect to lose the last few seconds–minutes of writes before the outage. This is
intrinsic, not a bug. (See `docs/operations.md` → "The honesty rule".)

## RTO — two independent regimes

**Regime A — restore RTO (this runbook).** Dominated by **two cross-internet bucket
copies** (the backup upload, then the re-download that seeds the fresh cluster),
each scaling ~linearly with **bucket size** — so quote RTO as a *function of size*,
not a single number:

| Path | What you get | Measured (OKE `context-ckmva7v7zvq`, 2026-07-03, ~14 GiB bucket) |
|---|---|---|
| **Read-only** (STEP 5a) | queryable data, no new writes | **~893 s** (backup start → first read) |
| **Writable** (STEP 5b) | full read-write service | **~1057 s** (backup start → durable INSERT) |

(Historical series + methodology: `docs/BENCHMARKS.md`; an earlier run measured
~1045 s / ~1226 s — the spread is the two cross-internet bucket copies.) The
**read→write promotion delta is ~164 s** here and is **independent of bucket
size** (safekeeper WAL re-seed + one pageserver catch-up + PRIMARY boot). After the
issue-#19 WAL prune a 13 GiB bucket restores in a **bounded ~20 min**; the remaining
time is the **pageserver layer files** (real data + 7-day PITR), not safekeeper WAL.
On a larger bucket, extrapolate from the copy throughput you observe in STEP 3.

**Regime B — failover RTO (NOT this runbook; issue #58).** A *pageserver primary
death* on a still-healthy cluster is handled automatically by `pswatcher` promoting
the warm standby (`docs/operations.md` → "Pageserver failover") — no restore needed.
Its RTO has **two sub-regimes**, worth knowing so you don't invoke this runbook
unnecessarily:
- **Pod-process death:** the kubelet marks the pod `NotReady` quickly, so promotion
  fires at `FailThreshold × interval` ≈ **~8 s**.
- **Node-level death / partition:** the API-server vantage keeps serving the pod's
  last-known `Ready` status until the **node lease** expires
  (`node-monitor-grace-period`, default **~40 s**); promotion is intentionally
  **held** until then to avoid burning the only standby on a transient partition. So
  a node failure's RTO is bounded by the grace period, not the probe threshold.

Reach for **this** runbook only when the plane/bucket is actually lost, not for a
single pageserver pod/node death (that self-heals via Regime B).

---

## 1. Preconditions

- `kubectl` is pointed at the **new/target** cluster and namespace does not yet hold
  a storage plane. Confirm: `kubectl config current-context`.
- You have this repo checked out (`deploy/` manifests).
- You have the **OCI Object Storage backup credentials** — the same four values the
  backup CronJob wrote with: `endpoint`, `access`, `secret`, `bucket`
  (e.g. `ks-pg-backup`). These read the backup; they are the `backup-s3-target`
  Secret's contents.
- `mc` (MinIO client) available locally, or use the in-cluster `minio/mc` image as
  the examples do.

Set shell vars used throughout:

```sh
NS=scale-zero-pg
TENANT=f000f000f000f000f000f000f000f001       # fixed platform tenant id
TIMELINE=f000f000f000f000f000f000f000f002      # fixed platform timeline id
BK_ENDPOINT=https://<osnamespace>.compat.objectstorage.<region>.oraclecloud.com
BK_ACCESS=<access>; BK_SECRET=<secret>; BK_BUCKET=ks-pg-backup
mc alias set bak "$BK_ENDPOINT" "$BK_ACCESS" "$BK_SECRET" --api S3v4 --path on
mc ls "bak/$BK_BUCKET/neon" && mc ls "bak/$BK_BUCKET/neon-config"   # sanity: backup present
```

## 2. Namespace + secrets (fresh credentials — NOT from the backup)

```sh
kubectl apply -f deploy/00-namespace.yaml
# storage-s3-creds is the MinIO ROOT credential — MINT A FRESH ONE (issue #28: the
# backup never held it). backup-s3-target lets the restore read the OCI backup.
BACKUP_S3_ENDPOINT="$BK_ENDPOINT" BACKUP_S3_ACCESS="$BK_ACCESS" \
BACKUP_S3_SECRET="$BK_SECRET" BACKUP_S3_BUCKET="$BK_BUCKET" \
  sh deploy/gen-secrets.sh
```

## 3. Recover config + seed a fresh in-cluster MinIO from the backup (RTO-dominant)

```sh
# 3a. recover the config the bucket alone cannot rebuild (ConfigMaps only):
mc cat "bak/$BK_BUCKET/neon-config/configmaps.yaml" | kubectl -n $NS apply -f -
kubectl -n $NS get cm compute-config compute-files pageserver-config   # expect all three

# 3b. stand up an EMPTY in-cluster MinIO, then mirror the backup into it. This
#     cross-internet re-download is the bulk of the RTO (scales with bucket size).
kubectl -n $NS apply -f deploy/50-minio.yaml
kubectl -n $NS rollout status deploy/minio --timeout=300s
kubectl -n $NS run mc-seed --restart=Never --image=minio/mc:RELEASE.2023-01-28T20-29-38Z \
  --env=BK_ENDPOINT="$BK_ENDPOINT" --env=BK_ACCESS="$BK_ACCESS" --env=BK_SECRET="$BK_SECRET" --env=BK_BUCKET="$BK_BUCKET" \
  --env=U="$(kubectl -n $NS get secret storage-s3-creds -o jsonpath='{.data.user}' | base64 -d)" \
  --env=P="$(kubectl -n $NS get secret storage-s3-creds -o jsonpath='{.data.password}' | base64 -d)" \
  --command -- /bin/sh -c '
    export HOME=/tmp
    mc alias set bak "$BK_ENDPOINT" "$BK_ACCESS" "$BK_SECRET" --api S3v4 --path on
    mc alias set dst http://minio:9000 "$U" "$P"
    mc mb --ignore-existing dst/neon
    n=0; until mc mirror --overwrite "bak/$BK_BUCKET/neon" dst/neon; do n=$((n+1)); [ $n -gt 6 ] && exit 1; echo retry $n; sleep 5; done
    echo SEED_DONE'
kubectl -n $NS logs -f pod/mc-seed        # wait for SEED_DONE (can be many minutes)
kubectl -n $NS delete pod mc-seed
```

## 4. Storage plane + re-attach at **generation + 1**

```sh
kubectl -n $NS apply -f deploy/51-storage-broker.yaml -f deploy/52-safekeeper.yaml -f deploy/53-pageserver.yaml
kubectl -n $NS rollout status sts/pageserver --timeout=300s
```

**Generation + 1 rule (critical).** The pageserver selects the newest
`index_part.json-<gen>` whose generation ≤ its own, then writes forward at its
generation. Re-attaching at the **same** generation risks overwriting the index;
**lower** would not see the latest data. So read the highest generation present in
the backup and re-attach one above it:

```sh
GEN=$(mc ls "bak/$BK_BUCKET/neon/pageserver/tenants/$TENANT/timelines/$TIMELINE/" \
      | grep -o 'index_part.json-[0-9]*' | sed 's/.*-//' | sort -n | tail -1)
NEXT=$((GEN + 1))
echo "backup index at generation $GEN -> re-attaching at $NEXT"
kubectl -n $NS exec sts/pageserver -- curl -sf -X PUT \
  "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE/location_config" \
  -H 'Content-Type: application/json' \
  -d "{\"mode\":\"AttachedSingle\",\"generation\":$NEXT,\"tenant_conf\":{}}"
# record the advance so a later failover stays monotonic:
kubectl -n $NS create configmap pageserver-generation --from-literal=generation=$NEXT \
  --dry-run=client -o yaml | kubectl -n $NS apply -f -
# confirm the pageserver caught up:
kubectl -n $NS exec sts/pageserver -- curl -s \
  "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" | tr ',' '\n' | grep -E 'last_record_lsn|remote_consistent_lsn'
```

## 5. Decision point — read-only vs writable

**Is read-only enough?** If you only need to *read* the data (export it, point a
read replica at it, verify), STOP at 5a — it is the fastest, always-safe path and
needs no safekeepers. If you must resume **writes** (return the app to service), do
5b.

### 5a. Read-only (always-safe, minimum RTO)

Boot a **STATIC** compute pinned to the pageserver's `last_record_lsn` — it reads
pages directly from the pageserver, no safekeeper WAL continuity required:

```sh
LSN=$(kubectl -n $NS exec sts/pageserver -- curl -s \
  "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" | tr ',' '\n' | grep last_record_lsn | cut -d'"' -f4)
# apply the compute Deployment, then set static mode to $LSN (spec.mode={"Static":"<lsn>"})
kubectl -n $NS apply -f deploy/20-compute.yaml
# edit compute spec.mode to {"Static":"$LSN"} (compute-files config), scale to 1, verify:
kubectl -n $NS scale deploy/compute --replicas=1 && kubectl -n $NS rollout status deploy/compute --timeout=300s
kubectl -n $NS exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc '\dt'
```

### 5b. Writable promotion (adds the ~181 s, size-independent delta)

`deploy/_restore-writable.sh` re-seeds the fresh safekeeper on disk (real offloaded
WAL segments + a crafted `safekeeper.control`) so a **plain PRIMARY** compute boots
read-write on `neon:8464` (no safekeeper HTTP timeline-create exists on 8464 OSS —
this is the on-disk mechanism). Run it against the restored namespace, then boot a
PRIMARY:

```sh
# point the script at the REAL namespace (it defaults to the drill ns):
DRILL_NS=$NS TENANT=$TENANT TIMELINE=$TIMELINE sh deploy/_restore-writable.sh
# then boot compute as a plain PRIMARY (no Static mode) and verify a write:
kubectl -n $NS scale deploy/compute --replicas=1 && kubectl -n $NS rollout status deploy/compute --timeout=300s
kubectl -n $NS exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc \
  "create table if not exists dr_check(t timestamptz default now()); insert into dr_check default values; select count(*) from dr_check;"
```

## 6. Cut the gateway over + resume scale-to-zero

```sh
kubectl -n $NS apply -f deploy/10-gateway.yaml    # digest-pinned image (issue #56)
kubectl -n $NS rollout status deploy/pggw
kubectl -n $NS apply -f deploy/30-knext-secret.yaml   # DATABASE_URL points at the gateway
# once verified, let it sleep again:
kubectl -n $NS scale deploy/compute --replicas=0
```

## 7. Verification (proof of service)

- Data present: `psql ... -c '\dt'` and a `SELECT` against a known table.
- Durability advancing (writable): `remote_consistent_lsn` climbs on
  `GET :9898/v1/tenant/$TENANT/timeline/$TIMELINE` after writes.
- Wake path: `psql` through the gateway on a cold compute wakes it (watch
  `kubectl -n $NS get pods -l app=compute -w`).
- Run `sh deploy/_verify-drift.sh` — every workload present, healthy, and running
  the **pinned image digest**.

## 8. Rollback / retry a failed restore

Because you re-attached at **generation + 1** (STEP 4), the backup's gen-`$GEN`
index and layers are **untouched** — a bad attempt is safe to discard and retry:

```sh
kubectl delete ns $NS --wait=true      # tears down the failed attempt
# then restart from STEP 2; STEP 4 will compute a fresh NEXT = highest-gen + 1.
```

If the backup itself is suspect (e.g. a `--remove`-propagated deletion emptied the
current versions — see `docs/operations.md` → "Retention/pruning + deletion-
propagation risk"), recover a **prior object version** from the versioned bucket
before re-seeding:

```sh
oci --profile DEFAULT os object list-object-versions -ns <osnamespace> \
    -bn "$BK_BUCKET" --prefix "neon/pageserver/tenants/$TENANT/timelines/$TIMELINE/"
# restore/re-copy the wanted version, then re-run STEP 3b.
```

## 9. Multi-tenant (branch-per-app) restore (ADR-0003)

Sections 1–8 restore the **fixed platform tenant** (`TENANT=f000…001` /
`TIMELINE=f000…002`). v0.6.0 shipped **branch-per-app** multi-tenancy: N apps are
Neon **branches** — each its own timeline — living under a **separate apps tenant**
`a0000000000000000000000000000001`, sharing ONE storage plane and ONE backup bucket
(see `docs/adr-0003-multi-tenancy.md`). What DR can and cannot do for those apps is
different from the single-tenant case; read this before you promise anyone a
per-app rollback.

**9a. Finding an app's timeline id.** Each app's branch is a distinct timeline under
the apps tenant. To locate a given app's id:

```sh
APPS_TENANT=a0000000000000000000000000000001
# (a) LIVE app — its ConfigMap holds the id:
kubectl -n $NS get cm compute-config-<app> -o jsonpath='{.data.TIMELINE_ID}'
# (b) DEPROVISIONED app — its ConfigMap is gone; the bucket prefix is the record:
mc ls "bak/$BK_BUCKET/neon/safekeeper/$APPS_TENANT/"
mc ls "bak/$BK_BUCKET/neon/pageserver/tenants/$APPS_TENANT/timelines/"
```

`provision-app.sh` also prints the minted timeline id at creation time. Note the
honesty: once an app is deprovisioned its `compute-config-<app>` ConfigMap no longer
exists, so the **bucket prefix is the only surviving record** of its timeline id.

**9b. Restore ONE app vs the whole apps plane — the attach is TENANT-level.** The
`generation + 1` re-attach in STEP 4 is a **`location_config` on the whole tenant**,
not on one timeline. Re-attaching the apps tenant `a0000000000000000000000000000001`
at gen+1 therefore covers **all app branches on that tenant at once** — one attach,
not one per app:

```sh
# same STEP 4 mechanism, retargeted at the apps tenant (all its branches ride along):
GEN=$(mc ls "bak/$BK_BUCKET/neon/pageserver/tenants/$APPS_TENANT/timelines/<app-timeline>/" \
      | grep -o 'index_part.json-[0-9]*' | sed 's/.*-//' | sort -n | tail -1)
NEXT=$((GEN + 1))
kubectl -n $NS exec sts/pageserver -- curl -sf -X PUT \
  "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline/<app-timeline>/location_config" \
  -H 'Content-Type: application/json' \
  -d "{\"mode\":\"AttachedSingle\",\"generation\":$NEXT,\"tenant_conf\":{}}"
```

A truly **per-branch** restore — roll ONE app back to a point-in-time without
touching its peers — is **NOT offered by this MVP**. Branches share the tenant's
single backup history in one bucket; there is **no per-branch PITR**. State that
plainly to anyone asking for it.

**9c. Blast radius — DR is all-or-nothing across the bucket's restore point.** A
full-plane (bucket) restore returns **every tenant AND every app branch to the SAME
backup point-in-time** — one shared bucket, one shared backup schedule. Per-app /
per-tenant PITR granularity is **not available**. You cannot restore app-A to
10:00 while leaving app-B at 12:00; the bucket's restore point applies to all. Know
this before 3am.

**9d. What a per-app restore CAN and CAN'T do (pg 8464) — EXECUTED, not asserted.**
This section is backed by a real, repeatable drill: `deploy/_verify-app-restore.sh`
provisions two real apps (a victim + an untouched peer), writes marker rows, backs the
whole `neon` bucket up off-cluster to OCI OS, **destroys the victim's compute AND its
branch state** (pageserver timeline + all safekeeper WAL), then restores THAT branch in
a throwaway namespace and proves it read-only, then writable, then durable — measuring
RTO and asserting isolation at each step. Run it yourself:
`KSPG_CONTEXT=context-ckmva7v7zvq sh deploy/_verify-app-restore.sh`.

- **CAN — read-only:** bring a single app's branch back to a **queryable** state. A
  STATIC compute pinned to the restored pageserver LSN reads the branch's pages with no
  safekeepers. Executed RTO **962 s** (backup start → first branch read, ~14 GiB bucket,
  OKE `context-ckmva7v7zvq`, 2026-07-04) — the same size-dominated regime as the platform
  tenant.
- **CAN — writable:** promote that branch to a read-**write** primary that survives a
  compute kill. **This corrects an earlier assumption.** The branch-per-app "walproposer
  auto-init, no `skctl` craft" property (`docs/adr-0003-multi-tenancy.md`) holds ONLY for
  **live** branching (live pageserver + live safekeepers). On a **COLD restore** a branch
  behaves **exactly like the platform tenant**: the fresh drill safekeeper reports
  `flush_lsn 0/0`, so a plain PRIMARY aborts with *"cannot start in read-write mode from
  this base backup"*. The writable path therefore needs the **same on-disk safekeeper WAL
  re-seed** (`deploy/_restore-writable.sh`: real `/safekeeper` WAL segments + a crafted
  `safekeeper.control`, pageserver re-derives `prev_record_lsn`), retargeted at the apps
  tenant + the branch timeline. Executed RTO **1210 s** (backup start → durable branch
  INSERT; **promotion delta ≈ 248 s** over read-only, bucket-size-independent): pageserver
  streamed the branch delta, re-derived `prev_record_lsn`, PHASE 2 aligned, PRIMARY booted
  read-WRITE, and an INSERT **survived a compute kill + fresh re-basebackup**.
- **CAN'T — per-branch PITR:** independently **rewind one branch to an earlier
  point-in-time** than the shared bucket restore point (9b/9c). There is **no per-branch
  backup history** — one bucket, one schedule, one restore point for every branch.

**9d-bis. THE ANCESTOR-DURABILITY DEPENDENCY (the sharpest per-branch limitation).**
A branch is not self-contained: its basebackup reads every **unmodified** page from its
**ANCESTOR** — the shared template timeline — at the branch's `ancestor_lsn`. A cold
restore can only materialize those pages if the **template's** layers up to that LSN are
in the bucket, i.e. the **template's `remote_consistent_lsn` ≥ the branch's
`ancestor_lsn`** at backup time. But `provision-app.sh` branches at the template's
`last_record_lsn`, which runs **ahead** of the template's `remote_consistent_lsn` by the
un-flushed WAL tail. So:

- **Risk window.** In the seconds-to-minutes **right after provisioning a new app**, the
  template tail that the branch depends on may not yet be uploaded. A disaster in that
  window leaves the branch **un-cold-restorable** — the restored pageserver blocks
  forever *"waiting for WAL record … to arrive"* on the ancestor. The drill reproduced
  this exactly and now **gates** on ancestor durability before backup (waits for the
  template `remote_consistent_lsn` to cover the branch point).
- **Why it self-heals normally.** On an idle/settled template the pageserver's periodic
  layer upload catches `remote_consistent_lsn` up to `last_record_lsn` within a few
  minutes, after which every existing branch point is covered. In steady state this is a
  non-issue; it only bites the freshly-cut branch.
- **Mitigation feasibility on 8464.** A *forced* template checkpoint/upload at provision
  time would shrink the window to ~zero, but the pageserver's force-checkpoint API is
  **compiled out** on `neon:8464` (`PUT …/checkpoint` → *"pageserver was compiled without
  testing APIs"*). The only levers on 8464 are **WAL-driven** (push enough template WAL
  to cross `checkpoint_distance`) or **time** (wait for the periodic upload). The window
  cannot yet be *closed* on 8464, but it is no longer *invisible*: **do not promise a cold
  restore of an app in the first few minutes of its life** until the template tail has
  flushed. (A first-class safekeeper/timeline-import API in a future neon bump — the ops
  "upgrade carrot" — would remove this entirely.)
- **SHIPPED observability (issue #206).** The AppDatabase operator now surfaces this
  window as a first-class, machine-readable status condition **`ColdRestorable`** on every
  app: `True`/`AncestorDurable` once the template `remote_consistent_lsn` ≥ the branch's
  `ancestorLsn` (persisted in `.status.ancestorLsn`), `False`/`AncestorWALNotYetDurable`
  during the window (the operator requeues and it self-heals in minutes), `Unknown` on a
  transient pageserver read error. It does **not** delay `Ready` — the app is fully usable
  while `False`; the property is monotonic, so the operator stops polling once `True`.
  `.status.ancestorLsn` is persisted at operator-branch time and, for a branch the operator
  merely **adopts** (created by `provision-app.sh`, pre-dating the field, or a crash between
  branch and status write), **back-filled** from the branch's own pageserver `ancestor_lsn`
  on the next reconcile (issue #209) — so cold-restorability covers **every** app, not only
  ones the operator freshly branched. This turns "which apps are cold-restorable right now?"
  from a disaster-time discovery into a `kubectl get appdatabase`-visible, alertable signal:
  `kubectl get appdatabase <app> -o jsonpath='{.status.conditions[?(@.type=="ColdRestorable")].status}'`.

- **CAN — isolation (proven both directions):** destroying/​restoring one app does **not**
  touch its peers. On the live plane the drill destroys the victim's branch and asserts
  the **peer branch + its data are untouched**; in the restored drill it asserts the
  peer's marker is **not visible** through the victim branch (branch/timeline-scoped).

Per-app branch WAL/backup coverage bears directly on what is recoverable here: the
`wal-janitor` now iterates **all** tenants (primary + apps) per issue **#77** — a
sleeping app's WAL is retained, and an apps-tenant timeline whose
`remote_consistent_lsn` cannot be resolved is **fail-safe SKIPPED and WARNed**, not
pruned. So a deprovisioned app can leave orphaned safekeeper WAL prefixes under
`neon/safekeeper/$APPS_TENANT/`; those prefixes (9a) are what you enumerate to know
which branches a bucket restore would actually bring back.

---

### Provenance of this runbook

Every command shape here is one `deploy/_verify-restore.sh` +
`deploy/_restore-writable.sh` exercise on **every** drill run (proven repeatedly on
OKE, context `context-ckmva7v7zvq`); this runbook re-targets them from the throwaway
`restore-drill` namespace to the real `scale-zero-pg` namespace and keeps the
result. Where the drill and this runbook differ is only the namespace and the
"keep, don't self-clean" ending — the mechanism (config recover → seed MinIO from
OCI OS → re-attach at generation+1 → static read / on-disk writable re-seed) is
identical and drill-verified. The RTO figures come from `docs/BENCHMARKS.md`;
`docs/operations.md` → "Backup & disaster recovery" has the mechanism deep-dive.

> **Validation status (2026-07-03, OKE `context-ckmva7v7zvq`):** verified live. A
> full `_verify-restore.sh` run executed this runbook's mechanism end-to-end — config
> recovered from OCI OS, a fresh MinIO seeded from the ~14 GiB backup, the tenant
> **re-attached at generation 2** (gen+1), and the marker row **READ BACK** through a
> **static read-only compute** (STEP 5a, read-only RTO **893 s**); the writable
> promotion (STEP 5b) then passed and the write **survived a compute kill +
> re-basebackup** (writable RTO **1057 s**). The drill re-targets these same commands
> to a throwaway namespace and self-cleans; this runbook re-targets them to the real
> `scale-zero-pg` namespace and keeps the result.
>
> **Per-app (branch) validation status (2026-07-04, OKE `context-ckmva7v7zvq`):** §9d /
> §9d-bis are EXECUTED, not asserted. `deploy/_verify-app-restore.sh` provisioned two real
> apps, backed the bucket up off-cluster, **destroyed the victim app's branch state**
> (compute + pageserver timeline + all safekeeper WAL), then restored THAT branch in a
> throwaway `app-restore-drill` namespace: apps tenant re-attached at **gen 2**, victim
> branch + template ancestor loaded, marker **READ BACK** via a STATIC compute
> (read-only RTO **962 s**), the writable promotion took the **`skctl` craft path** (the
> LIGHT walproposer-auto-init path was tried and empirically fell through — a cold branch
> behaves like the platform tenant), and the INSERT **survived a compute kill +
> re-basebackup** (writable RTO **1210 s**). Isolation held both directions (peer branch
> untouched on the live plane; peer marker invisible through the restored victim branch).
> The drill self-cleans (throwaway ns + both drill apps) and gates on **ancestor
> durability** first (§9d-bis).
