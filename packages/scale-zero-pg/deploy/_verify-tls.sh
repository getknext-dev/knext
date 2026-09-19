#!/bin/sh
# TLS acceptance for the gateway front door (task 5D).
#
#   1. sslmode=require THROUGH the gateway succeeds AND psql reports a live TLS
#      session (\conninfo "SSL connection ...") -> the CLIENT<->GATEWAY wire is
#      actually encrypted. (pg_stat_ssl is deliberately NOT used: it reports the
#      gateway<->compute BACKEND session, a different leg — section 4 covers that one.)
#   2. sslmode=disable still works -> TLS is optional, not enforced (no regression
#      for existing plaintext clients / sslmode=disable DSNs).
#   3. the wake path works over TLS -> a cold connect (compute at 0) with
#      sslmode=require wakes the compute and establishes an encrypted session.
#
#   4. the gateway<->compute BACKEND hop is mutually authenticated (ADR-0003): on a
#      per-app compute, once the pg_hba harden has landed, a TLS connection with NO
#      client certificate is refused with "connection requires a valid client
#      certificate", the gateway's own identity still gets through, and the pod-local
#      cloud_admin loopback path is unaffected. Section 4 needs a cluster AND a
#      provisioned per-app compute; with none present it prints a note and skips
#      (set TLS_MTLS_APP=<app> to pin one). The off-cluster half of the same contract
#      — that the shipped harden produces exactly those rules — is
#      deploy/test_harden_pghba.sh, which runs in CI with no cluster at all.
#
# Client runs in-cluster (kubectl run) with the compute-node image (ships psql +
# openssl). Bounded + self-cleaning like the other drills. Prereq: the pggw-tls
# Secret exists (deploy/gen-tls.sh) and 10-gateway.yaml is applied with the TLS
# env; this drill fails with a clear hint if TLS is not actually live.
set -eu
NS=scale-zero-pg
K="kubectl -n $NS"
# Throwaway psql CLIENT pods use a small, ALWAYS-PULLABLE psql image (issue #171):
# the neon compute image is pre-pulled on only SOME nodes, so a client pod pinned
# to it with imagePullPolicy=Never intermittently hits ErrImageNeverPull (and its
# 150s pod-wait then expires). postgres:17-alpine ships a v17 psql, is public +
# ~80MB, and schedules on ANY node with a normal pull policy. Override via PSQL_IMG.
PSQL_IMG="${PSQL_IMG:-postgres:17-alpine}"
# Base cloud_admin credential (issue #168): from the DATABASE_URL Secret, not the default.
CA_CRED=$($K get secret myapp-database -o jsonpath='{.data.DATABASE_URL}' 2>/dev/null | base64 -d 2>/dev/null | sed -E 's#^postgres://(.*)@[^@]*#\1#'); [ -n "$CA_CRED" ] || CA_CRED="cloud_admin:cloud_admin"
BASE="${CA_CRED}@pggw:55432/postgres"
DSN_REQUIRE="postgres://$BASE?sslmode=require"
DSN_DISABLE="postgres://$BASE?sslmode=disable"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# psql one-shot from a throwaway in-cluster pod (image already on the node).
# create, wait, read logs, delete — no attach race.
CLIENT() { # $1 tag  $2 dsn  $3 sql
  P=tlsclient-$$-$1
  $K run "$P" --image="$PSQL_IMG" --image-pull-policy=IfNotPresent \
    --restart=Never --quiet --command -- psql "$2" -tA -c "$3" >/dev/null
  $K wait --for=jsonpath='{.status.phase}'=Succeeded pod/$P --timeout=150s >/dev/null 2>&1 || true
  OUT=$($K logs "$P" 2>&1)
  PHASE=$($K get pod "$P" -o jsonpath='{.status.phase}' 2>/dev/null)
  $K delete pod "$P" --ignore-not-found --wait=false >/dev/null 2>&1
  [ "$PHASE" = "Succeeded" ] || { echo "client $1 failed ($PHASE): $OUT"; return 1; }
  echo "$OUT"
}
COMPUTE_PODS() { $K get pods -l app=compute --no-headers 2>/dev/null | grep -c . || true; }

# 0. gateway ready + TLS actually configured on it
$K rollout status deploy/pggw --timeout=120s >/dev/null || fail "gateway not ready"
$K get deploy pggw -o jsonpath='{.spec.template.spec.containers[0].env[*].name}' \
  | grep -q GW_TLS_CERT_FILE || fail "pggw has no GW_TLS_CERT_FILE — apply deploy/10-gateway.yaml"
$K get secret pggw-tls >/dev/null 2>&1 || fail "Secret pggw-tls missing — run deploy/gen-tls.sh first"
ok "gateway ready with TLS configured (pggw-tls mounted)"

# 0b. apps-gateway (pggw-apps) must ALSO serve TLS (issue #113). Config-level
#     assertion here (mount + env); the LIVE sslmode=require proof to pggw-apps
#     runs in _verify-multitenant.sh (needs a provisioned per-app credential).
if $K get deploy pggw-apps >/dev/null 2>&1; then
  $K get deploy pggw-apps -o jsonpath='{.spec.template.spec.containers[0].env[*].name}' \
    | grep -q GW_TLS_CERT_FILE || fail "pggw-apps has no GW_TLS_CERT_FILE — apply deploy/81-apps-gateway.yaml (issue #113)"
  $K get deploy pggw-apps -o jsonpath='{.spec.template.spec.volumes[*].secret.secretName}' \
    | grep -q pggw-tls || fail "pggw-apps does not mount the pggw-tls Secret (issue #113)"
  ok "apps-gateway (pggw-apps) configured for front-door TLS (pggw-tls mounted)"
else
  echo "note - pggw-apps not deployed; skipping apps-gateway TLS config check"
fi

# 1. sslmode=require succeeds AND psql confirms a live client-side TLS session.
#    \conninfo prints "SSL connection (protocol: TLSv1.3, cipher: ...)".
OUT=$(CLIENT require "$DSN_REQUIRE" '\conninfo') \
  || fail "sslmode=require could NOT connect through the gateway: $OUT"
echo "$OUT" | grep -q "SSL connection" \
  || fail "sslmode=require connected but psql reports no SSL: $OUT"
ok "sslmode=require -> $(echo "$OUT" | grep -o 'SSL connection.*' | head -1)"

# 2. sslmode=disable still works (TLS optional, no regression).
[ "$(CLIENT disable "$DSN_DISABLE" 'select 1' | tail -1)" = "1" ] \
  || fail "sslmode=disable regressed — plaintext startup must still work"
ok "sslmode=disable still connects (TLS is optional, not enforced)"

# 3. wake path over TLS: force compute to 0, cold-connect with sslmode=require.
$K scale deploy/compute --replicas=0 >/dev/null
i=0; while [ "$(COMPUTE_PODS)" != "0" ]; do i=$((i+1)); [ $i -gt 60 ] && fail "compute did not reach 0"; sleep 1; done
ok "compute at zero (no pods)"
T0=$(date +%s)
OUT=$(CLIENT wake "$DSN_REQUIRE" '\conninfo') \
  || fail "cold connect over TLS failed to wake/connect: $OUT"
T1=$(date +%s)
echo "$OUT" | grep -q "SSL connection" \
  || fail "cold TLS connect did not run over SSL: $OUT"
[ "$(COMPUTE_PODS)" = "1" ] || fail "compute pod not running after TLS wake"
ok "cold connect over TLS (sslmode=require) woke compute 0->1 in $((T1-T0))s, session encrypted"

# 4. F5 phase 4 — the COMPUTE ENFORCES client-cert mTLS on the gateway->compute hop.
#    Runs against a PER-APP compute (compute-<app>): the pg_hba harden is APP_ROLE-gated,
#    so the base single-DB tiers deliberately keep their cloud_admin-over-TCP path.
#
#    THE RACE THIS MUST NOT LOSE: harden_pg_hba is invoked backgrounded (`&`) so it never
#    delays the wake, so a freshly-woken compute serves the initdb pg_hba — TLS and the
#    client cert are NOT required — until the reload lands. So POLL for the enforced rule
#    first; asserting a rejection before that window closes tests nothing.
#
#    Then three assertions, which together are the enforcement proof:
#      (a) a TLS connection presenting NO client certificate is REFUSED, and refused for
#          the RIGHT reason ("connection requires a valid client certificate") — not a
#          password failure, which any wrong credential would produce;
#      (b) the gateway's identity IS accepted end to end (a query through pggw-apps
#          returns; the gateway is the only dialer holding the client leaf);
#      (c) the pod's own cloud_admin@localhost:55433 admin ops still work (first-match on
#          the untouched loopback trust lines) — otherwise every later harden/admin task
#          on that compute breaks.
#
#    LEG (b) IS MANDATORY WHENEVER THIS SECTION RUNS — it is the ONLY positive
#    gateway-path assertion in the whole drill, and legs (a)/(c) cannot substitute for
#    it: they pass just as happily when the enforced rule rejects the gateway itself
#    (e.g. a clientcert option that ties the certificate CN to the username, which the
#    shared gateway leaf can never satisfy). So a missing app-db-<app> Secret or missing
#    pggw-apps is a drill FAILURE here, not a quiet per-leg skip. The whole section may
#    be skipped (no per-app compute at all), but it may not half-run and still claim
#    enforcement — the closing line below reports only what ACTUALLY ran.
MTLS_CLAIM="gateway->compute client-cert mTLS NOT verified (no per-app compute on this cluster; set TLS_MTLS_APP=<app> to run that section)"
APP="${TLS_MTLS_APP:-$($K get deploy -l tier=apps,plane=compute -o jsonpath='{.items[0].metadata.labels.app}' 2>/dev/null | sed 's/^compute-//')}"
if [ -z "$APP" ]; then
  echo "note - no per-app compute (compute-<app>) on this cluster; skipping the F5 phase-4 pg_hba enforcement section ENTIRELY. Provision one (deploy/provision-app.sh) or set TLS_MTLS_APP=<app> to run it."
else
  D="deploy/compute-$APP"
  $K scale "$D" --replicas=1 >/dev/null
  $K rollout status "$D" --timeout=180s >/dev/null || fail "compute-$APP did not become ready"
  # the compute must actually be SERVING TLS — the harden gates enforcement on `SHOW ssl`,
  # so a cert-less compute keeps the pre-phase-4 rules and nothing below would be enforced.
  SSLON=$($K exec "$D" -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc 'SHOW ssl' 2>/dev/null | tr -d '[:space:]')
  [ "$SSLON" = "on" ] || fail "compute-$APP reports ssl=$SSLON — it is NOT serving TLS (cert-manager Secrets not mounted?), so the phase-4 harden deliberately did not enforce client certs. Fix the cert mounts before claiming mTLS."
  HBAPATH='${PGDATA:-/var/db/postgres/compute}/pg_hba.conf'
  ENFORCED_RE='^hostssl[[:space:]]+all[[:space:]]+all[[:space:]]+all[[:space:]]+scram-sha-256[[:space:]]+clientcert=verify-ca'
  i=0
  while [ $i -lt 120 ]; do
    $K exec "$D" -- sh -c "grep -qE '$ENFORCED_RE' $HBAPATH" >/dev/null 2>&1 && break
    i=$((i+1)); sleep 1
  done
  [ $i -lt 120 ] || fail "compute-$APP: the enforced rule (hostssl … clientcert=verify-ca) never appeared in pg_hba after 120s — the backgrounded harden did not complete; check the compute logs for the 'F5 phase 4' line"
  # the reload landed (harden reloads immediately after writing); confirm the running
  # server agrees the file is loadable — a parse error would leave the OLD config active.
  $K exec "$D" -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc \
    "select count(*) from pg_hba_file_rules where error is not null" 2>/dev/null | tr -d '[:space:]' | grep -qx 0 \
    || fail "compute-$APP: pg_hba has lines with parse ERRORS (pg_hba_file_rules.error) — on SIGHUP Postgres DISCARDS the whole file and keeps the previous config, so nothing below would really be enforced"
  ok "compute-$APP serves TLS and its pg_hba carries the enforced rule (hostssl … clientcert=verify-ca), error-free"

  # (a) TLS, NO client certificate -> refused, and for the client-certificate reason.
  NOCERT="postgres://app_$APP:wrongpw@compute-$APP.$NS.svc:55433/postgres?sslmode=require&connect_timeout=10"
  P=mtlsnocert-$$
  $K run "$P" --image="$PSQL_IMG" --image-pull-policy=IfNotPresent --restart=Never --quiet \
    --command -- sh -c "psql \"$NOCERT\" -tAc 'select 1' 2>&1 || true" >/dev/null 2>&1 || true
  j=0; while [ $j -lt 90 ]; do
    case "$($K get pod "$P" -o jsonpath='{.status.phase}' 2>/dev/null)" in Succeeded|Failed) break;; esac
    j=$((j+1)); sleep 1
  done
  OUT=$($K logs "$P" 2>&1); $K delete pod "$P" --ignore-not-found --wait=false >/dev/null 2>&1
  echo "$OUT" | grep -qi 'select 1\|^1$' \
    && fail "a TLS connection with NO client certificate SUCCEEDED against compute-$APP — client-cert mTLS is NOT enforced: $OUT"
  echo "$OUT" | grep -qi 'requires a valid client certificate' \
    || fail "compute-$APP refused the no-client-cert connection, but NOT for the client-certificate reason (a wrong password alone would also fail) — got: $OUT"
  ok "TLS without a client certificate is REFUSED by compute-$APP ('connection requires a valid client certificate')"

  # (b) the gateway's own identity is accepted: a query through pggw-apps returns.
  #     MANDATORY (see the section header): without this leg the drill proves only that
  #     SOMETHING is refused, never that the gateway is still let through — the exact
  #     failure a wrong clientcert option produces.
  APPPW=$($K get secret "app-db-$APP" -o jsonpath='{.data.PGPASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)
  [ -n "$APPPW" ] \
    || fail "no app-db-$APP Secret (PGPASSWORD) — the gateway-identity leg CANNOT run, and without it this drill would report 'mTLS enforced' while never once dialing through the gateway. Provision the app (deploy/provision-app.sh) or point TLS_MTLS_APP at an app that has its Secret."
  $K get deploy pggw-apps >/dev/null 2>&1 \
    || fail "no pggw-apps deployment — the gateway-identity leg CANNOT run against compute-$APP, and legs (a)/(c) alone cannot show the gateway is still accepted. Deploy the apps-gateway before claiming the hop is mutually authenticated."
  [ "$(CLIENT mtlsgw "postgres://app_$APP:$APPPW@pggw-apps:55432/$APP?sslmode=disable" 'select 1' | tail -1)" = "1" ] \
    || fail "the apps-gateway could no longer reach compute-$APP after enforcement — the gateway's client certificate is not being accepted (check GW_COMPUTE_TLS + the pggw-gateway-client-tls leaf against the compute's ssl_ca_file CA, and that the pg_hba option is clientcert=verify-ca: verify-full would reject the shared gateway leaf on a CN-vs-username mismatch)"
  ok "the gateway's client identity IS accepted: a query through pggw-apps reaches compute-$APP under enforcement"

  # (c) the pod's own loopback admin path is unaffected (first-match on the trust lines).
  [ "$($K exec "$D" -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc 'select 1' 2>/dev/null | tr -d '[:space:]')" = "1" ] \
    || fail "cloud_admin@localhost:55433 on compute-$APP broke — the harden must leave the loopback trust lines untouched (first-match), or every pod-local admin op fails"
  ok "loopback cloud_admin admin path on compute-$APP still works under enforcement"
  # Reached only if legs (a), (b) and (c) ALL ran and passed — every failure above exits.
  MTLS_CLAIM="gateway->compute client-cert mTLS ENFORCED on compute-$APP (no-client-cert TLS dial refused for the client-certificate reason; the gateway's own leaf accepted end to end through pggw-apps; loopback admin path intact)"
fi

echo "TLS verification: sslmode=require encrypted + confirmed, sslmode=disable intact, wake-over-TLS passed, $MTLS_CLAIM"
