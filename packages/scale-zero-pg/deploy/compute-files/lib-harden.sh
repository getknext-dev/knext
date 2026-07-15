# shellcheck shell=sh
# lib-harden.sh — SINGLE SOURCE OF TRUTH for the compute pg_hba harden (issues
# #112 + #117 + #164). Sourced by all three compute entrypoints so the harden can
# never drift across tiers:
#   - entrypoint.sh       (primary / per-app writer, deploy/54 + operator render)
#   - entrypoint-ro.sh    (read-replica pool, deploy/26 base + operator per-app RO)
#   - entrypoint-warm.sh  (warm tier, deploy/25, ADR-0002)
# POSIX sh (also valid under bash) — no bashisms; only psql/awk/grep/sleep, all of
# which the stock compute image (neondatabase/compute-node-v17) ships.
#
# harden_pg_hba (issues #112 + #117): once Postgres is accepting loopback
# connections, (1) insert a `host all cloud_admin all reject` line JUST BEFORE the
# network catch-all (issue #112 — cloud_admin loopback-only), and (2) rewrite that
# catch-all's method from md5 to `scram-sha-256` (issue #117 — enforce SCRAM on the
# wire; an md5-only client, or any role still carrying an md5 verifier, is refused).
# The app role itself already carries a SCRAM verifier FROM BOOT (its spec
# encrypted_password is the precomputed APP_ROLE_VERIFIER on the primary writer, and
# on a READ replica the SAME verifier is REPLICATED from the primary catalog via WAL),
# so there is NO cold-wake md5 window: even before this reload lands the md5 catch-all
# auto-negotiates SCRAM against the SCRAM verifier. Order matters and is safe:
# compute_ctl's initdb pg_hba lists the loopback lines (127.0.0.1/32, ::1/128 -> trust)
# FIRST, so pg_hba's first-match rule keeps cloud_admin working over loopback (the pod's
# own admin ops connect cloud_admin@localhost:55433) while rejecting it from every other
# address, and app roles (app_<app>) fall through to the SCRAM catch-all so the
# apps-gateway path keeps working. This is the ENFORCING, CNI-independent tenant boundary
# (flannel ships no NetworkPolicy controller, so 70-networkpolicy.yaml is defense-in-depth
# only). Runs in the background so it never delays the wake/readiness path.
#
# Gating (identical across all three entrypoints): call `harden_pg_hba &` ONLY when
# APP_ROLE is set (a per-app compute — writer, RO replica, or warm). On the base
# single-DB tiers (primary / compute-ro / compute-warm, no APP_ROLE) cloud_admin IS the
# documented TCP credential the clients present through the gateway, so the harden is
# deliberately SKIPPED there (that single-tenant path is defended by NetworkPolicy +
# operator posture, docs/operations.md "Network isolation caveat"). This keeps the base
# DATABASE_URL / DATABASE_URL_RO cloud_admin-over-TCP paths working unchanged.
harden_pg_hba() {
  HBA="${PGDATA:-/var/db/postgres/compute}/pg_hba.conf"
  PSQL="psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc"
  i=0
  while [ $i -lt 600 ]; do
    $PSQL 'select 1' >/dev/null 2>&1 && break
    i=$((i+1)); sleep 0.2
  done
  [ -f "$HBA" ] || { echo "WARN issue #112: $HBA absent; cloud_admin still protected by strong md5"; return 0; }
  # Insert the cloud_admin reject before the first `host all all all <method>`
  # catch-all AND rewrite that catch-all's method to scram-sha-256 (issue #117).
  awk '{
    if ($1=="host" && $2=="all" && $3=="all" && $4=="all" && !d){
      print "host\tall\tcloud_admin\tall\treject"; d=1
    }
    if ($1=="host" && $2=="all" && $3=="all" && $4=="all"){
      print "host\tall\tall\tall\tscram-sha-256"; next
    }
    print
  }' "$HBA" > "$HBA.harden" 2>/dev/null && cat "$HBA.harden" > "$HBA" && rm -f "$HBA.harden"
  if grep -qiE '^host[[:space:]]+all[[:space:]]+cloud_admin[[:space:]]+all[[:space:]]+reject' "$HBA"; then
    if $PSQL 'SELECT pg_reload_conf()' >/dev/null 2>&1; then
      echo "issue #112/#117: cloud_admin loopback-only + wire auth is scram-sha-256; pg_hba reloaded"
    else
      echo "WARN issue #112: pg_hba reload failed; cloud_admin still protected by strong random md5"
    fi
  else
    echo "WARN issue #112: could not locate the network catch-all in pg_hba; cloud_admin still protected by strong random md5"
  fi
}
