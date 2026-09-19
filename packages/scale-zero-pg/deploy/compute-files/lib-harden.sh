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
# harden_pg_hba (issues #112 + #117 + F5 phase 4): once Postgres is accepting loopback
# connections, (1) insert a `host all cloud_admin all reject` line JUST BEFORE the
# network catch-all (issue #112 — cloud_admin loopback-only), and (2) rewrite that
# catch-all to `hostssl all all all scram-sha-256 clientcert=verify-ca` (issue #117 —
# enforce SCRAM on the wire; an md5-only client, or any role still carrying an md5
# verifier, is refused — PLUS F5 phase 4: the connection must be TLS *and* present a
# client certificate the compute's ssl_ca_file CA verifies, i.e. the gateway's own
# leaf. `clientcert=verify-ca` is an auth OPTION and therefore sits AFTER the method
# field, which is where pg_hba expects options; before it is a parse error that FATALs
# the reload).
#
# WHY verify-ca AND NOT verify-full (do NOT "upgrade" this token):
# `clientcert=verify-full` does not just verify the client certificate's chain — it
# ADDITIONALLY requires the certificate's COMMON NAME to EQUAL the connecting database
# username (or to map to it via a `map=` usermap + pg_ident.conf, neither of which this
# deployment has). The gateway holds ONE SHARED client leaf whose CN is a service name
# (see the gateway client leaf in deploy/11-mtls-certs.yaml) and connects as the app
# role
# `app_<app>` — it replays the app's own startup packet. Under verify-full every
# gateway→compute connection would be refused ("certificate validation … common name
# mismatch") the instant this backgrounded harden reloads pg_hba on a wake: a total,
# wake-triggered per-app data-plane outage. verify-ca is exactly the intended split —
# the CERTIFICATE proves "issued by our shared CA" (the mTLS identity), and
# SCRAM-SHA-256 authenticates the USER. Going to verify-full would first require
# per-role client certificates (CN == app_<app>) or a pg_ident usermap.
#
# The cloud_admin reject deliberately stays BROAD `host`, never `hostssl`:
# it must refuse cloud_admin over ANY transport — narrowing it to hostssl would let a
# PLAINTEXT cloud_admin attempt fall past it (only to be refused by the hostssl
# catch-all, but on a rule that says nothing about cloud_admin).
# The app role itself already carries a SCRAM verifier FROM BOOT (its spec
# encrypted_password is the precomputed APP_ROLE_VERIFIER on the primary writer, and
# on a READ replica the SAME verifier is REPLICATED from the primary catalog via WAL),
# so there is NO cold-wake md5 window: even before this reload lands the md5 catch-all
# auto-negotiates SCRAM against the SCRAM verifier. The CLIENT-CERT half is NOT
# analogous and is stated honestly: harden_pg_hba is invoked BACKGROUNDED (`&`) by the
# entrypoints so it never delays the wake path, so between "Postgres accepts
# connections" and "the reload has landed" there IS a window in which the catch-all is
# still the initdb `host … md5` line — TLS and a client certificate are NOT yet
# required on a freshly-woken compute. Enforcement lands at the reload, not at first
# accept. What closes that window in practice is the OTHER side of the hop: the
# gateway ships GW_COMPUTE_TLS=true (F5 phase 3), so the only dialer of a per-app
# compute is already presenting TLS + its client leaf during the window, and the
# window itself is reachable only from inside the cluster network. Any drill asserting
# enforcement must therefore POLL for the `hostssl … clientcert=verify-ca` line
# before testing a rejection, or it will race the reload. Order matters and is safe:
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
# stage_tls_key (F5 phase 2, ADR-0003): make the compute OFFER TLS without Postgres
# refusing to start on the key's file permissions. Postgres aborts at startup if
# ssl_key_file is group/world-readable OR not owned by the DB user/root
# ("private key file has group or world access"). A k8s Secret volume mounts the key
# root-owned and world-readable (0644), which Postgres rejects — and a root-owned
# 0600 mount the non-root postgres process could not even READ. So we COPY the
# mounted key to a private path and chmod 600 it BEFORE compute_ctl starts Postgres:
# this entrypoint already runs as the image's non-root `postgres` user (the compute
# sets no runAsUser/fsGroup and PGDATA lives on the container fs, not a mounted
# volume — so an fsGroup would neither be needed nor touch PGDATA), so the copy is
# owned by that same postgres user with no group/world bits — Postgres's accepted
# case — with ZERO securityContext change to the wake-critical boot. The server cert
# and CA cert are public, so their GUCs point straight at the 0644 mounts.
#
# ssl=on is a RESTART-only GUC set via the compute_ctl spec (config.json
# spec.cluster.settings), so it takes effect when compute_ctl starts Postgres — the
# Recreate + 0<->N model satisfies that for free; there is NO post-boot reload path.
#
# OFFER-not-require + independently safe: ssl is enabled ONLY when BOTH the server key
# AND the CA file are readable + non-empty. The server cert+key co-arrive in ONE Secret
# (pggw-compute-server-tls), but the CA is a SEPARATE `optional: true` Secret mounted at
# $SERVER_CA_SRC (ssl_ca_file). If we enabled ssl on the key alone and the CA were
# absent/empty, Postgres would FATAL in be_tls_init ("could not load root certificate
# file") and crash-loop that DB. So we gate on ALL required files: everything present ->
# serve TLS; ANYTHING missing/empty -> STRIP the four ssl GUCs from the rendered spec and
# boot PLAINTEXT rather than crash-loop (a bare local cluster without cert-manager mounts
# neither Secret; the volumes are `optional: true` so the pod still schedules). A missing
# or PARTIAL cert set therefore never crashes. pg_hba is untouched either way (its
# TLS-required rewrite is a later phase), so an existing plaintext gateway connection
# keeps working.
SERVER_KEY_SRC=/etc/pggw-compute-server-tls/tls.key
SERVER_KEY_DST=/tmp/pggw-server-tls.key
SERVER_CA_SRC=/etc/pggw-mtls-ca/ca.crt
stage_tls_key() {
  _spec="${1:?stage_tls_key needs the rendered compute_ctl spec path}"
  if [ -r "$SERVER_KEY_SRC" ] && [ -s "$SERVER_KEY_SRC" ] && \
     [ -r "$SERVER_CA_SRC" ]  && [ -s "$SERVER_CA_SRC" ]; then
    cp "$SERVER_KEY_SRC" "$SERVER_KEY_DST"
    chmod 600 "$SERVER_KEY_DST"
    echo "F5 phase 2: staged compute server TLS key -> $SERVER_KEY_DST (0600, postgres-owned); server cert + CA present; Postgres serves ssl=on"
  else
    # Key or CA missing/empty -> drop the ssl GUCs so Postgres boots plaintext. JSON-aware
    # and ORDER-INDEPENDENT: remove each single-line ssl-GUC object, then strip any comma
    # left dangling immediately before an array/object close. A plain `grep -v` was only
    # valid while the four ssl GUCs were the FIRST array elements — reordering them to the
    # tail would leave the previous element's trailing comma before `]`, i.e. invalid JSON
    # and a crash. This awk is correct regardless of the GUCs' position; the compute image
    # ships no jq/python3, so the removal stays in awk (available) and is self-repairing.
    awk '
      /^[[:space:]]*\{[[:space:]]*"name":[[:space:]]*"ssl/ { next }
      {
        if (have) {
          if ($0 ~ /^[[:space:]]*[]}]/ && prev ~ /,[[:space:]]*$/) sub(/,[[:space:]]*$/, "", prev)
          print prev
        }
        prev = $0; have = 1
      }
      END { if (have) print prev }
    ' "$_spec" > "$_spec.notls" && mv "$_spec.notls" "$_spec"
    echo "F5 phase 2: server TLS key or CA missing/empty ($SERVER_KEY_SRC, $SERVER_CA_SRC) — removed ssl GUCs; compute boots PLAINTEXT (offer-not-require, independently safe)"
  fi
}

harden_pg_hba() {
  HBA="${PGDATA:-/var/db/postgres/compute}/pg_hba.conf"
  PSQL="psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc"
  i=0
  while [ $i -lt 600 ]; do
    $PSQL 'select 1' >/dev/null 2>&1 && break
    i=$((i+1)); sleep 0.2
  done
  [ -f "$HBA" ] || { echo "WARN issue #112: $HBA absent; cloud_admin still protected by strong md5"; return 0; }
  # F5 phase 4 gate — enforce client-cert mTLS ONLY when this compute is ACTUALLY
  # serving TLS. `SHOW ssl` over loopback is the ground truth (it reflects what the
  # running postmaster has, including stage_tls_key's GUC-strip plaintext fallback).
  # This gate is not optional: Postgres REJECTS a `hostssl` line outright when ssl is
  # off ("hostssl record cannot match because SSL is disabled"), and a single bad line
  # makes the whole file fail to parse — on SIGHUP the new file is DISCARDED and the
  # previous configuration kept, while pg_reload_conf() still returns true. Writing an
  # unconditional hostssl catch-all onto a plaintext-fallback compute would therefore
  # silently throw away the #112 cloud_admin reject and the #117 SCRAM catch-all too.
  # So: serving TLS -> enforce; not serving TLS -> keep the pre-phase-4 `host … scram`
  # catch-all (#112/#117 intact) and say so loudly, since mTLS is then NOT enforced.
  _ssl=$($PSQL 'SHOW ssl' 2>/dev/null | tr -d '[:space:]')
  if [ "$_ssl" = "on" ]; then
    _catchall='hostssl\tall\tall\tall\tscram-sha-256\tclientcert=verify-ca'
    _want='^hostssl[[:space:]]+all[[:space:]]+all[[:space:]]+all[[:space:]]+scram-sha-256[[:space:]]+clientcert=verify-ca'
  else
    _catchall='host\tall\tall\tall\tscram-sha-256'
    _want='^host[[:space:]]+all[[:space:]]+all[[:space:]]+all[[:space:]]+scram-sha-256'
  fi
  # Insert the cloud_admin reject before the first `host all all all <method>`
  # catch-all AND replace that catch-all with $_catchall. The reject stays broad
  # `host` in BOTH modes; only the catch-all can become `hostssl`.
  # IDEMPOTENT IN BOTH MODES: `r` records that a cloud_admin reject was already seen,
  # and the insert is skipped when it was. This matters for the PLAINTEXT-FALLBACK
  # branch, whose catch-all stays `host all all all …` and therefore still matches on a
  # second harden pass — without the guard each pass would append ANOTHER reject and
  # grow pg_hba without bound (inert under first-match, but wrong, and drills read that
  # file). Single pass is sufficient: the reject is always written immediately BEFORE
  # the catch-all, so it has already gone by when the catch-all line is read. The
  # enforced branch does not need the guard (its catch-all becomes `hostssl`, which no
  # longer matches $1=="host") but gets it too — one rule, both modes.
  awk -v catchall="$_catchall" '{
    if ($1=="host" && $2=="all" && $3=="cloud_admin" && $5=="reject") r=1
    if ($1=="host" && $2=="all" && $3=="all" && $4=="all" && !d){
      if (!r) print "host\tall\tcloud_admin\tall\treject"
      d=1
    }
    if ($1=="host" && $2=="all" && $3=="all" && $4=="all"){
      print catchall; next
    }
    print
  }' "$HBA" > "$HBA.harden" 2>/dev/null && cat "$HBA.harden" > "$HBA" && rm -f "$HBA.harden"
  if grep -qiE '^host[[:space:]]+all[[:space:]]+cloud_admin[[:space:]]+all[[:space:]]+reject' "$HBA" && \
     grep -qiE "$_want" "$HBA"; then
    if $PSQL 'SELECT pg_reload_conf()' >/dev/null 2>&1; then
      if [ "$_ssl" = "on" ]; then
        echo "issue #112/#117 + F5 phase 4: cloud_admin loopback-only, wire auth scram-sha-256, and TLS with a CA-verified client certificate REQUIRED (hostssl … clientcert=verify-ca); pg_hba reloaded — enforcement ACTIVE from here (it was NOT enforced in the window between first-accept and this reload)"
      else
        echo "WARN issue #112/#117 + F5 phase 4: this compute is NOT serving TLS (ssl=$_ssl — no server cert/CA mounted), so client-cert mTLS is NOT enforced; kept the host/scram-sha-256 catch-all (a hostssl line would make the whole pg_hba fail to parse and silently drop the cloud_admin reject too); pg_hba reloaded"
      fi
    else
      echo "WARN issue #112 + F5 phase 4: pg_hba reload failed — the hardened rules are WRITTEN but NOT ACTIVE until the next reload/restart; cloud_admin still protected by strong random md5"
    fi
  else
    echo "WARN issue #112 + F5 phase 4: could not locate/rewrite the network catch-all in pg_hba — client-cert mTLS is NOT enforced on this compute; cloud_admin still protected by strong random md5"
  fi
}
