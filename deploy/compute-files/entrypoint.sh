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

# Per-app connection cap (issue #89, tenant quotas). When PG_MAX_CONNECTIONS is set
# (per-app computes get it from compute-config-<app>), override ONLY the
# max_connections value in the rendered spec so an operator can bound one tenant's
# server-side backends below the 100 default. Additive + surgical: absent -> the
# spec is byte-for-byte unchanged (primary single-DB / tmpl / any compute without
# the var), and config.json is untouched (warm/ro entrypoints unaffected). Each app
# is its own Postgres, so this is the per-app bound; a runaway app cannot exhaust a
# neighbour's backends. (The apps-gateway GW_MAX_CONNS is a separate process-wide
# goroutine ceiling — see ADR-0003 "noisy-neighbour".)
if [ -n "${PG_MAX_CONNECTIONS:-}" ]; then
  echo "Applying per-app max_connections=${PG_MAX_CONNECTIONS}"
  awk -v mc="${PG_MAX_CONNECTIONS}" '
    prev ~ /"name": "max_connections"/ && /"value":/ { sub(/"value": "[0-9]+"/, "\"value\": \"" mc "\"") }
    { print; prev=$0 }' "$DST" > "$DST.tmp" && mv "$DST.tmp" "$DST"
fi

# Per-app role (issue #74, branch-per-app tenant isolation). When BOTH APP_ROLE
# and APP_ROLE_MD5 are set (per-app computes get them from compute-config-<app>
# and the Secret app-db-<app>), inject an extra LOGIN role into the spec's roles
# array. compute_ctl applies spec roles on every boot, so the per-app credential
# is (re)asserted each wake — the documented MVP behavior. This is ADDITIVE: the
# primary single-DB compute and the seed-time tmpl compute set neither var, so the
# block is skipped and their spec is byte-for-byte unchanged (zero blast radius).
if [ -n "${APP_ROLE:-}" ] && [ -n "${APP_ROLE_MD5:-}" ]; then
  echo "Injecting per-app login role ${APP_ROLE}"
  ROLE_JSON="{\"name\": \"${APP_ROLE}\", \"encrypted_password\": \"${APP_ROLE_MD5}\", \"options\": null},"
  awk -v r="$ROLE_JSON" 'BEGIN{done=0}{print}(done==0 && /"roles": \[/){print "                    " r; done=1}' \
      "$DST" > "$DST.tmp" && mv "$DST.tmp" "$DST"
fi

echo "Starting compute_ctl"
exec /usr/local/bin/compute_ctl --pgdata /var/db/postgres/compute \
     -C "postgresql://cloud_admin@localhost:55433/postgres" \
     -b /usr/local/bin/postgres \
     --compute-id "compute-${HOSTNAME:-k8s}" \
     --config "${DST}"
