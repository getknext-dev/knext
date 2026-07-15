#!/bin/sh
# _restore-writable.sh — re-seed a restored drill safekeeper so the plane can be
# promoted from READ-ONLY to a read-WRITE primary on neon:8464 OSS.
#
# Called by deploy/_verify-restore.sh STEP 5 once the restore is proven READABLE
# (pageserver re-attached from the backup, a STATIC read-only compute serving).
# Leaves the safekeeper positioned so a plain PRIMARY compute boots read-write;
# the caller boots that compute and asserts an INSERT survives a rebuild.
#
# THE PROBLEM (learned, see docs/operations.md "Backup & disaster recovery")
#   A restore stands up FRESH safekeepers (flush_lsn 0/0). A read-write compute's
#   walproposer needs a safekeeper that confirms WAL continuity from the
#   basebackup LSN, so Postgres aborts with "cannot start in read-write mode from
#   this base backup". 8464 OSS has no safekeeper HTTP timeline-create (POST/PUT
#   -> 404) and no storage controller, so the fix is ON-DISK reconstruction.
#
# THE MECHANISM (empirically validated)
#   The backup's /safekeeper prefix holds the real offloaded WAL segments. We:
#   1. Derive the cluster identity (system_id, pg_version, wal_seg_size) from the
#      running read-only compute, and the timeline LSNs from the pageserver.
#   2. PHASE 1 — seed the safekeeper PVC with real WAL segments spanning a couple
#      segments PAST the pageserver's last_record_lsn (Y), plus a crafted
#      safekeeper.control (deploy/skctl.py) committing at a boundary B > Y. On
#      start the pageserver streams the real WAL delta Y->Z from the safekeeper,
#      which RE-DERIVES its prev_record_lsn (the missing piece that made the
#      basebackup emit prev 0/0 and blocked read-write). Read the caught-up Z.
#   3. PHASE 2 — re-seed the safekeeper truncated at exactly Z with control
#      commit_lsn=Z, so flush_lsn == commit_lsn == the pageserver's last_record.
#      The pageserver stays up, so its re-derived prev_record_lsn persists.
#   Now a PRIMARY compute basebackups at Z with a valid prev -> boots read-write.
#
# Idempotent-ish: operates only inside $DRILL_NS (owned by the drill). Bounded.
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
KUBECTL="${KUBECTL:-kubectl}"
RT="${RT:---request-timeout=60s}"
DRILL_NS="${DRILL_NS:-restore-drill}"
TENANT="${TENANT:-f000f000f000f000f000f000f000f001}"
TIMELINE="${TIMELINE:-f000f000f000f000f000f000f000f002}"
IMG_MC="${IMG_MC:-minio/mc:RELEASE.2023-01-28T20-29-38Z}"
SK_PVC="${SK_PVC:-data-safekeeper-0}"
SRC_NS="${SRC_NS:-scale-zero-pg}"      # namespace stamped in 54-compute-files.yaml
HERE="$(dirname "$0")"
SKCTL="$HERE/skctl.py"
COMPUTE_FILES_SRC="$HERE/54-compute-files.yaml"

fail() { echo "FAIL(writable): $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }
info() { echo ">> $*"; }

command -v python3 >/dev/null 2>&1 || fail "python3 required (crafts the safekeeper.control binary)"
[ -f "$SKCTL" ] || fail "missing $SKCTL"

KD="$KUBECTL -n $DRILL_NS $RT"
PS_CURL() { $KD exec sts/pageserver -- curl -s "http://localhost:9898$1" 2>/dev/null; }
SK_CURL() { $KD exec sts/safekeeper -- curl -s "http://localhost:7676$1" 2>/dev/null; }
PS_FIELD() { PS_CURL "/v1/tenant/$TENANT/timeline/$TIMELINE" | tr ',' '\n' | grep "\"$1\"" | head -1 | cut -d'"' -f4; }
SK_FIELD() { SK_CURL "/v1/tenant/$TENANT/timeline/$TIMELINE" | tr ',' '\n' | grep "\"$1\"" | head -1 | cut -d'"' -f4; }
DPSQL() { $KD exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$1" 2>/dev/null; }

# ---------------------------------------------------------------------------
# 1) Derive identity + LSNs (all from disaster-available sources: the restored
#    read-only compute and the pageserver — NOT from any surviving safekeeper).
info "deriving cluster identity + timeline LSNs from the restored plane"
CID="$(DPSQL "select current_setting('server_version_num')||' '||(select bytes_per_wal_segment from pg_control_init())||' '||(select system_identifier from pg_control_system())" || true)"
PGV="$(echo "$CID" | awk '{print $1}')"
WSS="$(echo "$CID" | awk '{print $2}')"
SYSID="$(echo "$CID" | awk '{print $3}')"
[ -n "$PGV" ] && [ -n "$WSS" ] && [ -n "$SYSID" ] || fail "could not derive pg_version/wal_seg_size/system_id from the restored compute"
Y="$(PS_FIELD last_record_lsn)"
TSTART="$(PS_FIELD initdb_lsn)"
[ -n "$Y" ] || fail "could not read pageserver last_record_lsn"
[ -n "$TSTART" ] || TSTART="$Y"
ok "identity: pg_version=$PGV wal_seg_size=$WSS system_id=$SYSID"
ok "pageserver last_record_lsn (Y) = $Y ; timeline_start (initdb) = $TSTART"

# LSN math helper (avoids non-portable $((16#..)) in sh)
YINT="$(python3 -c "import sys;h,l=sys.argv[1].split('/');print((int(h,16)<<32)|int(l,16))" "$Y")"
WINT="$WSS"
# B = one segment past Y's segment boundary; commit target for phase 1.
BINT="$(python3 -c "print((($YINT//$WINT)+1)*$WINT)")"
BLSN="$(python3 -c "print('%X/%08X'%($BINT>>32,$BINT&0xffffffff))" | sed 's#^0*\([0-9A-F]\)#\1#')"
# Segment download range for phase 1: 2 segments before Y .. up to B.
LOW1INT="$(python3 -c "print(max(0,$YINT-2*$WINT))")"
LOW1LSN="$(python3 -c "print('%X/%08X'%($LOW1INT>>32,$LOW1INT&0xffffffff))")"

# ---------------------------------------------------------------------------
# seed(): scale the safekeeper down, populate its PVC via a helper pod, scale up.
#   args: $1 = commit LSN (control file position)
#         $2 = space-separated WAL segment filenames to download
#         $3 = truncation "NAME OFFSET" (empty = no truncation)
seed() {
  _commit="$1"; _segs="$2"; _trunc="$3"
  _ctl="$(python3 "$SKCTL" craft --commit "$_commit" --start "$TSTART" --term 40 \
            --sysid "$SYSID" --pgv "$PGV" --wss "$WSS" \
            --tenant "$TENANT" --timeline "$TIMELINE")"
  _u="$($KD get secret storage-s3-creds -o jsonpath='{.data.user}' | base64 -d)"
  _p="$($KD get secret storage-s3-creds -o jsonpath='{.data.password}' | base64 -d)"
  $KD scale sts/safekeeper --replicas=0 >/dev/null
  $KD wait --for=delete pod/safekeeper-0 --timeout=60s >/dev/null 2>&1 || true
  $KD delete pod sk-seed --ignore-not-found >/dev/null 2>&1 || true
  cat <<YAML | $KD apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: sk-seed, namespace: $DRILL_NS }
spec:
  restartPolicy: Never
  securityContext: { runAsUser: 0 }
  volumes:
    - { name: data, persistentVolumeClaim: { claimName: $SK_PVC } }
  containers:
    - name: seed
      image: $IMG_MC
      volumeMounts: [ { name: data, mountPath: /data } ]
      env:
        - { name: U, value: "$_u" }
        - { name: P, value: "$_p" }
        - { name: CTL_B64, value: "$_ctl" }
        - { name: SEGS, value: "$_segs" }
        - { name: TRUNC, value: "$_trunc" }
        - { name: WSS, value: "$WSS" }
        - { name: TENANT, value: "$TENANT" }
        - { name: TIMELINE, value: "$TIMELINE" }
      command: ["/bin/sh","-c"]
      args:
        - |
          set -e
          export HOME=/tmp
          TL="/data/\$TENANT/\$TIMELINE"
          rm -rf "/data/\$TENANT"; mkdir -p "\$TL"
          n=0; until mc alias set src http://minio:9000 "\$U" "\$P" >/dev/null 2>&1; do n=\$((n+1)); [ \$n -gt 30 ] && exit 1; sleep 2; done
          B="src/neon/safekeeper/\$TENANT/\$TIMELINE"
          for seg in \$SEGS; do mc cp "\$B/\$seg" "\$TL/\$seg"; done
          if [ -n "\$TRUNC" ]; then
            TN="\${TRUNC%% *}"; TO="\${TRUNC##* }"
            # download the truncation segment (it is beyond the SEGS range, which
            # stops at Z-1), then keep its first TO bytes and pad back to WSS so the
            # safekeeper's WAL scan ends exactly at Z.
            mc cp "\$B/\$TN" "\$TL/\$TN"
            dd if="\$TL/\$TN" of=/tmp/head bs=8 count=\$((TO/8)) 2>/dev/null
            cp /tmp/head "\$TL/\$TN"; truncate -s "\$WSS" "\$TL/\$TN"
          fi
          printf '%s' "\$CTL_B64" | base64 -d > "\$TL/safekeeper.control"
          printf '1' > /data/safekeeper.id
          chown -R 1000:1000 "/data/\$TENANT"
          echo SEED_OK
YAML
  _i=0
  while :; do
    _ph="$($KD get pod sk-seed -o jsonpath='{.status.phase}' 2>/dev/null || echo Unknown)"
    [ "$_ph" = "Succeeded" ] && break
    [ "$_ph" = "Failed" ] && fail "safekeeper seed pod failed: $($KD logs sk-seed --tail=20 2>/dev/null)"
    _i=$((_i+1)); [ $_i -gt 90 ] && fail "safekeeper seed pod timed out"
    sleep 2
  done
  $KD delete pod sk-seed --ignore-not-found >/dev/null 2>&1 || true
  $KD scale sts/safekeeper --replicas=1 >/dev/null
  $KD rollout status sts/safekeeper --timeout=120s >/dev/null || fail "seeded safekeeper did not become ready"
}

# primary_kick(): boot the compute as a PRIMARY (drop the STATIC read-only mode,
# point at the single drill safekeeper) so its walproposer connects to the freshly
# seeded safekeeper. A pageserver only runs a walreceiver for a timeline once a
# walproposer touches its safekeeper — this kick is what makes the pageserver
# STREAM the WAL delta forward and re-derive prev_record_lsn. The compute
# crash-loops (its basebackup LSN is ahead of the pageserver until PHASE 2 aligns
# things) — that is expected; one boot is enough to start the stream.
primary_kick() {
  [ -f "$COMPUTE_FILES_SRC" ] || fail "missing $COMPUTE_FILES_SRC"
  # 54-compute-files.yaml BUNDLES a compute-config carrying the PRIMARY tenant/timeline
  # ids (f000…001/002). Rewrite them to $TENANT/$TIMELINE so the kicked PRIMARY boots on
  # the SAME timeline this re-seed targets. For the platform-tenant restore these default
  # to f000…001/002 (a no-op); for a branch-per-app (apps tenant) timeline this is what
  # makes the pageserver walreceiver kick the RIGHT timeline (else it never streams past Y).
  sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g" \
      -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/" \
      -e "s/f000f000f000f000f000f000f000f001/$TENANT/g" \
      -e "s/f000f000f000f000f000f000f000f002/$TIMELINE/g" \
      "$COMPUTE_FILES_SRC" | $KD apply -f - >/dev/null
  $KD rollout restart deploy/compute >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# 2) PHASE 1 — seed past Y, then boot a PRIMARY to kick the pageserver into
#    streaming the WAL delta forward and re-deriving prev_record_lsn.
info "PHASE 1: seed safekeeper past Y (commit $BLSN) so the pageserver re-derives prev_record_lsn"
SEGS1="$(python3 "$SKCTL" segrange --from "$LOW1LSN" --to "$BLSN" --wss "$WSS" | tr '\n' ' ')"
seed "$BLSN" "$SEGS1" ""
ok "phase-1 safekeeper up (flush=$(SK_FIELD flush_lsn), commit=$(SK_FIELD commit_lsn))"

info "  booting a PRIMARY compute to kick the pageserver's walreceiver"
primary_kick

info "  waiting for the pageserver to stream past Y and settle (re-deriving prev)"
Z=""; prev=""; stable=0; a=0
while [ $a -lt 90 ]; do   # ~180s: allow for the kick pod to schedule + connect
  cur="$(PS_FIELD last_record_lsn)"; prev="$(PS_FIELD prev_record_lsn)"
  advanced="$(python3 -c "import sys;a=sys.argv[1];b=sys.argv[2];h=lambda s:(int(s.split('/')[0],16)<<32)|int(s.split('/')[1],16);print('1' if h(a)>h(b) else '0')" "$cur" "$Y" 2>/dev/null || echo 0)"
  if [ "$advanced" = "1" ] && [ -n "$prev" ] && [ "$prev" != "0/0" ]; then
    if [ "$cur" = "$Z" ]; then stable=$((stable+1)); else Z="$cur"; stable=0; fi
    [ $stable -ge 2 ] && break
  fi
  a=$((a+1)); sleep 2
done
[ -n "$Z" ] || fail "pageserver never streamed past Y (no catch-up from the seeded safekeeper)"
[ -n "$prev" ] && [ "$prev" != "0/0" ] || fail "pageserver prev_record_lsn still 0/0 after catch-up"
ok "pageserver caught up: last_record_lsn (Z) = $Z, prev_record_lsn = $prev"

# Runtime format guard (#24 AC2): after phase-1 the RUNNING safekeeper has
# rewritten safekeeper.control itself — parse that neon-written file and abort
# before phase 2 crafts anything if the live format is not the one skctl speaks.
$KD exec safekeeper-0 -c safekeeper -- cat "/data/$TENANT/$TIMELINE/safekeeper.control" \
  > /tmp/skctl-live.control 2>/dev/null || fail "could not read live safekeeper.control for checkver"
python3 "$SKCTL" checkver --file /tmp/skctl-live.control \
  || fail "live safekeeper writes a control format skctl does not speak (see operations.md: skctl format coupling)"
ok "checkver: live neon-written control file matches skctl's format"

# ---------------------------------------------------------------------------
# 3) PHASE 2 — re-seed truncated at Z so flush==commit==Z (== pageserver last_record).
info "PHASE 2: re-seed safekeeper truncated at Z=$Z (align flush==commit==pageserver last_record)"
ZINT="$(python3 -c "import sys;h,l=sys.argv[1].split('/');print((int(h,16)<<32)|int(l,16))" "$Z")"
LOW2INT="$(python3 -c "print(max(0,$ZINT-2*$WINT))")"
LOW2LSN="$(python3 -c "print('%X/%08X'%($LOW2INT>>32,$LOW2INT&0xffffffff))")"
# Range stops at Z-1 so the truncation segment is always the LAST one downloaded
# (no segment past the truncation point to prune) — keeps the seed pod portable.
ZM1LSN="$(python3 -c "print('%X/%08X'%(($ZINT-1)>>32,($ZINT-1)&0xffffffff))")"
SEGS2="$(python3 "$SKCTL" segrange --from "$LOW2LSN" --to "$ZM1LSN" --wss "$WSS" | tr '\n' ' ')"
TRUNC2="$(python3 "$SKCTL" off --lsn "$Z" --wss "$WSS")"
seed "$Z" "$SEGS2" "$TRUNC2"
SKFLUSH="$(SK_FIELD flush_lsn)"
[ "$SKFLUSH" = "$Z" ] || fail "safekeeper flush_lsn=$SKFLUSH did not align to Z=$Z"
ok "safekeeper aligned: flush_lsn == commit_lsn == $Z (== pageserver last_record)"
ok "restored safekeeper re-seeded — the plane is ready for a read-WRITE primary"
