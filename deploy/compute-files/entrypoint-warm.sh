#!/bin/bash
# Gated warm-standby compute entrypoint (warm tier, ADR-0002). Productizes
# warmstandby/'s prototype gate: instead of the harness touching a file via
# `kubectl exec`, the pod polls the GATEWAY's gate port and boots compute_ctl
# only once the gateway opens it. The gateway's warmpool driver opens that gate
# ONLY after proving the cold `compute` deployment is fully drained, so the
# single-writer invariant is enforced in tested Go, not shell.
#
# Bash (not sh): the /dev/tcp pseudo-device is a bash builtin. The stock
# compute image (neondatabase/compute-node-v17) ships bash but no curl/nc, so
# this TCP probe is the exec-free, dependency-free way to wait on the gate.
#
# The pod is fully scheduled + Running (RAM reserved) while it blocks here, but
# compute_ctl has NOT attached to the timeline — the "warm-RAM" parked state.
set -eu

: "${TENANT_ID:?compute-config must set TENANT_ID}"
: "${TIMELINE_ID:?compute-config must set TIMELINE_ID}"
: "${WARM_GATE_ADDR:?warm entrypoint needs WARM_GATE_ADDR=host:port of the gateway gate}"

SRC=/compute-files/config.json   # reused from the compute-files ConfigMap
DST=/tmp/config.json
CLOUD_ADMIN_MD5="${CLOUD_ADMIN_MD5:-b093c0d3b281ba6da1eacc608620abd8}"

# pg_hba harden shared with the primary + RO entrypoints (issue #164). See
# lib-harden.sh: harden_pg_hba inserts the #112 cloud_admin loopback-only reject and
# rewrites the pg_hba catch-all md5 -> scram-sha-256 (#117). Gated on APP_ROLE (below):
# a per-app warm compute hardens exactly like the primary per-app writer, while the base
# single-DB warm tier (deploy/25, no APP_ROLE) keeps cloud_admin over TCP so the warm
# path (WARM_DSN cloud_admin) mirrors the primary single-DB unchanged.
. /compute-files/lib-harden.sh

echo "Rendering compute spec (tenant=${TENANT_ID} timeline=${TIMELINE_ID})"
sed -e "s|TENANT_ID|${TENANT_ID}|g" -e "s|TIMELINE_ID|${TIMELINE_ID}|g" \
    -e "s|CLOUD_ADMIN_MD5_PLACEHOLDER|${CLOUD_ADMIN_MD5}|g" "$SRC" > "$DST"

GATE_HOST="${WARM_GATE_ADDR%:*}"
GATE_PORT="${WARM_GATE_ADDR##*:}"

# Sentinel: pod is warm (scheduled, RAM held) but compute_ctl is NOT yet
# attached. A successful TCP connect to the gateway gate = gate open = boot.
echo "WARM_GATE_WAITING ${WARM_GATE_ADDR}"
until (exec 3<>"/dev/tcp/${GATE_HOST}/${GATE_PORT}") 2>/dev/null; do
  sleep 0.2
done
exec 3>&- 2>/dev/null || true
echo "WARM_GATE_OPEN — attaching compute_ctl"

# Per-app tenant boundary + SCRAM wire enforcement (issue #164): reconcile pg_hba
# (loopback-only cloud_admin #112 + scram-sha-256 wire auth #117) once Postgres is up.
# Backgrounded before exec so the wake path is never blocked; a no-op on the base
# single-DB warm tier (no APP_ROLE) so the WARM_DSN cloud_admin-over-TCP path is unchanged.
if [ -n "${APP_ROLE:-}" ]; then
  harden_pg_hba &
fi

# From here it is identical to the stock entrypoint's exec line.
exec /usr/local/bin/compute_ctl --pgdata /var/db/postgres/compute \
     -C "postgresql://cloud_admin@localhost:55433/postgres" \
     -b /usr/local/bin/postgres \
     --compute-id "compute-warm-${HOSTNAME:-k8s}" \
     --config "${DST}"
