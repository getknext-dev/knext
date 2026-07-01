#!/usr/bin/env bash
# Compute entrypoint — adapted from local/compute_wrapper/shell/compute.sh
# (upstream neondatabase/neon compose derivation) for k8s:
#   - config template read from the ConfigMap mount (/compute-files)
#   - hostnames are k8s Services: pageserver, safekeeper1 (same as compose)
#   - discovers-or-creates tenant+timeline on the pageserver, idempotently,
#     so scale 0->1 needs no init job and reuses the existing timeline.
set -eux

generate_id() {
    local -n resvar=${1}
    printf -v resvar '%08x%08x%08x%08x' ${SRANDOM} ${SRANDOM} ${SRANDOM} ${SRANDOM}
}

PG_VERSION=${PG_VERSION:-17}

readonly CONFIG_FILE_ORG=/compute-files/config.json
readonly CONFIG_FILE=/tmp/config.json

echo "Waiting for pageserver to become ready."
while ! nc -z pageserver 6400; do
     sleep 1
done
echo "Pageserver is ready."

cp "${CONFIG_FILE_ORG}" "${CONFIG_FILE}"

if [[ -n "${TENANT_ID:-}" && -n "${TIMELINE_ID:-}" ]]; then
  tenant_id=${TENANT_ID}
  timeline_id=${TIMELINE_ID}
else
  echo "Check if a tenant is present"
  tenant_id=$(curl -s -X GET -H "Content-Type: application/json" \
      "http://pageserver:9898/v1/tenant" | jq -r '.[0].id')
  if [[ -z "${tenant_id}" || "${tenant_id}" = null ]]; then
    echo "Create a tenant"
    generate_id tenant_id
    curl -s -X PUT -H "Content-Type: application/json" \
        -d '{"mode": "AttachedSingle", "generation": 1, "tenant_conf": {}}' \
        "http://pageserver:9898/v1/tenant/${tenant_id}/location_config" | jq .
  fi

  echo "Check if a timeline is present"
  timeline_id=$(curl -s -X GET -H "Content-Type: application/json" \
      "http://pageserver:9898/v1/tenant/${tenant_id}/timeline" | jq -r '.[0].timeline_id')
  if [[ -z "${timeline_id:-}" || "${timeline_id:-}" = null ]]; then
    generate_id timeline_id
    curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"new_timeline_id\": \"${timeline_id}\", \"pg_version\": ${PG_VERSION}}" \
        "http://pageserver:9898/v1/tenant/${tenant_id}/timeline/" | jq .
  fi
fi

echo "Adding pgx_ulid to shared_preload_libraries"
shared_libraries=$(jq -r '.spec.cluster.settings[] | select(.name=="shared_preload_libraries").value' ${CONFIG_FILE})
sed -i "s|${shared_libraries}|${shared_libraries},pgx_ulid|" ${CONFIG_FILE}

echo "Write tenant id and timeline id into the spec"
sed -i "s|TENANT_ID|${tenant_id}|" ${CONFIG_FILE}
sed -i "s|TIMELINE_ID|${timeline_id}|" ${CONFIG_FILE}

echo "Start compute node"
exec /usr/local/bin/compute_ctl --pgdata /var/db/postgres/compute \
     -C "postgresql://cloud_admin@localhost:55433/postgres" \
     -b /usr/local/bin/postgres \
     --compute-id "compute-${RANDOM}" \
     --config "${CONFIG_FILE}"
