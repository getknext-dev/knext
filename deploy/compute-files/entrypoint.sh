#!/bin/sh
# Compute entrypoint (k8s), adapted from local/compute_wrapper/shell/compute.sh.
#
# The compute image (neondatabase/compute-node-v17) ships NO nc/curl/jq, so this
# entrypoint does the bare minimum and stays POSIX-sh clean:
#   - tenant/timeline IDs arrive via env from the compute-config ConfigMap;
#     they are created on the pageserver by the storage-init Job, and the
#     compute pod's wait-timeline initContainer blocks until they exist. So we
#     never talk to the pageserver HTTP API from here.
#   - we only substitute the IDs into the spec (sed is present) and exec compute_ctl.
set -eu

: "${TENANT_ID:?compute-config must set TENANT_ID}"
: "${TIMELINE_ID:?compute-config must set TIMELINE_ID}"

SRC=/compute-files/config.json
DST=/tmp/config.json

# cloud_admin credential: injected from the optional pg-cloud-admin Secret
# (CLOUD_ADMIN_MD5 = md5 of password+username). Dev fallback is the publicly
# known default (cloud_admin/cloud_admin) so fresh local clusters just work;
# production MUST set the Secret. Rotation = update Secret + restart compute.
CLOUD_ADMIN_MD5="${CLOUD_ADMIN_MD5:-b093c0d3b281ba6da1eacc608620abd8}"

echo "Rendering compute spec (tenant=${TENANT_ID} timeline=${TIMELINE_ID})"
sed -e "s|TENANT_ID|${TENANT_ID}|g" -e "s|TIMELINE_ID|${TIMELINE_ID}|g" \
    -e "s|CLOUD_ADMIN_MD5_PLACEHOLDER|${CLOUD_ADMIN_MD5}|g" "$SRC" > "$DST"

echo "Starting compute_ctl"
exec /usr/local/bin/compute_ctl --pgdata /var/db/postgres/compute \
     -C "postgresql://cloud_admin@localhost:55433/postgres" \
     -b /usr/local/bin/postgres \
     --compute-id "compute-${HOSTNAME:-k8s}" \
     --config "${DST}"
