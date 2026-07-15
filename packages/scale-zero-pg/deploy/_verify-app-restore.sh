#!/bin/sh
# _verify-app-restore.sh — the rehearsed PER-APP (branch-per-app) disaster-recovery
# drill for GA criterion #97. Where deploy/_verify-restore.sh proves the FIXED
# PLATFORM tenant restores, this proves the same for a SINGLE APP's Neon BRANCH
# (its own timeline under the shared apps tenant, ADR-0003) — provisioned for real,
# lost for real, restored WRITABLE for real, with the blast radius measured.
#
# It answers the question the runbook §9 could only assert on paper: can you bring
# ONE app back from the off-cluster backup, and what does the branch-per-app
# "walproposer auto-init" finding actually mean for restore vs the primary tenant?
#
# THE DRILL (end to end, honest):
#   A. PROVISION two REAL apps on the LIVE plane (provision-app.sh): the VICTIM we
#      will destroy+restore, and a PEER we never touch (the isolation control).
#      Write a uniquely-tagged marker row into each app's branch, then push WAL on
#      the victim branch until the pageserver has UPLOADED that marker LSN to the
#      object store (apps-tenant/victim-timeline remote_consistent_lsn >= marker).
#      That upload gate is what makes the per-app backup HONEST.
#   B. BACK UP off-cluster: run deploy/62-backup.yaml — mirror the whole `neon`
#      bucket (both tenants, every branch) + config to OCI Object Storage. RTO clock
#      starts at backup start.
#   C. SIMULATE LOSS of the victim ONLY: provision-app.sh destroy <victim> deletes
#      its compute AND its branch state (pageserver timeline + all safekeeper WAL).
#      Assert the victim branch is GONE from the live pageserver, and the PEER
#      branch + its data are UNTOUCHED (isolation on the live plane).
#   D. RESTORE the victim branch in a THROWAWAY namespace `app-restore-drill`: fresh
#      storage plane seeded from the OCI backup, re-attach the APPS tenant at gen+1
#      (one attach covers all its branches), load the victim branch + its template
#      ancestor from the restored bucket, then:
#        - STATIC read-only compute on the victim branch -> read the marker (RTO_ro).
#        - WRITABLE promotion: try the LIGHT path first (boot the app compute as a
#          plain PRIMARY; the branch's walproposer auto-inits the fresh drill
#          safekeeper — the branch-per-app finding). Only if that aborts with
#          "cannot start in read-write mode from this base backup" fall back to the
#          primary-tenant mechanism deploy/_restore-writable.sh (skctl craft),
#          retargeted at the apps tenant/branch. RECORD which path was needed —
#          that IS the finding. Prove the write survives a compute kill (RTO_rw).
#   E. Report RTO + the 8464 per-branch CEILING (what a per-branch restore CAN'T do),
#      then self-clean: delete the drill ns AND destroy the victim+peer apps on the
#      live plane (leaving it exactly as found — no apps).
#
# Idempotent and self-cleaning (trap). Bounded kubectl calls (--request-timeout).
# Owns ONLY: namespace app-restore-drill + the two drill apps it creates on the live
# plane (unique, timestamped names). KSPG_CONTEXT-guarded like every drill.
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
KUBECTL="${KUBECTL:-kubectl}"
RT="--request-timeout=60s"

SRC_NS="${SRC_NS:-scale-zero-pg}"
DRILL_NS="${DRILL_NS:-app-restore-drill}"
# Branch-per-app lives under the apps tenant (ADR-0003), NOT the platform tenant.
APPS_TENANT="${APPS_TENANT:-a0000000000000000000000000000001}"
TEMPLATE_TL="${TEMPLATE_TL:-a0000000000000000000000000000010}"
# Re-attach the apps tenant one generation above what the backup holds. The live
# apps tenant is attached at generation 1 by provision-app.sh (ensure_tenant), so
# every apps-tenant index in the backup is gen 1; gen 2 reads it and writes forward.
DRILL_GEN="${DRILL_GEN:-2}"
IMG_NEON=neondatabase/neon:8464
IMG_COMPUTE=neondatabase/compute-node-v17:8464
IMG_MC=minio/mc:RELEASE.2023-01-28T20-29-38Z
DRILL_MINIO_STORAGE="${DRILL_MINIO_STORAGE:-12Gi}"
DRILL_STORAGE="${DRILL_STORAGE:-6Gi}"

HERE="$(dirname "$0")"
PROVISION="$HERE/provision-app.sh"
COMPUTE_FILES_SRC="$HERE/54-compute-files.yaml"
COMPUTE_APP_TMPL="$HERE/compute-app.template.yaml"
WRITABLE_HELPER="$HERE/_restore-writable.sh"

K="$KUBECTL -n $SRC_NS $RT"
KD="$KUBECTL -n $DRILL_NS $RT"

STAMP="$$"                                    # pid; date is only used for marker text
VICTIM="${VICTIM:-rv$STAMP}"                  # RFC1123 label, <=63, no leading digit issues (starts 'rv')
PEER="${PEER:-rp$STAMP}"
MARKER_NOTE="app-restore drill marker; must survive a full per-app branch restore"
PEER_NOTE="peer app marker; MUST be untouched by the victim destroy and restore"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }
info() { echo ">> $*"; }

VICTIM_TL=""      # resolved after provision
PEER_TL=""
CLEAN_APPS=1      # destroy the drill apps on exit

cleanup() {
  code=$?
  if [ "${KEEP_DRILL:-0}" = "1" ]; then
    info "cleanup: KEEP_DRILL=1 — leaving ns $DRILL_NS + apps $VICTIM/$PEER up for inspection"
    exit $code
  fi
  info "cleanup: deleting throwaway namespace $DRILL_NS"
  $KUBECTL delete ns "$DRILL_NS" --wait=false --ignore-not-found $RT >/dev/null 2>&1 || true
  if [ "$CLEAN_APPS" = "1" ]; then
    info "cleanup: destroying drill apps on the live plane ($VICTIM, $PEER) — leaving it as found"
    sh "$PROVISION" destroy "$VICTIM" >/dev/null 2>&1 || true
    sh "$PROVISION" destroy "$PEER"   >/dev/null 2>&1 || true
    # If a mid-run failure left the borrowed template compute up (ancestor-durability
    # gate), drop the throwaway fill + park it back at 0 — leave the template as found.
    if [ "$($K get deploy compute-tmpl -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)" != "0" ]; then
      $K exec deploy/compute-tmpl -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc "drop table if exists _restore_drill_tmpl_fill" >/dev/null 2>&1 || true
      $K scale deploy/compute-tmpl --replicas=0 >/dev/null 2>&1 || true
    fi
  fi
  exit $code
}
trap cleanup EXIT INT TERM

# --- helpers ---------------------------------------------------------------
# psql into an app's compute in a given namespace (cloud_admin, local socket).
APP_PSQL()  { _ns="$1"; _app="$2"; _sql="$3"; $KUBECTL -n "$_ns" $RT exec "deploy/compute-$_app" -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$_sql"; }
# pageserver timeline field for a tenant/timeline in a namespace.
PS_TL_FIELD() { _ns="$1"; _tn="$2"; _tl="$3"; _f="$4"; $KUBECTL -n "$_ns" $RT exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$_tn/timeline/$_tl" 2>/dev/null | tr ',' '\n' | grep "\"$_f\"" | head -1 | cut -d'"' -f4; }
# does a timeline exist on the LIVE apps tenant?
LIVE_TL_EXISTS() { $K exec pageserver-0 -c pageserver -- curl -s "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline" 2>/dev/null | grep -q "$1"; }
app_timeline() { $K get configmap "compute-config-$1" -o jsonpath='{.data.TIMELINE_ID}' 2>/dev/null || true; }

command -v "$KUBECTL" >/dev/null 2>&1 || fail "kubectl not found"
[ -x "$PROVISION" ] || [ -f "$PROVISION" ] || fail "missing $PROVISION"
[ -f "$COMPUTE_FILES_SRC" ] || fail "missing $COMPUTE_FILES_SRC"
[ -f "$COMPUTE_APP_TMPL" ] || fail "missing $COMPUTE_APP_TMPL"
[ -f "$WRITABLE_HELPER" ]  || fail "missing $WRITABLE_HELPER"

# Guard: drills create/destroy namespaces + branches — never the wrong cluster.
EXPECTED_CTX="${KSPG_CONTEXT:-context-ckmva7v7zvq}"
[ "$($KUBECTL config current-context 2>/dev/null)" = "$EXPECTED_CTX" ] || fail "expected kube-context '$EXPECTED_CTX' (set KSPG_CONTEXT to override)"

# ---------------------------------------------------------------------------
info "STEP 0: preflight — live storage plane + apps template healthy"
for s in pageserver safekeeper; do
  $K rollout status statefulset/$s --timeout=120s >/dev/null || fail "sts/$s not ready"
done
$K rollout status deploy/minio --timeout=120s >/dev/null || fail "minio not ready"
LIVE_TL_EXISTS "$TEMPLATE_TL" || fail "apps template timeline $TEMPLATE_TL missing on the live plane — run: deploy/provision-app.sh init-plane"
$K get secret backup-s3-target >/dev/null 2>&1 || fail "Secret backup-s3-target missing (OCI backup target) — see docs/operations.md 'Backup & disaster recovery'"
ok "live plane ready; apps template present; off-cluster backup target configured"

# ---------------------------------------------------------------------------
info "STEP 1: provision two REAL apps on the live plane — victim '$VICTIM' + peer '$PEER'"
sh "$PROVISION" create "$VICTIM" --replicas 1 >/dev/null || fail "provision victim failed"
sh "$PROVISION" create "$PEER"   --replicas 1 >/dev/null || fail "provision peer failed"
# Generous, Pending-tolerant waits: this drill shares a small cluster with other
# lanes' compute bursts, so a compute can sit Unschedulable (Insufficient cpu) for a
# while before a window opens. rollout status just waits through Pending.
$K rollout status "deploy/compute-$VICTIM" --timeout=420s >/dev/null || fail "victim compute did not wake (cluster CPU-starved?)"
$K rollout status "deploy/compute-$PEER"   --timeout=420s >/dev/null || fail "peer compute did not wake (cluster CPU-starved?)"
VICTIM_TL="$(app_timeline "$VICTIM")"; [ -n "$VICTIM_TL" ] || fail "could not read victim timeline id"
PEER_TL="$(app_timeline "$PEER")";     [ -n "$PEER_TL" ]   || fail "could not read peer timeline id"
ok "provisioned: victim branch $VICTIM_TL, peer branch $PEER_TL (both under apps tenant $APPS_TENANT)"

# --- ANCESTOR DURABILITY — the per-branch restore dependency (#97 finding) --------
# A branch's basebackup reads every UNMODIFIED page from its ANCESTOR (the shared
# template) at the branch's ancestor_lsn. On a COLD restore the pageserver can only
# materialize those pages if the template's layers up to that LSN are in the bucket
# (template remote_consistent_lsn >= ancestor_lsn). provision-app branches at the
# template's *last_record_lsn*, which can run AHEAD of the template's
# remote_consistent_lsn by the un-flushed tail WAL — so a JUST-branched app's ancestor
# tail may not yet be durable, and a cold branch restore then BLOCKS forever
# ("waiting for WAL record ... to arrive" on the ancestor). The pageserver's periodic
# upload catches remote up to last_record on an idle template within a few minutes; on
# a SETTLED template (remote == last_record) the branch point is already covered.
# So this is a GATE (wait for template remote >= branch ancestor_lsn), with a best-
# effort, NON-fatal nudge (wake the template compute to force a checkpoint) if it has
# not converged after ~1 min. LSNs are compared host-side so the gate needs no compute.
lsn_ge() { python3 -c "import sys
def v(s):
 h,l=s.split('/');return (int(h,16)<<32)|int(l,16)
print('1' if v(sys.argv[1])>=v(sys.argv[2]) else '0')" "$1" "$2" 2>/dev/null || echo 0; }
VICTIM_ANCESTOR_LSN="$(PS_TL_FIELD "$SRC_NS" "$APPS_TENANT" "$VICTIM_TL" ancestor_lsn)"
[ -n "$VICTIM_ANCESTOR_LSN" ] || fail "could not read victim branch ancestor_lsn"
info "  victim branch point (ancestor_lsn on template $TEMPLATE_TL) = $VICTIM_ANCESTOR_LSN"
info "  ancestor-durability gate: waiting for template remote_consistent_lsn to cover the branch point"
tup=0; forced=0; i=0
while [ $i -lt 260 ]; do          # ~13 min ceiling (periodic upload + optional nudge)
  cur="$(PS_TL_FIELD "$SRC_NS" "$APPS_TENANT" "$TEMPLATE_TL" remote_consistent_lsn || true)"
  if [ -n "$cur" ] && [ "$(lsn_ge "$cur" "$VICTIM_ANCESTOR_LSN")" = "1" ]; then tup=1; break; fi
  # After ~60s of no convergence, ONE best-effort nudge: wake the template compute and
  # force a checkpoint (WAL-drive it, since the force-checkpoint API is compiled out on
  # 8464). Fully non-fatal: if the shared cluster cannot schedule compute-tmpl we just
  # keep waiting for the pageserver's periodic upload to catch remote up to last_record.
  if [ $i -eq 20 ] && [ $forced -eq 0 ]; then
    forced=1
    info "  nudging template upload (best-effort wake of compute-tmpl; skipped if CPU-starved)"
    $K scale deploy/compute-tmpl --replicas=1 >/dev/null 2>&1 || true
    if $K rollout status deploy/compute-tmpl --timeout=90s >/dev/null 2>&1; then
      $K exec deploy/compute-tmpl -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc \
        "create table if not exists _restore_drill_tmpl_fill(id int, pad text); insert into _restore_drill_tmpl_fill select g, repeat('x',1024) from generate_series(1,300000) g; checkpoint; drop table _restore_drill_tmpl_fill; checkpoint" >/dev/null 2>&1 || true
    else
      info "  compute-tmpl could not schedule (CPU-starved) — waiting out the periodic upload instead"
    fi
    $K scale deploy/compute-tmpl --replicas=0 >/dev/null 2>&1 || true
  fi
  echo "   t=$((i*3))s template remote_consistent_lsn=$cur (need >= $VICTIM_ANCESTOR_LSN)"
  i=$((i+1)); sleep 3
done
[ "$tup" = "1" ] || fail "template ancestor never became durable past the branch point (remote_consistent_lsn < ancestor_lsn after ~13min) — a cold branch restore would block on the ancestor"
ok "ancestor durable: template remote_consistent_lsn covers the victim branch point ($VICTIM_ANCESTOR_LSN)"

MARKER_ID="av-$STAMP-$(date +%s 2>/dev/null || echo x)"
PEER_MARKER_ID="ap-$STAMP"
info "  writing marker rows into each app's branch"
APP_PSQL "$SRC_NS" "$VICTIM" "create table if not exists app_marker(id text primary key, note text, ts timestamptz default now())" >/dev/null
APP_PSQL "$SRC_NS" "$VICTIM" "insert into app_marker(id,note) values ('$MARKER_ID','$MARKER_NOTE')" >/dev/null
APP_PSQL "$SRC_NS" "$PEER"   "create table if not exists app_marker(id text primary key, note text, ts timestamptz default now())" >/dev/null
APP_PSQL "$SRC_NS" "$PEER"   "insert into app_marker(id,note) values ('$PEER_MARKER_ID','$PEER_NOTE')" >/dev/null
MARKER_LSN="$(APP_PSQL "$SRC_NS" "$VICTIM" "select pg_current_wal_flush_lsn()")"
[ -n "$MARKER_LSN" ] || fail "could not capture victim marker LSN"
ok "victim marker '$MARKER_ID' at WAL LSN $MARKER_LSN; peer marker '$PEER_MARKER_ID' written"

info "  pushing WAL on the victim branch past checkpoint_distance so the pageserver uploads the marker layer"
APP_PSQL "$SRC_NS" "$VICTIM" "create table if not exists app_fill(id int, pad text)" >/dev/null
APP_PSQL "$SRC_NS" "$VICTIM" "insert into app_fill select g, repeat('x',1024) from generate_series(1,300000) g" >/dev/null
APP_PSQL "$SRC_NS" "$VICTIM" "checkpoint" >/dev/null
info "  waiting for apps-tenant/victim-branch remote_consistent_lsn >= marker LSN (honest per-app backup gate)"
uploaded=0; i=0
while [ $i -lt 80 ]; do
  cur="$(PS_TL_FIELD "$SRC_NS" "$APPS_TENANT" "$VICTIM_TL" remote_consistent_lsn || true)"
  if [ -n "$cur" ]; then
    diff="$(APP_PSQL "$SRC_NS" "$VICTIM" "select (pg_wal_lsn_diff('$cur'::pg_lsn,'$MARKER_LSN'::pg_lsn) >= 0)" 2>/dev/null || echo f)"
    echo "   t=$((i*3))s remote_consistent_lsn=$cur uploaded=$diff"
    [ "$diff" = "t" ] && { uploaded=1; break; }
  fi
  i=$((i+1)); sleep 3
done
[ "$uploaded" = "1" ] || fail "victim branch marker LSN never uploaded to the bucket (per-app backup would be dishonest)"
ok "victim marker is durable in the object store (branch remote_consistent_lsn advanced past it)"
# park the computes; the branch state now lives in the bucket
$K scale "deploy/compute-$VICTIM" --replicas=0 >/dev/null

# ---------------------------------------------------------------------------
info "STEP 2: back up off-cluster — mirror the neon bucket (both tenants) + config to OCI Object Storage"
BACKUP_MANIFEST="$HERE/62-backup.yaml"
[ -f "$BACKUP_MANIFEST" ] || fail "backup manifest missing: $BACKUP_MANIFEST"
$K apply -f "$BACKUP_MANIFEST" >/dev/null || fail "could not apply $BACKUP_MANIFEST"

BACKUP_START=$(date +%s)                       # RTO clock starts here

BK_ENDPOINT="$($K get secret backup-s3-target -o jsonpath='{.data.endpoint}' | base64 -d)"
BK_ACCESS="$($K get secret backup-s3-target -o jsonpath='{.data.access}' | base64 -d)"
BK_SECRET="$($K get secret backup-s3-target -o jsonpath='{.data.secret}' | base64 -d)"
BK_BUCKET="$($K get secret backup-s3-target -o jsonpath='{.data.bucket}' | base64 -d)"
[ -n "$BK_ENDPOINT" ] && [ -n "$BK_BUCKET" ] || fail "backup-s3-target Secret incomplete"
# The victim branch's own pageserver index must be intact in the OFF-CLUSTER copy.
IX_PREFIX="neon/pageserver/tenants/$APPS_TENANT/timelines/$VICTIM_TL"
backup_index_intact() {
  $K delete pod mc-ixcheck --ignore-not-found >/dev/null 2>&1 || true
  out="$($K run mc-ixcheck --rm -i --restart=Never --image="$IMG_MC" \
    --env=BE="$BK_ENDPOINT" --env=BA="$BK_ACCESS" --env=BS="$BK_SECRET" --env=BB="$BK_BUCKET" --env=IX="$IX_PREFIX" \
    --command -- /bin/sh -c '
      export HOME=/tmp
      mc alias set bak "$BE" "$BA" "$BS" --api S3v4 --path on >/dev/null 2>&1 || { echo NOBAK; exit 0; }
      f=$(mc ls "bak/$BB/$IX/" 2>/dev/null | grep -o "index_part.json-[0-9]*" | sort | tail -1)
      [ -z "$f" ] && { echo NOINDEX; exit 0; }
      last=$(mc cat "bak/$BB/$IX/$f" 2>/dev/null | tail -c 1)
      [ "$last" = "}" ] && echo "INTACT $f" || echo "TORN $f"' 2>/dev/null)"
  echo "$out" | grep -q '^INTACT'
}

JOB=""; attempt=0
while [ $attempt -lt 3 ]; do
  attempt=$((attempt+1))
  JOB="app-backup-now-$(date +%s)"
  $K create job "$JOB" --from=cronjob/backup >/dev/null || fail "could not create on-demand backup Job"
  info "  backup Job $JOB running (attempt $attempt)..."
  $K wait --for=condition=complete "job/$JOB" --timeout=600s >/dev/null 2>&1 \
    || fail "backup Job did not complete; logs: $($K logs job/$JOB --all-containers --tail=40 2>/dev/null)"
  if backup_index_intact; then
    ok "backup complete: neon bucket + config mirrored to OCI OS (victim branch index intact)"
    break
  fi
  [ $attempt -ge 3 ] && fail "victim branch index_part.json is TORN after $attempt backups"
  info "  victim index captured mid-rewrite (torn) — re-running the backup"
done

# ---------------------------------------------------------------------------
info "STEP 3: SIMULATE LOSS of the victim ONLY — destroy its compute + branch state"
sh "$PROVISION" destroy "$VICTIM" >/dev/null || fail "victim destroy failed"
# Loss confirmed: the victim branch must be GONE from the live pageserver.
if LIVE_TL_EXISTS "$VICTIM_TL"; then fail "victim branch $VICTIM_TL still present after destroy — loss not simulated"; fi
ok "victim branch $VICTIM_TL DELETED from the live plane (compute + pageserver + safekeeper WAL)"

info "  isolation check #1 (live plane): the PEER branch + its data are untouched"
LIVE_TL_EXISTS "$PEER_TL" || fail "peer branch $PEER_TL vanished — victim destroy was not isolated"
peer_note="$(APP_PSQL "$SRC_NS" "$PEER" "select note from app_marker where id='$PEER_MARKER_ID'" 2>/dev/null || true)"
[ "$peer_note" = "$PEER_NOTE" ] || fail "peer app data lost/altered by victim destroy (got: '$peer_note') — NOT isolated"
ok "peer branch $PEER_TL intact and still serving its marker — victim loss did not touch it"
$K scale "deploy/compute-$PEER" --replicas=0 >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
info "STEP 4: stand up the throwaway app-restore-drill plane from the OCI backup"
$KUBECTL delete ns "$DRILL_NS" --ignore-not-found $RT >/dev/null 2>&1 || true
j=0; while $KUBECTL get ns "$DRILL_NS" >/dev/null 2>&1; do j=$((j+1)); [ $j -gt 60 ] && fail "old $DRILL_NS stuck terminating"; sleep 2; done
$KUBECTL create ns "$DRILL_NS" >/dev/null

info "  recovering backed-up config from OCI Object Storage"
S3_USER="$($K get secret storage-s3-creds -o jsonpath='{.data.user}' | base64 -d)"
S3_PASS="$($K get secret storage-s3-creds -o jsonpath='{.data.password}' | base64 -d)"
DUMP="$($K run mc-restore-cfg --rm -i --restart=Never --image="$IMG_MC" \
  --env=BK_ENDPOINT="$BK_ENDPOINT" --env=BK_ACCESS="$BK_ACCESS" --env=BK_SECRET="$BK_SECRET" --env=BK_BUCKET="$BK_BUCKET" \
  --command -- /bin/sh -c '
    export HOME=/tmp
    mc alias set bak "$BK_ENDPOINT" "$BK_ACCESS" "$BK_SECRET" --api S3v4 --path on >/dev/null 2>&1 || exit 1
    mc cat "bak/$BK_BUCKET/neon-config/configmaps.yaml"' 2>/dev/null)"
echo "$DUMP" | grep -q 'compute-config' || fail "config dump missing compute-config (backup incomplete)"
# NB: the apps-tenant/branch ids are NOT in this platform config dump — a branch's
# TIMELINE_ID lives in its per-app compute-config-<app> ConfigMap, which is gone
# once the app is deprovisioned. The surviving record of a lost app's branch is the
# BUCKET PREFIX (runbook-dr.md §9a) — already proven present + INTACT for the victim
# branch by the STEP 2 index check on neon/pageserver/tenants/$APPS_TENANT/timelines/$VICTIM_TL.
ok "config recovered from backup store (platform ConfigMaps); victim branch id survives as a bucket prefix"

$KD create secret generic storage-s3-creds \
  --from-literal=user="$S3_USER" --from-literal=password="$S3_PASS" >/dev/null

# --- drill minio (service name 'minio' so pageserver.toml endpoint is unchanged) ---
$KD apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: { name: minio, namespace: $DRILL_NS, labels: { app: minio, plane: storage } }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: minio } }
  template:
    metadata: { labels: { app: minio, plane: storage } }
    spec:
      securityContext: { seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: minio
          image: quay.io/minio/minio:RELEASE.2022-10-20T00-55-09Z
          args: ["server","/data","--address",":9000","--console-address",":9001"]
          env:
            - { name: MINIO_ROOT_USER, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: user } } }
            - { name: MINIO_ROOT_PASSWORD, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: password } } }
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          ports: [ { name: s3, containerPort: 9000 } ]
          volumeMounts: [ { name: data, mountPath: /data } ]
          readinessProbe: { httpGet: { path: /minio/health/ready, port: s3 }, periodSeconds: 2 }
      volumes: [ { name: data, persistentVolumeClaim: { claimName: minio-data } } ]
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: minio-data, namespace: $DRILL_NS }
spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: $DRILL_MINIO_STORAGE } } }
---
apiVersion: v1
kind: Service
metadata: { name: minio, namespace: $DRILL_NS }
spec:
  selector: { app: minio }
  ports: [ { name: s3, port: 9000, targetPort: s3 } ]
YAML
$KD rollout status deploy/minio --timeout=300s >/dev/null || fail "drill minio not ready"
ok "drill minio up"

info "  restoring the neon bucket into the drill minio from OCI Object Storage (cross-internet copy — RTO-dominant)"
$KD run mc-seed --restart=Never --image="$IMG_MC" \
  --env=BK_ENDPOINT="$BK_ENDPOINT" --env=BK_ACCESS="$BK_ACCESS" --env=BK_SECRET="$BK_SECRET" --env=BK_BUCKET="$BK_BUCKET" \
  --env=S3_USER="$S3_USER" --env=S3_PASS="$S3_PASS" --command -- /bin/sh -c "
  set -e
  export HOME=/tmp
  n=0; until mc alias set bak \"\$BK_ENDPOINT\" \"\$BK_ACCESS\" \"\$BK_SECRET\" --api S3v4 --path on; do n=\$((n+1)); [ \$n -gt 30 ] && exit 1; sleep 2; done
  n=0; until mc alias set dst http://minio:9000 \"\$S3_USER\" \"\$S3_PASS\"; do n=\$((n+1)); [ \$n -gt 30 ] && exit 1; sleep 2; done
  mc mb --ignore-existing dst/neon
  n=0; until mc mirror --overwrite \"bak/\$BK_BUCKET/neon\" dst/neon; do n=\$((n+1)); [ \$n -gt 4 ] && exit 1; echo 'mirror retry '\$n; sleep 3; done
  echo SEED_DONE" >/dev/null
s=0; while :; do
  ph="$($KD get pod mc-seed -o jsonpath='{.status.phase}' 2>/dev/null || echo Unknown)"
  [ "$ph" = "Succeeded" ] && break
  [ "$ph" = "Failed" ] && fail "bucket seed failed: $($KD logs mc-seed --tail=30 2>/dev/null)"
  s=$((s+1)); [ $s -gt 600 ] && fail "bucket seed timed out (>1200s)"
  sleep 2
done
$KD delete pod mc-seed --ignore-not-found >/dev/null 2>&1 || true
ok "drill bucket seeded from backup (includes the apps tenant + the victim branch)"

# --- pageserver + broker + 1 safekeeper (fresh PVCs; served from restored bucket) ---
$KD apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ConfigMap
metadata: { name: pageserver-config, namespace: $DRILL_NS }
data:
  pageserver.toml: |
    broker_endpoint='http://storage-broker:50051'
    pg_distrib_dir='/usr/local/'
    listen_pg_addr='0.0.0.0:6400'
    listen_http_addr='0.0.0.0:9898'
    remote_storage={ endpoint='http://minio:9000', bucket_name='neon', bucket_region='eu-north-1', prefix_in_bucket='/pageserver' }
    control_plane_api='http://0.0.0.0:6666'
    control_plane_emergency_mode=true
    virtual_file_io_mode="buffered"
  identity.toml: |
    id=1234
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: storage-broker, namespace: $DRILL_NS, labels: { app: storage-broker } }
spec:
  replicas: 1
  selector: { matchLabels: { app: storage-broker } }
  template:
    metadata: { labels: { app: storage-broker } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: storage-broker
          image: $IMG_NEON
          command: ["storage_broker","--listen-addr=0.0.0.0:50051"]
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          ports: [ { name: grpc, containerPort: 50051 } ]
          readinessProbe: { tcpSocket: { port: grpc }, periodSeconds: 2 }
---
apiVersion: v1
kind: Service
metadata: { name: storage-broker, namespace: $DRILL_NS }
spec: { selector: { app: storage-broker }, ports: [ { name: grpc, port: 50051, targetPort: grpc } ] }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: safekeeper, namespace: $DRILL_NS, labels: { app: safekeeper } }
spec:
  serviceName: safekeeper
  replicas: 1
  selector: { matchLabels: { app: safekeeper } }
  template:
    metadata: { labels: { app: safekeeper } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: safekeeper
          image: $IMG_NEON
          command: ["/bin/sh","-c"]
          args:
            - |
              ORD=\${HOSTNAME##*-}
              exec safekeeper --listen-pg=0.0.0.0:5454 --advertise-pg=\${HOSTNAME}.safekeeper:5454 \
                --listen-http=0.0.0.0:7676 --id=\$((ORD + 1)) \
                --broker-endpoint=http://storage-broker:50051 -D /data \
                --remote-storage="{endpoint='http://minio:9000', bucket_name='neon', bucket_region='eu-north-1', prefix_in_bucket='/safekeeper/'}"
          env:
            - { name: AWS_ACCESS_KEY_ID, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: user } } }
            - { name: AWS_SECRET_ACCESS_KEY, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: password } } }
          ports: [ { name: pg, containerPort: 5454 }, { name: http, containerPort: 7676 } ]
          volumeMounts: [ { name: data, mountPath: /data } ]
          readinessProbe: { httpGet: { path: /v1/status, port: http }, periodSeconds: 2 }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: $DRILL_STORAGE } } }
---
apiVersion: v1
kind: Service
metadata: { name: safekeeper, namespace: $DRILL_NS }
spec:
  clusterIP: None
  selector: { app: safekeeper }
  ports: [ { name: pg, port: 5454, targetPort: pg }, { name: http, port: 7676, targetPort: http } ]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: pageserver, namespace: $DRILL_NS, labels: { app: pageserver } }
spec:
  serviceName: pageserver
  replicas: 1
  selector: { matchLabels: { app: pageserver } }
  template:
    metadata: { labels: { app: pageserver } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      initContainers:
        - name: seed-config
          image: $IMG_NEON
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          command: ["/bin/sh","-c"]
          args: [ "mkdir -p /data/.neon && cp /config/pageserver.toml /config/identity.toml /data/.neon/" ]
          volumeMounts: [ { name: data, mountPath: /data }, { name: config, mountPath: /config } ]
      containers:
        - name: pageserver
          image: $IMG_NEON
          command: ["/usr/local/bin/pageserver","-D","/data/.neon"]
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          env:
            - { name: AWS_ACCESS_KEY_ID, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: user } } }
            - { name: AWS_SECRET_ACCESS_KEY, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: password } } }
          ports: [ { name: pg, containerPort: 6400 }, { name: http, containerPort: 9898 } ]
          volumeMounts: [ { name: data, mountPath: /data } ]
          readinessProbe: { httpGet: { path: /v1/status, port: http }, periodSeconds: 2 }
      volumes: [ { name: config, configMap: { name: pageserver-config } } ]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: $DRILL_STORAGE } } }
---
apiVersion: v1
kind: Service
metadata: { name: pageserver, namespace: $DRILL_NS }
spec:
  selector: { app: pageserver }
  ports: [ { name: pg, port: 6400, targetPort: pg }, { name: http, port: 9898, targetPort: http } ]
YAML
$KD rollout status statefulset/pageserver --timeout=420s >/dev/null || fail "drill pageserver not ready"
$KD rollout status deploy/storage-broker --timeout=300s >/dev/null || fail "drill broker not ready"
ok "drill broker + safekeeper + pageserver up"

# --- RE-ATTACH the APPS tenant (covers ALL its branches at once — one attach) ---
info "  re-attaching apps tenant $APPS_TENANT at generation $DRILL_GEN (one attach = all app branches)"
$KD exec sts/pageserver -- /bin/sh -c "
  set -e
  until curl -sf http://localhost:9898/v1/tenant >/dev/null 2>&1; do sleep 1; done
  curl -sf -X PUT -H 'Content-Type: application/json' \
    -d '{\"mode\":\"AttachedSingle\",\"generation\":$DRILL_GEN,\"tenant_conf\":{}}' \
    http://localhost:9898/v1/tenant/$APPS_TENANT/location_config >/dev/null
" >/dev/null || fail "apps tenant re-attach failed"
info "  waiting for the victim branch + its template ancestor to load from the restored bucket"
a=0
while [ $a -lt 60 ]; do
  tls="$($KD exec sts/pageserver -- curl -sf "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline" 2>/dev/null || true)"
  if echo "$tls" | grep -q "$VICTIM_TL" && echo "$tls" | grep -q "$TEMPLATE_TL"; then break; fi
  a=$((a+1)); [ $a -ge 60 ] && fail "victim branch / template ancestor never loaded from the restored bucket"
  sleep 2
done
ok "apps tenant re-attached; victim branch $VICTIM_TL + template ancestor $TEMPLATE_TL loaded from backup"

DRILL_PSQL() { $KD exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$1"; }

# --- shared compute-files + compute-config ConfigMaps in the drill.
#     deploy/54-compute-files.yaml BUNDLES both compute-files AND a compute-config
#     carrying the PRIMARY tenant ids (f000…001/002) — correct for _verify-restore.sh
#     (which restores the primary tenant) but WRONG here. We restore the app's OWN
#     timeline through the SAME compute shape _verify-restore.sh uses (deploy/compute +
#     compute-config + compute-files) so the writable-promotion helper
#     deploy/_restore-writable.sh pairs with it verbatim — only the tenant/timeline
#     differ. So the sed below ALSO rewrites the bundled compute-config data values to
#     the APPS tenant + VICTIM branch. (config.json uses the literal placeholder strings
#     "TENANT_ID"/"TIMELINE_ID", not the f000 literals, so it is untouched — the
#     entrypoint still renders it from the compute-config env.) The authentic per-app
#     provisioning path (compute-app.template.yaml, per-app Secret, gateway routing) was
#     already exercised on the LIVE plane in STEP 1; here we prove the branch DATA
#     restores writable. ---
apply_compute_files() {  # $1 = "static" -> awk-inject Static mode via $MODE_LSN ; "" -> plain PRIMARY
  _inject="${1:-}"
  sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g" \
      -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/" \
      -e "s/f000f000f000f000f000f000f000f001/$APPS_TENANT/g" \
      -e "s/f000f000f000f000f000f000f000f002/$VICTIM_TL/g" \
      "$COMPUTE_FILES_SRC" \
  | if [ -n "$_inject" ]; then awk -v lsn="$MODE_LSN" '{print} /"format_version": 1.0,/{print "            \"mode\": {\"Static\": \"" lsn "\"},"}'; else cat; fi \
  | $KD apply -f - >/dev/null
}

# --- the drill compute Deployment (name 'compute'; pairs with _restore-writable.sh) ---
apply_drill_compute() {
  $KD apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: { name: compute, namespace: $DRILL_NS, labels: { app: compute } }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: compute } }
  template:
    metadata: { labels: { app: compute } }
    spec:
      securityContext: { seccompProfile: { type: RuntimeDefault } }
      terminationGracePeriodSeconds: 10
      initContainers:
        - name: wait-timeline
          image: $IMG_NEON
          envFrom: [ { configMapRef: { name: compute-config } } ]
          command: ["/bin/sh","-c"]
          args:
            - |
              set -eu
              PS="http://\${PAGESERVER_HOST}:9898"
              until curl -sf "\${PS}/v1/tenant/\${TENANT_ID}/timeline" | grep -q "\${TIMELINE_ID}"; do
                echo "waiting for timeline ..."; sleep 0.5; done
              echo "timeline ready"
      containers:
        - name: compute
          image: $IMG_COMPUTE
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh","/compute-files/entrypoint.sh"]
          envFrom: [ { configMapRef: { name: compute-config } } ]
          ports: [ { name: pg, containerPort: 55433 } ]
          volumeMounts: [ { name: compute-files, mountPath: /compute-files } ]
          readinessProbe: { tcpSocket: { port: pg }, periodSeconds: 1, failureThreshold: 120 }
      volumes: [ { name: compute-files, configMap: { name: compute-files } } ]
---
apiVersion: v1
kind: Service
metadata: { name: compute, namespace: $DRILL_NS, labels: { app: compute } }
spec:
  publishNotReadyAddresses: true
  selector: { app: compute }
  ports: [ { name: pg, port: 55433, targetPort: pg } ]
YAML
}

# ===========================================================================
info "STEP 5a: STATIC read-only restore of the victim branch (reads pages from the pageserver, no safekeepers)"
MODE_LSN="$(PS_TL_FIELD "$DRILL_NS" "$APPS_TENANT" "$VICTIM_TL" last_record_lsn)"
[ -n "$MODE_LSN" ] || fail "could not read restored victim branch LSN"
info "  restored victim branch last_record_lsn = $MODE_LSN (static read LSN)"
apply_compute_files "static"
apply_drill_compute
$KD rollout status deploy/compute --timeout=480s >/dev/null \
  || fail "drill compute (static, victim branch) did not come up (logs: $($KD logs deploy/compute -c compute --tail=40 2>/dev/null))"
got=""; q=0
while [ $q -lt 60 ]; do
  got="$(DRILL_PSQL "select note from app_marker where id='$MARKER_ID'" 2>/dev/null || true)"
  [ -n "$got" ] && break
  q=$((q+1)); sleep 1
done
FIRST_READ=$(date +%s)
[ "$got" = "$MARKER_NOTE" ] || fail "victim marker NOT readable in the restored drill (got: '$got')"
RTO_RO=$((FIRST_READ - BACKUP_START))
ok "victim marker '$MARKER_ID' READ BACK from the restored branch (read-only RTO ${RTO_RO}s)"

# --- isolation check #2 (drill plane): the peer app's data must NOT be visible through
#     the victim branch — proves the restore served the RIGHT timeline, not a merge. ---
peer_leak="$(DRILL_PSQL "select note from app_marker where id='$PEER_MARKER_ID'" 2>/dev/null || true)"
[ -z "$peer_leak" ] || fail "peer marker '$PEER_MARKER_ID' visible through the victim branch — branches are NOT isolated"
ok "isolation check #2: the peer's marker is NOT visible through the restored victim branch (branch-scoped)"

# ===========================================================================
info "STEP 5b: promote the restored victim branch to WRITABLE — try the LIGHT (walproposer auto-init) path first"
# The branch-per-app finding (ADR-0003 'the safekeeper finding'): on a LIVE plane a
# branch's walproposer auto-inits the safekeeper timeline, so a branch needs NO skctl
# craft. This step tests whether that lightness ALSO holds for a COLD restore of a
# branch that carries post-branch writes, or whether the cold path needs the same
# skctl craft as the primary tenant. Whichever fires is RECORDED as the finding.
WRITABLE_PATH="light (walproposer auto-init; NO skctl craft)"
apply_compute_files ""
$KD rollout restart deploy/compute >/dev/null
if $KD rollout status deploy/compute --timeout=150s >/dev/null 2>&1 \
   && [ "$(DRILL_PSQL 'show transaction_read_only' 2>/dev/null)" = "off" ]; then
  ok "victim branch booted read-WRITE via the LIGHT path (branch walproposer auto-init on the fresh drill safekeeper)"
else
  info "  LIGHT path did not reach read-write (the cold branch behaves like the primary tenant) — falling back to the skctl craft mechanism"
  WRITABLE_PATH="heavy (_restore-writable.sh skctl craft, same as the primary tenant)"
  # _restore-writable.sh derives cluster identity (pg_version/wal_seg_size/system_id)
  # from a RUNNING, READABLE compute (its DPSQL against deploy/compute). The LIGHT probe
  # above left a crash-looping PRIMARY, so first bring the STATIC read-only compute back
  # (this is the exact order _verify-restore.sh uses: static → _restore-writable → PRIMARY).
  MODE_LSN="$(PS_TL_FIELD "$DRILL_NS" "$APPS_TENANT" "$VICTIM_TL" last_record_lsn)"
  [ -n "$MODE_LSN" ] || fail "could not re-read restored victim branch LSN for the skctl fallback"
  apply_compute_files "static"
  $KD rollout restart deploy/compute >/dev/null
  $KD rollout status deploy/compute --timeout=420s >/dev/null 2>&1 \
    || fail "static compute for identity derivation did not come up before the skctl fallback"
  # Now the skctl re-seed can derive identity + PHASE1/PHASE2-seed the drill safekeeper.
  KUBECTL="$KUBECTL" RT="$RT" DRILL_NS="$DRILL_NS" TENANT="$APPS_TENANT" TIMELINE="$VICTIM_TL" \
    IMG_MC="$IMG_MC" SRC_NS="$SRC_NS" sh "$WRITABLE_HELPER" \
    || fail "safekeeper WAL re-seed (skctl fallback) failed for the victim branch"
  # _restore-writable.sh internally kicks a PRIMARY; re-assert plain-PRIMARY compute-files
  # and confirm read-write.
  apply_compute_files ""
  $KD rollout restart deploy/compute >/dev/null
  $KD rollout status deploy/compute --timeout=300s >/dev/null 2>&1 \
    || fail "victim branch did not reach read-WRITE after skctl fallback (logs: $($KD logs deploy/compute -c compute --tail=25 2>/dev/null))"
  [ "$(DRILL_PSQL 'show transaction_read_only' 2>/dev/null)" = "off" ] \
    || fail "victim branch still read-only after skctl fallback"
  ok "victim branch booted read-WRITE via the HEAVY (skctl) fallback"
fi

# --- write a proof row through the writable restored branch ---
WRITE_ID="wr-$MARKER_ID"
WRITE_NOTE="writable per-app restore proof; INSERTed into a restored branch, must survive a compute kill"
DRILL_PSQL "create table if not exists app_writable_proof(id text primary key, note text, ts timestamptz default now())" >/dev/null \
  || fail "could not create proof table (restored branch not writable)"
DRILL_PSQL "insert into app_writable_proof(id,note) values ('$WRITE_ID','$WRITE_NOTE')" >/dev/null \
  || fail "INSERT into the restored branch failed"
WRITABLE_QUERY=$(date +%s)
DRILL_PSQL "checkpoint" >/dev/null 2>&1 || true
ok "INSERT accepted by the restored writable branch (id '$WRITE_ID')"

info "  killing the restored victim compute to prove the write is DURABLE (not just in-session)"
$KD delete pod -l app=compute --wait=true >/dev/null 2>&1 || true
$KD rollout status deploy/compute --timeout=300s >/dev/null 2>&1 \
  || fail "restored victim compute did not come back after the durability kill"
back=""; r=0
while [ $r -lt 60 ]; do
  back="$(DRILL_PSQL "select note from app_writable_proof where id='$WRITE_ID'" 2>/dev/null || true)"
  [ -n "$back" ] && break
  r=$((r+1)); sleep 1
done
[ "$back" = "$WRITE_NOTE" ] || fail "proof row NOT durable — lost across the compute kill (got: '$back')"
RTO_RW=$((WRITABLE_QUERY - BACKUP_START))
ok "proof row '$WRITE_ID' SURVIVED a compute kill + fresh re-basebackup — writable per-app restore is durable"

# ---------------------------------------------------------------------------
echo ""
echo "=========================================================================="
echo " PER-APP (BRANCH) RESTORE DRILL PASSED  (#97)"
echo "   victim app / branch : $VICTIM / $VICTIM_TL"
echo "   peer app / branch   : $PEER / $PEER_TL (untouched — isolation control)"
echo "   victim marker id    : $MARKER_ID @ WAL $MARKER_LSN (uploaded before backup)"
echo "   apps re-attach gen  : $DRILL_GEN"
echo "   writable path taken : $WRITABLE_PATH"
echo "   RTO read-only  (backup start -> first branch read)   : ${RTO_RO}s"
echo "   RTO writable   (backup start -> durable branch INSERT): ${RTO_RW}s"
echo "   write proof id      : $WRITE_ID (survived a compute kill + re-basebackup)"
echo "=========================================================================="
echo " CEILING (pg 8464, honest): a per-branch restore CANNOT rewind ONE app to an"
echo " earlier point-in-time than the shared bucket restore point — branches share"
echo " ONE backup history in ONE bucket; there is NO per-branch PITR. A bucket"
echo " restore returns every tenant + every app branch to the SAME point-in-time."
echo " What it CAN do (proven above): bring a single lost app's branch back to a"
echo " WRITABLE state from the off-cluster backup, isolated from its peers."
echo "=========================================================================="
# cleanup (drill ns + drill apps) handled by trap
