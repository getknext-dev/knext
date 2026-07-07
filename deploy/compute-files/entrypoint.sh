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
PGDATA=/var/db/postgres/compute
# The publicly-documented dev md5 = md5("cloud_admin"||"cloud_admin"). It is a
# SKELETON KEY (issue #112) and must never reach a compute that holds tenant data.
PUBLIC_CLOUD_ADMIN_MD5=b093c0d3b281ba6da1eacc608620abd8

# cloud_admin credential + trust boundary (issue #112 CRITICAL).
#
# On a PER-APP compute (APP_ROLE set) cloud_admin is used EXCLUSIVELY over the
# pod-local loopback: compute_ctl's own boot connection and provision-app.sh /
# the drills all `psql -h localhost`, which the initdb pg_hba TRUSTS (see the
# harden step below). It is NEVER presented over the pod network — apps reach the
# compute only through the apps-gateway as the per-app role app_<app>. So on a
# per-app compute we HARD-DISABLE the public default: an unset (or the public)
# CLOUD_ADMIN_MD5 becomes a strong random, unguessable md5. Combined with the
# pg_hba loopback-binding below, a co-tenant pod dialing compute-<app>:55433
# directly can neither guess the password NOR be admitted as cloud_admin.
#
# On the PRIMARY single-DB compute (no APP_ROLE) cloud_admin IS the documented
# credential clients present THROUGH the primary gateway over TCP, so there we
# keep the dev-default fallback (fresh local clusters just work); that path is a
# single tenant, not a cross-tenant boundary, and is defended by NetworkPolicy +
# operator posture (docs/operations.md "Network isolation caveat").
if [ -n "${APP_ROLE:-}" ]; then
  if [ -z "${CLOUD_ADMIN_MD5:-}" ] || [ "${CLOUD_ADMIN_MD5}" = "$PUBLIC_CLOUD_ADMIN_MD5" ]; then
    CLOUD_ADMIN_MD5="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
    echo "issue #112: per-app compute cloud_admin uses a strong random md5 (public default disabled)"
  fi
else
  CLOUD_ADMIN_MD5="${CLOUD_ADMIN_MD5:-$PUBLIC_CLOUD_ADMIN_MD5}"
fi

# harden_pg_hba (issues #112 + #117): factored into the SHARED lib-harden.sh so
# the primary / RO / warm entrypoints cannot drift (issue #164). It inserts the
# cloud_admin loopback-only reject (#112) + rewrites the pg_hba network catch-all
# md5 -> scram-sha-256 (#117). Sourced with an absolute path from the mounted
# compute-files ConfigMap. See lib-harden.sh for the full rationale.
. /compute-files/lib-harden.sh

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

# Per-app role (issue #74, branch-per-app tenant isolation; SCRAM under issue #117).
# When BOTH APP_ROLE and APP_ROLE_VERIFIER are set (per-app computes get them from
# compute-config-<app> and the Secret app-db-<app>), inject an extra LOGIN role into the
# spec's roles array. APP_ROLE_VERIFIER is a PRECOMPUTED SCRAM-SHA-256 verifier
# (SCRAM-SHA-256$...); compute_ctl stores a recognised verifier VERBATIM as the role's
# encrypted_password (only a bare md5-hex value gets the "md5" prefix), so the app role
# is SCRAM FROM BOOT with NO tenant plaintext on the compute. compute_ctl applies spec
# roles on every boot, so the credential is (re)asserted each wake. This is ADDITIVE: the
# primary single-DB compute and the seed-time tmpl compute set neither var, so the block
# is skipped and their spec is byte-for-byte unchanged (zero blast radius).
if [ -n "${APP_ROLE:-}" ] && [ -n "${APP_ROLE_VERIFIER:-}" ]; then
  echo "Injecting per-app login role ${APP_ROLE} (SCRAM verifier)"
  ROLE_JSON="{\"name\": \"${APP_ROLE}\", \"encrypted_password\": \"${APP_ROLE_VERIFIER}\", \"options\": null},"
  awk -v r="$ROLE_JSON" 'BEGIN{done=0}{print}(done==0 && /"roles": \[/){print "                    " r; done=1}' \
      "$DST" > "$DST.tmp" && mv "$DST.tmp" "$DST"
fi

# Per-app tenant boundary + SCRAM wire enforcement: reconcile pg_hba (loopback-only
# cloud_admin #112 + scram-sha-256 wire auth #117) once Postgres is up. Backgrounded
# before exec so the wake path is never blocked; a no-op on the primary/tmpl-less
# single-DB compute (no APP_ROLE).
if [ -n "${APP_ROLE:-}" ]; then
  harden_pg_hba &
fi

echo "Starting compute_ctl"
exec /usr/local/bin/compute_ctl --pgdata "$PGDATA" \
     -C "postgresql://cloud_admin@localhost:55433/postgres" \
     -b /usr/local/bin/postgres \
     --compute-id "compute-${HOSTNAME:-k8s}" \
     --config "${DST}"
