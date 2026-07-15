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

# pg_hba harden shared with the primary + warm entrypoints (issue #164). See
# lib-harden.sh: harden_pg_hba inserts the #112 cloud_admin loopback-only reject and
# rewrites the pg_hba catch-all md5 -> scram-sha-256 (#117). On a per-app RO compute
# (APP_ROLE set via compute-config-<app>) the app role app_<app> already carries its
# SCRAM verifier in the REPLICATED catalog (streamed from the primary via WAL — an RO
# replica reads the same timeline), so app-role auth Just Works over SCRAM after the
# harden while cloud_admin is rejected over TCP. On the base single-DB RO pool
# (deploy/26, no APP_ROLE) the harden is skipped so DATABASE_URL_RO's cloud_admin-over-
# TCP path (mirroring the primary single-DB) keeps working — but with a STRONG
# cloud_admin md5 injected from pg-base-admin (issue #168), so the public default is
# rejected over TCP even here. The fallback below is only for a BARE local run.
. /compute-files/lib-harden.sh

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

# Per-app tenant boundary + SCRAM wire enforcement (issue #164): reconcile pg_hba
# (loopback-only cloud_admin #112 + scram-sha-256 wire auth #117) once Postgres is up.
# Backgrounded before exec so the wake path is never blocked; a no-op on the base
# single-DB RO pool (no APP_ROLE) so DATABASE_URL_RO's cloud_admin path is unchanged.
if [ -n "${APP_ROLE:-}" ]; then
  harden_pg_hba &
fi

echo "Starting compute_ctl (read-only, mode=${RO_MODE})"
exec /usr/local/bin/compute_ctl --pgdata /var/db/postgres/compute \
     -C "postgresql://cloud_admin@localhost:55433/postgres" \
     -b /usr/local/bin/postgres \
     --compute-id "compute-ro-${HOSTNAME:-k8s}" \
     --config "${DST}"
