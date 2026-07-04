#!/bin/sh
# Read-only pool compute entrypoint (read-replica pool, issue #66). SAME
# tenant/timeline as the cold `compute` writer — reads reflect the writer's
# committed data. The ONLY difference vs the stock entrypoint is that it injects
# a read-only `mode` into the compute_ctl spec so compute_ctl boots Postgres as
# a read-only endpoint that never attaches as the single writer. No gate, no
# generation ceremony: a read-only compute coordinates nothing.
#
# RO_MODE (default "Replica"):
#   Replica  - hot-standby that FOLLOWS the timeline tip (streams WAL from the
#              safekeepers, reads pages from the pageserver). This is the goal:
#              reads track the writer with only replication lag. Requires
#              compute_ctl/Postgres to support the Replica compute mode.
#   Static   - read-only pinned at a FIXED LSN captured at attach time (the
#              honest fallback the restore drill already proves works). Reads are
#              frozen at boot; a replica advances only by re-rolling the pod
#              (an HPA scale-up naturally brings fresh-LSN pods online). Needs
#              RO_STATIC_LSN, or the resolve-lsn initContainer's /ro-lsn/lsn.
set -eu

: "${TENANT_ID:?compute-config must set TENANT_ID}"
: "${TIMELINE_ID:?compute-config must set TIMELINE_ID}"

RO_MODE="${RO_MODE:-Replica}"
SRC=/compute-files/config.json
IDS=/tmp/config.ids.json
DST=/tmp/config.json
CLOUD_ADMIN_MD5="${CLOUD_ADMIN_MD5:-b093c0d3b281ba6da1eacc608620abd8}"

echo "Rendering RO compute spec (tenant=${TENANT_ID} timeline=${TIMELINE_ID} mode=${RO_MODE})"
sed -e "s|TENANT_ID|${TENANT_ID}|g" -e "s|TIMELINE_ID|${TIMELINE_ID}|g" \
    -e "s|CLOUD_ADMIN_MD5_PLACEHOLDER|${CLOUD_ADMIN_MD5}|g" "$SRC" > "$IDS"

case "$RO_MODE" in
  Replica)
    MODE_JSON='"mode": "Replica",'
    ;;
  Static)
    LSN="${RO_STATIC_LSN:-}"
    if [ -z "$LSN" ] && [ -f /ro-lsn/lsn ]; then LSN="$(cat /ro-lsn/lsn)"; fi
    [ -n "$LSN" ] || { echo "RO_MODE=Static needs RO_STATIC_LSN or the resolve-lsn initContainer (/ro-lsn/lsn)"; exit 1; }
    echo "  static read LSN = ${LSN}"
    MODE_JSON="\"mode\": {\"Static\": \"${LSN}\"},"
    ;;
  *)
    echo "unknown RO_MODE=${RO_MODE} (want Replica|Static)"; exit 1
    ;;
esac

# Inject the read-only mode as a top-level spec field, right after format_version
# (same seam the restore drill uses for its Static compute).
awk -v m="$MODE_JSON" '{print} /"format_version": 1.0,/{print "        " m}' "$IDS" > "$DST"

echo "Starting compute_ctl (read-only, mode=${RO_MODE})"
exec /usr/local/bin/compute_ctl --pgdata /var/db/postgres/compute \
     -C "postgresql://cloud_admin@localhost:55433/postgres" \
     -b /usr/local/bin/postgres \
     --compute-id "compute-ro-${HOSTNAME:-k8s}" \
     --config "${DST}"
