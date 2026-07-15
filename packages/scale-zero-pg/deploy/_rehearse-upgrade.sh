#!/bin/sh
# _rehearse-upgrade.sh — the storage-plane UPGRADE rehearsal (issue #50).
#
# WHY THIS EXISTS
# ---------------
# KS-PG owns neon:8464 (compute↔storage version pair + skctl's safekeeper.control
# format weld, both fail-loud CI gates). ADR-0002 "Upgrade posture" states the
# decision: moving off 8464 is a deliberate PIVOT-CLASS event, not routine
# maintenance, because a control-format bump (v9 -> v10+) is exactly the
# Neon-internals reverse-engineering work KC1 says triggers pivot-to-managed.
#
# The tripwires (KC1/KC3, deploy/_validate.sh, skctl checkver) all fire on
# DIVERGENCE — but nothing behind them proved the upgrade path is even walkable,
# nor measured whether the next neon tag still writes a v9 control file (a
# manifest bump) or a new format (an skctl rewrite). This drill answers exactly
# that, in an isolated throwaway namespace, in minutes, so a future upgrade
# decision re-runs it instead of discovering the cost at disaster time.
#
# WHAT IT DOES (clean-slate boot of the REAL manifests against a NEW tag)
# ----------------------------------------------------------------------
#   1. Stands up a fresh, isolated storage plane in ns `upgrade-drill` from the
#      SAME deploy/ manifests the live plane uses, transformed minimally: the
#      neon/compute image tags are swapped to $TAG and the namespace is rewritten.
#      Any manifest/config breakage under the new image surfaces here.
#   2. Runs the storage-init Job (tenant+timeline create) on the new image —
#      proves the pageserver HTTP contract still accepts our bootstrap.
#   3. Boots a compute on the new image, writes a marker row + checkpoint — proves
#      the walproposer<->safekeeper<->pageserver wire path still works end to end
#      and forces the safekeeper to persist its on-disk safekeeper.control.
#   4. THE CRITICAL PROBE: dumps that safekeeper.control and runs
#      `deploy/skctl.py checkver` against it, AND independently decodes the raw
#      magic+format-version bytes. If version == 9 the upgrade is a manifest bump
#      (skctl survives); if not, the on-disk struct changed and the upgrade is an
#      skctl re-reverse-engineering project (KC1 pivot-class).
#
# It is NOT an upgrade of the live plane — nothing outside ns `upgrade-drill` is
# touched. Self-cleaning (trap deletes the namespace and its PVCs).
#
# Usage:
#   deploy/_rehearse-upgrade.sh [TAG]        # default TAG = the newest pullable pair
#   TAG=8465 deploy/_rehearse-upgrade.sh
#   KEEP_DRILL=1 deploy/_rehearse-upgrade.sh # leave ns up for inspection
#   KSPG_CONTEXT=orbstack deploy/_rehearse-upgrade.sh  # non-default cluster
#
# Exit: 0 = rehearsal completed, control file is v9 (upgrade = manifest bump).
#       3 = rehearsal completed, control format DIVERGED (upgrade = skctl rewrite).
#       1 = infrastructure failure (could not boot / probe) — inconclusive.
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
KUBECTL="${KUBECTL:-kubectl}"
RT="--request-timeout=90s"
HERE="$(cd "$(dirname "$0")" && pwd)"

# The tag to rehearse. Default is the newest coherent neon/compute-node-v17 pair
# published on Docker Hub at authoring time (a CI build newer than 8464); override
# with the first arg or $TAG when a newer stable release appears.
TAG="${1:-${TAG:-17411840350}}"

DRILL_NS=upgrade-drill
TENANT=f000f000f000f000f000f000f000f001
TIMELINE=f000f000f000f000f000f000f000f002
IMG_NEON="neondatabase/neon:${TAG}"
IMG_COMPUTE="neondatabase/compute-node-v17:${TAG}"

K="$KUBECTL -n $DRILL_NS $RT"
WORK="$(mktemp -d)"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }
info() { echo ">> $*"; }

cleanup() {
  code=$?
  if [ "${KEEP_DRILL:-0}" = "1" ]; then
    info "cleanup: KEEP_DRILL=1 — leaving namespace $DRILL_NS up for inspection"
    rm -rf "$WORK" 2>/dev/null || true
    exit $code
  fi
  info "cleanup: deleting namespace $DRILL_NS (throwaway; PVCs go with it)"
  $KUBECTL delete ns "$DRILL_NS" --wait=false --ignore-not-found $RT >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
  exit $code
}
trap cleanup EXIT INT TERM

command -v "$KUBECTL" >/dev/null 2>&1 || fail "kubectl not found"
command -v python3   >/dev/null 2>&1 || fail "python3 not found (needed for skctl checkver)"

# Guard: this drill creates/destroys a namespace — never run against an
# unintended cluster. Default = the canonical OKE context; override with
# KSPG_CONTEXT for local clusters.
EXPECTED_CTX="${KSPG_CONTEXT:-context-ckmva7v7zvq}"
[ "$($KUBECTL config current-context 2>/dev/null)" = "$EXPECTED_CTX" ] \
  || fail "expected kube-context '$EXPECTED_CTX' (set KSPG_CONTEXT to override)"

echo "==================================================================="
echo " STORAGE-PLANE UPGRADE REHEARSAL — issue #50"
echo "   pinned live tag : 8464"
echo "   rehearsing tag  : $TAG"
echo "   namespace       : $DRILL_NS (throwaway, isolated)"
echo "==================================================================="

# transform(): rewrite a live manifest for the drill — swap image tags to $TAG
# and rebase the namespace. This is the whole point: the REAL manifests are what
# gets exercised against the new image, so manifest/config breakage is caught.
transform() {
  sed -e "s#neondatabase/neon:8464#${IMG_NEON}#g" \
      -e "s#neondatabase/compute-node-v17:8464#${IMG_COMPUTE}#g" \
      -e "s#namespace: scale-zero-pg#namespace: ${DRILL_NS}#g" "$1"
}

# ---------------------------------------------------------------------------
info "STEP 0: fresh namespace + throwaway storage creds"
$KUBECTL delete ns "$DRILL_NS" --ignore-not-found $RT >/dev/null 2>&1 || true
j=0; while $KUBECTL get ns "$DRILL_NS" >/dev/null 2>&1; do
  j=$((j+1)); [ $j -gt 60 ] && fail "old $DRILL_NS stuck terminating"; sleep 2
done
$KUBECTL create ns "$DRILL_NS" >/dev/null
# minio root creds == the storage plane's S3 key (throwaway, drill-only).
$K create secret generic storage-s3-creds \
  --from-literal=user="drillminio" \
  --from-literal=password="drillminiosecret123" >/dev/null
ok "namespace $DRILL_NS created with throwaway storage-s3-creds"

# ---------------------------------------------------------------------------
info "STEP 1: object store (minio) + bucket, on the pinned minio image"
transform "$HERE/50-minio.yaml" | $K apply -f - >/dev/null || fail "apply 50-minio"
# Generous timeouts throughout: a bleeding-edge neon tag is a multi-GB image and
# the FIRST pull onto each node can take several minutes (this is itself an
# upgrade cost worth knowing). Subsequent runs hit the node image cache.
$K rollout status deploy/minio --timeout=300s >/dev/null || fail "minio not ready under $TAG boot"
# bucket-create Job may need a retry window; wait for completion.
$K wait --for=condition=complete job/minio-create-buckets --timeout=120s >/dev/null 2>&1 \
  || info "  (minio-create-buckets not yet complete — continuing; storage-init retries)"
ok "minio up, 'neon' bucket ensured"

# ---------------------------------------------------------------------------
info "STEP 2: storage broker + pageserver + a single safekeeper, on $IMG_NEON"
transform "$HERE/51-storage-broker.yaml" | $K apply -f - >/dev/null || fail "apply 51-broker"
transform "$HERE/53-pageserver.yaml"     | $K apply -f - >/dev/null || fail "apply 53-pageserver"
# one safekeeper is enough to observe the on-disk control format; rewrite 3->1.
transform "$HERE/52-safekeeper.yaml" | sed -e 's/^  replicas: 3/  replicas: 1/' \
  | $K apply -f - >/dev/null || fail "apply 52-safekeeper"

$K rollout status deploy/storage-broker --timeout=420s >/dev/null || fail "broker not ready under $TAG (image pull or MANIFEST/CONFIG breakage)"
$K rollout status statefulset/pageserver --timeout=420s >/dev/null \
  || fail "pageserver did not become ready under $TAG (MANIFEST/CONFIG BREAKAGE — see: $K logs sts/pageserver)"
$K rollout status statefulset/safekeeper --timeout=420s >/dev/null \
  || fail "safekeeper did not become ready under $TAG (MANIFEST/CONFIG BREAKAGE)"
ok "storage plane booted under $TAG (broker + pageserver + safekeeper Ready)"

# ---------------------------------------------------------------------------
info "STEP 3: compute config + storage-init (tenant/timeline create) on $IMG_NEON"
# 54 carries BOTH compute-files (entrypoint+spec) and compute-config (env). Rewrite
# neon.safekeepers to the single drill safekeeper, plus namespace.
transform "$HERE/54-compute-files.yaml" \
  | sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g" \
  | $K apply -f - >/dev/null || fail "apply 54-compute-files"

transform "$HERE/55-storage-init.yaml" | $K apply -f - >/dev/null || fail "apply 55-storage-init"
if $K wait --for=condition=complete job/storage-init --timeout=180s >/dev/null 2>&1; then
  ok "storage-init completed under $TAG (pageserver accepted tenant+timeline create)"
  STORAGE_INIT=ok
else
  info "  storage-init did NOT complete — logs:"
  $K logs job/storage-init --tail=30 2>/dev/null | sed 's/^/    /' || true
  fail "storage-init failed under $TAG (pageserver HTTP bootstrap contract broke — a real upgrade finding)"
fi

# ---------------------------------------------------------------------------
info "STEP 4: boot a compute on $IMG_COMPUTE and write a marker (persists control)"
transform "$HERE/20-compute.yaml" | sed -e 's/^  replicas: 0 /  replicas: 1 /' \
  | $K apply -f - >/dev/null || fail "apply 20-compute"
$K rollout status deploy/compute --timeout=420s >/dev/null \
  || fail "compute did not become ready under $TAG (wire/format incompat? see: $K logs deploy/compute -c compute)"

PSQL() { $K exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$1"; }
# Retry the first psql — readiness is a bare TCP probe; compute_ctl may still be
# finishing basebackup for a second or two after the port opens.
n=0; until PSQL "select 1" >/dev/null 2>&1; do
  n=$((n+1)); [ $n -gt 30 ] && fail "compute never accepted SQL under $TAG"; sleep 2
done
PSQL "create table if not exists upgrade_marker(id int primary key, note text)" >/dev/null
PSQL "insert into upgrade_marker values (1,'rehearsal $TAG') on conflict do nothing" >/dev/null
PSQL "checkpoint" >/dev/null 2>&1 || true
# a little WAL so the safekeeper definitely persists its control file
PSQL "create table if not exists upgrade_fill(id int, pad text)" >/dev/null
PSQL "insert into upgrade_fill select g, repeat('x',256) from generate_series(1,20000) g" >/dev/null 2>&1 || true
ROWS="$(PSQL "select count(*) from upgrade_marker" 2>/dev/null || echo 0)"
[ "$ROWS" = "1" ] || fail "marker row not readable under $TAG (read-write path broken)"
ok "compute served a read-write workload under $TAG (marker row intact)"

# ---------------------------------------------------------------------------
info "STEP 5: THE PROBE — dump safekeeper.control and check its format version"
# Locate the control file (do not hardcode the layout — a moved path is itself a
# finding). Poll: the safekeeper writes it once the timeline is created on it.
CTL=""
n=0; while [ $n -lt 30 ]; do
  CTL="$($K exec safekeeper-0 -- sh -c 'find /data -name safekeeper.control 2>/dev/null | head -1' 2>/dev/null || true)"
  [ -n "$CTL" ] && break
  n=$((n+1)); sleep 2
done
[ -n "$CTL" ] || fail "no safekeeper.control written under $TAG within 60s (layout changed? timeline not created on SK?)"
info "  control file on safekeeper-0: $CTL"

# Pull it out binary-safe via base64 (avoids exec stream mangling), decode locally.
LOCAL="$WORK/new.control"
$K exec safekeeper-0 -- sh -c "base64 < '$CTL'" 2>/dev/null \
  | python3 -c 'import sys,base64; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))' > "$LOCAL"
[ -s "$LOCAL" ] || fail "could not read safekeeper.control off the pod (base64 path failed)"
info "  dumped $(wc -c < "$LOCAL" | tr -d ' ') bytes to a local temp file"

# Independent raw decode: magic (u32 LE @0) + format version (u32 LE @4). Reports
# the real number regardless of whether skctl accepts it.
RAW="$(python3 - "$LOCAL" <<'PY'
import struct, sys
b = open(sys.argv[1], "rb").read()
magic, ver = struct.unpack_from("<II", b, 0)
print("0x%08x %d" % (magic, ver))
PY
)"
CTL_MAGIC="$(echo "$RAW" | cut -d' ' -f1)"
CTL_VER="$(echo "$RAW" | cut -d' ' -f2)"
info "  raw decode: magic=$CTL_MAGIC format_version=$CTL_VER"

# The authoritative verdict: skctl's own parser (magic + version + CRC32C).
if python3 "$HERE/skctl.py" checkver --file "$LOCAL"; then
  SKCTL_VERDICT="SURVIVES"
  VERDICT_EXIT=0
else
  SKCTL_VERDICT="REWRITE_REQUIRED"
  VERDICT_EXIT=3
fi

echo "==================================================================="
echo " REHEARSAL RESULT"
echo "   rehearsed tag        : $TAG (live pinned: 8464)"
echo "   storage plane booted : yes"
echo "   storage-init         : ${STORAGE_INIT:-ok}"
echo "   read-write workload  : yes (marker row served)"
echo "   safekeeper.control   : magic=$CTL_MAGIC format_version=$CTL_VER"
echo "   skctl v9 verdict     : $SKCTL_VERDICT"
if [ "$VERDICT_EXIT" = "0" ]; then
  echo "   => UPGRADE = MANIFEST BUMP: control format still v9; skctl survives, the"
  echo "      writable-restore path is intact. Re-validate per docs/operations.md and"
  echo "      bump the pinned tag + SK_COMPAT_NEON_TAG."
else
  echo "   => UPGRADE = SKCTL REWRITE (KC1 pivot-class): on-disk control format is"
  echo "      v$CTL_VER, not v9. skctl.py must be re-reverse-engineered against the new"
  echo "      struct BEFORE any upgrade ships, or prefer neon's first-class timeline"
  echo "      import API (retires skctl). See ADR-0002 'Upgrade posture'."
fi
echo "==================================================================="

exit $VERDICT_EXIT
