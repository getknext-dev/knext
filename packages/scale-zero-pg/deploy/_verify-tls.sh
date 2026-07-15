#!/bin/sh
# TLS acceptance for the gateway front door (task 5D).
#
#   1. sslmode=require THROUGH the gateway succeeds AND psql reports a live TLS
#      session (\conninfo "SSL connection ...") -> the CLIENT<->GATEWAY wire is
#      actually encrypted. (pg_stat_ssl is deliberately NOT used: it reflects the
#      gateway<->compute backend hop, which is internal plaintext.)
#   2. sslmode=disable still works -> TLS is optional, not enforced (no regression
#      for existing plaintext clients / sslmode=disable DSNs).
#   3. the wake path works over TLS -> a cold connect (compute at 0) with
#      sslmode=require wakes the compute and establishes an encrypted session.
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

echo "TLS verification: sslmode=require encrypted + confirmed, sslmode=disable intact, wake-over-TLS passed"
