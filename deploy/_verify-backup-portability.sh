#!/bin/sh
# _verify-backup-portability.sh — prove the BACKUP + WAL-JANITOR path is portable
# to a NON-MinIO object store (issue #120), closing the split-brain the v1.0.0
# system-design review flagged: GA #105 made the pageserver/safekeeper offload
# backend swappable (S3/OCI/Ceph, MinIO optional), but the backup Job + wal-janitor
# still HARDCODED `mc alias set src http://minio:9000`. On a deployment that runs
# the live store on OCI Object Storage (skipping deploy/50-minio.yaml) that meant:
#   (1) the nightly backup FAILED (no `minio` Service to alias) — NO backup, and
#   (2) the wal-janitor could not reach its source — safekeeper WAL leaked unbounded.
#
# THE PROOF. Against REAL OCI Object Storage (NO in-cluster MinIO anywhere):
#   A. seed an OCI "live store" bucket with a faithful neon layout (pageserver
#      index_part.json + a layer, safekeeper WAL segments incl. one below a horizon,
#      one above, and a live .partial tail);
#   B. run the backup MIRROR with its `src` alias resolved from the storage-objstore
#      ConfigMap (endpoint/bucket = OCI, #120) and its `dst` from backup-s3-target
#      (a DEDICATED OCI backup bucket) — assert the pageserver objects + an INTACT
#      index land in the OCI backup bucket (issue #21 self-heal path still holds);
#   C. run the wal-janitor PRUNE with its `src` alias resolved from storage-objstore
#      (OCI) — assert it prunes the below-horizon segment FROM THE OCI STORE while
#      preserving the .partial tail + the at/above-horizon segment.
#
# The container env wiring + the src/dst resolution logic here MIRROR
# deploy/62-backup.yaml exactly; deploy/_validate.sh (contract 15b) is the
# authoritative guard that the SHIPPED manifest stays config-driven (no minio:9000,
# both containers envFrom storage-objstore). This drill is the LIVE reachability
# proof of that config-driven path against a genuine external S3.
#
# Self-cleaning (trap): deletes the throwaway namespace AND removes the two drill
# buckets from OCI. KSPG_CONTEXT-guarded. Owns ONLY namespace `backup-port-drill`
# + the two dedicated drill buckets. NEVER touches scale-zero-pg or the live
# ks-pg-backup bucket (refuses to run if a drill bucket collides with it).
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
KUBECTL="${KUBECTL:-kubectl}"
RT="--request-timeout=60s"

SRC_NS=scale-zero-pg
DRILL_NS=backup-port-drill
IMG_MC=minio/mc:RELEASE.2023-01-28T20-29-38Z
# Drill-only tenant/timeline — DISTINCT from primary (f000…) / apps (a000…).
TENANT=0bacc0de00000000000000000000d120
TIMELINE=0bacc0de00000000000000000000d121
# Dedicated OCI buckets (self-provisioned + torn down). NEVER the live ks-pg-backup.
SRC_BUCKET="${SRC_BUCKET:-ks-pg-bkpport-src-drill}"   # the LIVE store (what the pageserver would offload to)
DST_BUCKET="${DST_BUCKET:-ks-pg-bkpport-dst-drill}"   # the OFF-CLUSTER backup target
REGION="${OBJSTORE_REGION:-me-abudhabi-1}"

KD="$KUBECTL -n $DRILL_NS $RT"
KS="$KUBECTL -n $SRC_NS $RT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }
info() { echo ">> $*"; }

command -v "$KUBECTL" >/dev/null 2>&1 || fail "kubectl not found"
EXPECTED_CTX="${KSPG_CONTEXT:-context-ckmva7v7zvq}"
[ "$($KUBECTL config current-context 2>/dev/null)" = "$EXPECTED_CTX" ] || fail "expected kube-context '$EXPECTED_CTX' (set KSPG_CONTEXT to override)"

# ---------------------------------------------------------------------------
# Resolve the OCI endpoint + Customer Secret Key. Endpoint from the live
# backup-s3-target Secret; access/secret reuse that same CSK (the one #4/#105 use).
ENDPOINT="${OBJSTORE_ENDPOINT:-$($KS get secret backup-s3-target -o jsonpath='{.data.endpoint}' 2>/dev/null | base64 -d || true)}"
ACCESS="${OBJSTORE_ACCESS:-$($KS get secret backup-s3-target -o jsonpath='{.data.access}' 2>/dev/null | base64 -d || true)}"
SECRET="${OBJSTORE_SECRET:-$($KS get secret backup-s3-target -o jsonpath='{.data.secret}' 2>/dev/null | base64 -d || true)}"
LIVE_BUCKET="$($KS get secret backup-s3-target -o jsonpath='{.data.bucket}' 2>/dev/null | base64 -d || true)"
[ -n "$ENDPOINT" ] && [ -n "$ACCESS" ] && [ -n "$SECRET" ] || fail "no OCI endpoint/CSK (set OBJSTORE_ENDPOINT/ACCESS/SECRET or provision backup-s3-target)"
case "$ENDPOINT" in *minio*) fail "endpoint '$ENDPOINT' is MinIO — this drill proves the NON-MinIO path (#120)";; esac
[ "$SRC_BUCKET" = "$LIVE_BUCKET" ] || [ "$DST_BUCKET" = "$LIVE_BUCKET" ] && fail "refusing to use the live backup bucket '$LIVE_BUCKET' as a drill bucket"
info "OCI endpoint=$ENDPOINT region=$REGION  src=$SRC_BUCKET dst=$DST_BUCKET (NO MinIO)"

# ---------------------------------------------------------------------------
cleanup() {
  code=$?
  if [ "${KEEP_DRILL:-0}" = "1" ]; then
    info "cleanup: KEEP_DRILL=1 — leaving namespace $DRILL_NS + OCI buckets for inspection"; exit $code
  fi
  info "cleanup: deleting namespace $DRILL_NS + drill OCI buckets"
  $KUBECTL delete ns "$DRILL_NS" --wait=false --ignore-not-found $RT >/dev/null 2>&1 || true
  # tear down both drill buckets from OCI via a short-lived mc pod in scale-zero-pg.
  $KS run mc-bkpport-clean --rm -i --restart=Never --image="$IMG_MC" $RT \
    --env=E="$ENDPOINT" --env=A="$ACCESS" --env=S="$SECRET" \
    --env=SB="$SRC_BUCKET" --env=DB="$DST_BUCKET" \
    --command -- /bin/sh -c '
      export HOME=/tmp
      mc alias set oci "$E" "$A" "$S" --api S3v4 --path on >/dev/null 2>&1 || exit 0
      mc rb --force "oci/$SB" >/dev/null 2>&1 || true
      mc rb --force "oci/$DB" >/dev/null 2>&1 || true
      echo cleaned' >/dev/null 2>&1 || true
  exit $code
}
trap cleanup EXIT INT TERM

info "STEP 0: (re)create throwaway namespace $DRILL_NS"
$KUBECTL delete ns "$DRILL_NS" --ignore-not-found $RT >/dev/null 2>&1 || true
j=0; while $KUBECTL get ns "$DRILL_NS" >/dev/null 2>&1; do j=$((j+1)); [ $j -gt 60 ] && fail "old $DRILL_NS stuck terminating"; sleep 2; done
$KUBECTL create ns "$DRILL_NS" >/dev/null
ok "namespace $DRILL_NS ready"

# The EXACT ConfigMap/Secret wiring the shipped backup + wal-janitor read (#120):
#   storage-objstore  -> the LIVE store endpoint/bucket/region (OCI here, no MinIO)
#   storage-s3-creds   -> the S3 access/secret for that store (the OCI CSK)
#   backup-s3-target   -> the OFF-CLUSTER backup destination (a distinct OCI bucket)
#   compute-config     -> TENANT_ID/TIMELINE_ID for the index-integrity check
$KD create secret generic storage-s3-creds --from-literal=user="$ACCESS" --from-literal=password="$SECRET" >/dev/null
$KD create configmap storage-objstore \
  --from-literal=OBJSTORE_ENDPOINT="$ENDPOINT" \
  --from-literal=OBJSTORE_BUCKET="$SRC_BUCKET" \
  --from-literal=OBJSTORE_REGION="$REGION" >/dev/null
$KD create secret generic backup-s3-target \
  --from-literal=endpoint="$ENDPOINT" --from-literal=access="$ACCESS" \
  --from-literal=secret="$SECRET" --from-literal=bucket="$DST_BUCKET" >/dev/null
$KD create configmap compute-config \
  --from-literal=TENANT_ID="$TENANT" --from-literal=TIMELINE_ID="$TIMELINE" \
  --from-literal=PG_VERSION="17" --from-literal=PAGESERVER_HOST="pageserver" >/dev/null
ok "storage-objstore(OCI src) + storage-s3-creds(CSK) + backup-s3-target(OCI dst) + compute-config wired"

# ---------------------------------------------------------------------------
# STEP A: create both OCI buckets + seed a faithful neon layout in the src bucket.
info "STEP A: provision OCI buckets + seed a neon layout in the live-store bucket"
IX_REL="pageserver/tenants/${TENANT}/timelines/${TIMELINE}"
SKPFX="safekeeper/${TENANT}/${TIMELINE}"
SEG_BELOW=000000010000000000000001   # LOGID+SEG suffix 0000000000000001 -> below horizon (pruned)
SEG_ABOVE=000000010000000000000005   # suffix 0000000000000005 -> at/above horizon (kept)
SEG_PARTIAL=000000010000000000000006.partial  # live tail (kept)
$KD delete pod seed --ignore-not-found >/dev/null 2>&1 || true
$KD run seed --restart=Never --image="$IMG_MC" \
  --env=E="$ENDPOINT" --env=A="$ACCESS" --env=S="$SECRET" --env=SB="$SRC_BUCKET" --env=DB="$DST_BUCKET" --env=R="$REGION" \
  --env=IX="$IX_REL" --env=SK="$SKPFX" --env=SBLW="$SEG_BELOW" --env=SABV="$SEG_ABOVE" --env=SPAR="$SEG_PARTIAL" \
  --command -- /bin/sh -c '
    set -e; export HOME=/tmp
    mc alias set oci "$E" "$A" "$S" --api S3v4 --path on
    mc mb --ignore-existing "oci/$SB" --region "$R" >/dev/null 2>&1 || true
    mc mb --ignore-existing "oci/$DB" --region "$R" >/dev/null 2>&1 || true
    # pageserver: an intact index_part.json-<gen> (ends with "}") + a fake layer.
    printf "{\"version\":1,\"layer_metadata\":{}}" | mc pipe "oci/$SB/$IX/index_part.json-00000001"
    head -c 4096 /dev/urandom | mc pipe "oci/$SB/$IX/000000000000000000000001-000000000000000000000002__00000000016B5DA0-00000000016B6000"
    # safekeeper WAL: below-horizon (prune), above-horizon (keep), .partial (keep).
    printf "wal-below"   | mc pipe "oci/$SB/$SK/$SBLW"
    printf "wal-above"   | mc pipe "oci/$SB/$SK/$SABV"
    printf "wal-partial" | mc pipe "oci/$SB/$SK/$SPAR"
    echo SEED_OK; mc ls --recursive "oci/$SB" ' >/dev/null 2>&1 || true
$KD wait --for=jsonpath='{.status.phase}'=Succeeded pod/seed --timeout=120s >/dev/null 2>&1 || { $KD logs seed 2>&1 | tail -20 >&2; fail "seed pod did not succeed"; }
$KD logs seed 2>&1 | grep -q SEED_OK || { $KD logs seed 2>&1 | tail -20 >&2; fail "seed did not complete"; }
$KD delete pod seed --ignore-not-found >/dev/null 2>&1 || true
ok "OCI src bucket seeded (pageserver index+layer, safekeeper below/above/partial WAL); dst bucket created"

# ---------------------------------------------------------------------------
# STEP B: run the backup MIRROR — src resolved from storage-objstore (OCI, #120),
# dst from backup-s3-target (OCI). The command body mirrors deploy/62-backup.yaml.
info "STEP B: backup mirror (src=OCI live store, dst=OCI backup bucket) — config-driven, no MinIO"
$KD delete job mirror --ignore-not-found >/dev/null 2>&1 || true
cat <<'YAML' | sed "s|__IMG__|$IMG_MC|" | $KD apply -f - >/dev/null || fail "mirror Job apply failed"
apiVersion: batch/v1
kind: Job
metadata: { name: mirror, labels: { drill: backup-portability } }
spec:
  backoffLimit: 2
  template:
    metadata: { labels: { drill: backup-portability } }
    spec:
      restartPolicy: OnFailure
      containers:
        - name: mirror
          image: __IMG__
          envFrom:
            - configMapRef: { name: compute-config }
            - configMapRef: { name: storage-objstore } # OBJSTORE_ENDPOINT / _BUCKET / _REGION (#120)
          env:
            - { name: S3_USER, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: user } } }
            - { name: S3_PASS, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: password } } }
            - { name: BK_ENDPOINT, valueFrom: { secretKeyRef: { name: backup-s3-target, key: endpoint } } }
            - { name: BK_ACCESS,   valueFrom: { secretKeyRef: { name: backup-s3-target, key: access } } }
            - { name: BK_SECRET,   valueFrom: { secretKeyRef: { name: backup-s3-target, key: secret } } }
            - { name: BK_BUCKET,   valueFrom: { secretKeyRef: { name: backup-s3-target, key: bucket } } }
          command: ["/bin/sh","-c"]
          args:
            - |
              set -eu
              export HOME=/tmp; mkdir -p /tmp/.mc
              # src = the LIVE object store (config-driven, #120). SigV4 + path-style.
              mc alias set src "$OBJSTORE_ENDPOINT" "$S3_USER" "$S3_PASS" --api S3v4 --path on
              mc alias set dst "$BK_ENDPOINT" "$BK_ACCESS" "$BK_SECRET" --api S3v4 --path on
              SRC_ROOT="src/$OBJSTORE_BUCKET"
              DST_ROOT="dst/$BK_BUCKET/neon"
              echo "backup src=$SRC_ROOT (live store $OBJSTORE_ENDPOINT) -> dst=$DST_ROOT"
              n=0
              until mc mirror --overwrite "$SRC_ROOT" "$DST_ROOT"; do
                n=$((n+1)); [ "$n" -gt 8 ] && { echo "mirror failed after $n attempts" >&2; exit 1; }
                echo "mirror retry $n ..."; sleep 5
              done
              # issue #21 self-heal: the newest index_part.json-<gen> must end with '}'.
              IX_REL="pageserver/tenants/${TENANT_ID}/timelines/${TIMELINE_ID}"
              f="$(mc ls "$DST_ROOT/$IX_REL/" 2>/dev/null | sed 's/.* //' | grep -o 'index_part.json-[0-9]*' | sort | tail -1)"
              [ -n "$f" ] || { echo "no index_part.json mirrored to dst" >&2; exit 1; }
              last="$(mc cat "$DST_ROOT/$IX_REL/$f" 2>/dev/null | tail -c 1)"
              [ "$last" = "}" ] || { echo "mirrored index TORN" >&2; exit 1; }
              echo "index INTACT in backup: $f"
              echo "MIRROR_OK"; mc ls --recursive "$DST_ROOT"
YAML
i=0; while :; do
  ph="$($KD get job mirror -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)"
  [ "$ph" = "True" ] && break
  fp="$($KD get job mirror -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)"
  [ "$fp" = "True" ] && { $KD logs job/mirror 2>&1 | tail -25 >&2; fail "mirror Job FAILED (config-driven OCI backup did not complete)"; }
  i=$((i+3)); [ $i -gt 180 ] && { $KD logs job/mirror 2>&1 | tail -25 >&2; fail "mirror Job timed out"; }; sleep 3
done
$KD logs job/mirror 2>&1 | grep -q MIRROR_OK || { $KD logs job/mirror 2>&1 | tail -25 >&2; fail "mirror did not report success"; }
ok "backup MIRROR completed against OCI (src+dst both OCI, no MinIO); index verified INTACT"

# Independently assert the pageserver objects actually landed in the OCI backup bucket.
$KD delete pod assert-dst --ignore-not-found >/dev/null 2>&1 || true
$KD run assert-dst --restart=Never --image="$IMG_MC" \
  --env=E="$ENDPOINT" --env=A="$ACCESS" --env=S="$SECRET" --env=DB="$DST_BUCKET" --env=IX="$IX_REL" \
  --command -- /bin/sh -c '
    export HOME=/tmp; mc alias set dst "$E" "$A" "$S" --api S3v4 --path on >/dev/null 2>&1
    C=$(mc ls --recursive "dst/$DB/neon/$IX" 2>/dev/null | grep -c . || true)
    echo "DST_OBJECTS=$C"; [ "$C" -ge 2 ] && echo ASSERT_DST_OK || echo ASSERT_DST_FAIL' >/dev/null 2>&1
$KD wait --for=jsonpath='{.status.phase}'=Succeeded pod/assert-dst --timeout=60s >/dev/null 2>&1 || true
$KD logs assert-dst 2>&1 | grep -q ASSERT_DST_OK || { $KD logs assert-dst 2>&1 >&2; fail "pageserver objects did NOT land in the OCI backup bucket"; }
DSTN="$($KD logs assert-dst 2>&1 | grep -o 'DST_OBJECTS=[0-9]*' | cut -d= -f2)"
$KD delete pod assert-dst --ignore-not-found >/dev/null 2>&1 || true
ok "pageserver objects landed in the OCI backup bucket ($DSTN objects under neon/$IX_REL)"

# ---------------------------------------------------------------------------
# STEP C: run the wal-janitor PRUNE against OCI — src from storage-objstore (#120).
# Seed the per-timeline horizon (/state/horizons/<T>/<TL>) directly (the shipped
# resolve-horizon initContainer derives it from the pageserver's remote_consistent
# _lsn; here we inject a fixed suffix so the OCI-facing PRUNE logic is what's tested).
info "STEP C: wal-janitor prune against the OCI live store (config-driven src, #120)"
HORIZON_SUFFIX=0000000000000003   # below=0001 pruned; above=0005 + .partial kept
$KD delete job prune --ignore-not-found >/dev/null 2>&1 || true
cat <<'YAML' | sed -e "s|__IMG__|$IMG_MC|" -e "s|__SUF__|$HORIZON_SUFFIX|" | $KD apply -f - >/dev/null || fail "prune Job apply failed"
apiVersion: batch/v1
kind: Job
metadata: { name: prune, labels: { drill: backup-portability } }
spec:
  backoffLimit: 2
  template:
    metadata: { labels: { drill: backup-portability } }
    spec:
      restartPolicy: OnFailure
      initContainers:
        - name: seed-horizon
          image: __IMG__
          envFrom: [ { configMapRef: { name: compute-config } } ]
          command: ["/bin/sh","-c"]
          args:
            - |
              set -eu
              mkdir -p "/state/horizons/${TENANT_ID}"
              printf '%s' "__SUF__" > "/state/horizons/${TENANT_ID}/${TIMELINE_ID}"
              printf '%s' "__SUF__" > /state/threshold_suffix
          volumeMounts: [ { name: state, mountPath: /state } ]
      containers:
        - name: prune
          image: __IMG__
          envFrom:
            - configMapRef: { name: compute-config }
            - configMapRef: { name: storage-objstore } # OBJSTORE_ENDPOINT / _BUCKET (#120)
          env:
            - { name: DRY_RUN, value: "false" }
            - { name: S3_USER, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: user } } }
            - { name: S3_PASS, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: password } } }
          command: ["/bin/sh","-c"]
          args:
            - |
              set -eu
              export HOME=/tmp; mkdir -p /tmp/.mc
              # src = the LIVE object store (config-driven, #120): the janitor MUST
              # prune the SAME store the safekeepers offload to.
              mc alias set src "$OBJSTORE_ENDPOINT" "$S3_USER" "$S3_PASS" --api S3v4 --path on
              SKBASE="src/$OBJSTORE_BUCKET/safekeeper"
              PFX="$SKBASE/${TENANT_ID}/${TIMELINE_ID}"
              SUFFIX="$(cat /state/horizons/${TENANT_ID}/${TIMELINE_ID})"
              echo "prune src=$PFX horizon_suffix=$SUFFIX (OCI, #120)"
              mc ls "$PFX/" | sed 's/.* //' | grep -E '^[0-9A-Fa-f]{24}$' | sort -u > /tmp/all || true
              cut -c1-8 /tmp/all | sort -u > /tmp/tlis
              : > /tmp/todelete
              while IFS= read -r tli; do
                [ -n "$tli" ] || continue
                KEEP="${tli}${SUFFIX}"
                grep "^${tli}" /tmp/all > /tmp/all_tli || true
                { cat /tmp/all_tli; echo "$KEEP"; } | sort -u | sed "/^$KEEP\$/,\$d" >> /tmp/todelete
              done < /tmp/tlis
              sort -u /tmp/todelete -o /tmp/todelete
              n="$(grep -c . /tmp/todelete || true)"
              echo "prunable(below horizon)=$n"
              i=0
              while IFS= read -r o; do
                [ -n "$o" ] || continue
                mc rm "$PFX/$o" >/dev/null && i=$((i+1))
              done < /tmp/todelete
              echo "pruned $i segment(s) from the OCI store"
              echo "PRUNE_OK"
          volumeMounts: [ { name: state, mountPath: /state } ]
      volumes:
        - name: state
          emptyDir: {}
YAML
i=0; while :; do
  ph="$($KD get job prune -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)"
  [ "$ph" = "True" ] && break
  fp="$($KD get job prune -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)"
  [ "$fp" = "True" ] && { $KD logs job/prune --all-containers 2>&1 | tail -25 >&2; fail "prune Job FAILED against OCI"; }
  i=$((i+3)); [ $i -gt 180 ] && { $KD logs job/prune --all-containers 2>&1 | tail -25 >&2; fail "prune Job timed out"; }; sleep 3
done
$KD logs job/prune -c prune 2>&1 | grep -q PRUNE_OK || { $KD logs job/prune -c prune 2>&1 | tail -25 >&2; fail "prune did not report success"; }
ok "wal-janitor PRUNE ran against the OCI store (config-driven src, #120)"

# Assert the below-horizon segment is GONE from OCI and the .partial + above survive.
$KD delete pod assert-prune --ignore-not-found >/dev/null 2>&1 || true
$KD run assert-prune --restart=Never --image="$IMG_MC" \
  --env=E="$ENDPOINT" --env=A="$ACCESS" --env=S="$SECRET" --env=SB="$SRC_BUCKET" --env=SK="$SKPFX" \
  --env=SBLW="$SEG_BELOW" --env=SABV="$SEG_ABOVE" --env=SPAR="$SEG_PARTIAL" \
  --command -- /bin/sh -c '
    export HOME=/tmp; mc alias set src "$E" "$A" "$S" --api S3v4 --path on >/dev/null 2>&1
    LS="$(mc ls "src/$SB/$SK/" 2>/dev/null | sed "s/.* //")"
    echo "$LS" | grep -q "^$SBLW\$" && { echo PRUNE_BELOW_SURVIVED; exit 0; }
    echo "$LS" | grep -q "^$SABV\$" || { echo PRUNE_ABOVE_DELETED; exit 0; }
    echo "$LS" | grep -q "partial" || { echo PRUNE_PARTIAL_DELETED; exit 0; }
    echo ASSERT_PRUNE_OK' >/dev/null 2>&1
$KD wait --for=jsonpath='{.status.phase}'=Succeeded pod/assert-prune --timeout=60s >/dev/null 2>&1 || true
RES="$($KD logs assert-prune 2>&1 || true)"
$KD delete pod assert-prune --ignore-not-found >/dev/null 2>&1 || true
case "$RES" in
  *ASSERT_PRUNE_OK*) ok "OCI prune correct: below-horizon segment removed; .partial tail + above-horizon segment preserved" ;;
  *PRUNE_BELOW_SURVIVED*) fail "below-horizon segment survived — janitor did not prune the OCI store (#120)" ;;
  *PRUNE_ABOVE_DELETED*)  fail "above-horizon segment deleted — janitor over-pruned the OCI store" ;;
  *PRUNE_PARTIAL_DELETED*) fail "live .partial tail deleted — janitor violated the durability tail on OCI" ;;
  *) fail "prune assertion inconclusive: $RES" ;;
esac

echo ""
echo "=========================================================================="
echo " BACKUP PORTABILITY DRILL PASSED  (#120)"
echo "   object store        : $ENDPOINT (OCI, NO MinIO)"
echo "   live-store bucket    : $SRC_BUCKET   backup bucket: $DST_BUCKET"
echo "   backup MIRROR        : src+dst config-driven -> pageserver objects landed in the OCI backup bucket, index INTACT"
echo "   wal-janitor PRUNE    : config-driven src -> below-horizon WAL reclaimed from OCI; tail + above-horizon preserved"
echo "=========================================================================="
