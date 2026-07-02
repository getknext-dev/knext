#!/bin/sh
# TLS acceptance for the gateway front door (task 5D).
#
#   1. sslmode=require THROUGH the gateway succeeds AND the server reports a live
#      TLS connection (pg_stat_ssl.ssl = t) -> the wire is actually encrypted.
#   2. sslmode=disable still works -> TLS is optional, not enforced (no regression
#      for existing plaintext clients / sslmode=disable DSNs).
#   3. the wake path works over TLS -> a cold connect (compute at 0) with
#      sslmode=require wakes the compute and returns rows over the encrypted wire.
#
# Client runs in-cluster (kubectl run) with the compute-node image (ships psql +
# openssl). Bounded + self-cleaning like the other drills. Prereq: the pggw-tls
# Secret exists (deploy/gen-tls.sh) and 10-gateway.yaml is applied with the TLS
# env; this drill fails with a clear hint if TLS is not actually live.
set -eu
NS=scale-zero-pg
K="kubectl -n $NS"
BASE="cloud_admin:cloud_admin@pggw:55432/postgres"
DSN_REQUIRE="postgres://$BASE?sslmode=require"
DSN_DISABLE="postgres://$BASE?sslmode=disable"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# psql one-shot from a throwaway in-cluster pod (image already on the node).
# create, wait, read logs, delete — no attach race.
CLIENT() { # $1 tag  $2 dsn  $3 sql
  P=tlsclient-$$-$1
  $K run "$P" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
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

# 1. sslmode=require succeeds AND the server confirms a live TLS session.
#    pg_stat_ssl is a default system view; -tA yields e.g. "t|TLSv1.3".
PROOF=$(CLIENT require "$DSN_REQUIRE" \
  "select ssl, version from pg_stat_ssl where pid = pg_backend_pid()" | tail -1) \
  || fail "sslmode=require could NOT connect through the gateway"
case "$PROOF" in
  t\|TLS*) ok "sslmode=require -> SSL connection confirmed: pg_stat_ssl = $PROOF" ;;
  *) fail "sslmode=require connected but server reports no TLS (pg_stat_ssl = '$PROOF')" ;;
esac

# 2. sslmode=disable still works (TLS optional, no regression).
[ "$(CLIENT disable "$DSN_DISABLE" 'select 1' | tail -1)" = "1" ] \
  || fail "sslmode=disable regressed — plaintext startup must still work"
ok "sslmode=disable still connects (TLS is optional, not enforced)"

# 3. wake path over TLS: force compute to 0, cold-connect with sslmode=require.
$K scale deploy/compute --replicas=0 >/dev/null
i=0; while [ "$(COMPUTE_PODS)" != "0" ]; do i=$((i+1)); [ $i -gt 60 ] && fail "compute did not reach 0"; sleep 1; done
ok "compute at zero (no pods)"
T0=$(date +%s)
OUT=$(CLIENT wake "$DSN_REQUIRE" \
  "select ssl from pg_stat_ssl where pid = pg_backend_pid()" | tail -1) \
  || fail "cold connect over TLS failed to wake/return"
T1=$(date +%s)
[ "$OUT" = "t" ] || fail "cold TLS connect did not run over SSL (pg_stat_ssl.ssl = '$OUT')"
[ "$(COMPUTE_PODS)" = "1" ] || fail "compute pod not running after TLS wake"
ok "cold connect over TLS (sslmode=require) woke compute 0->1 in $((T1-T0))s, session encrypted"

echo "TLS verification: sslmode=require encrypted + confirmed, sslmode=disable intact, wake-over-TLS passed"
