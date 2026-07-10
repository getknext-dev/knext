#!/usr/bin/env bash
# _verify-wake-guard.sh — LIVE drill for the per-app WAKE budget (issue #116,
# ADR-0008). Proves the CNI-independent control for the unauthenticated wake
# side-channel:
#
#   1. NO REGRESSION — a LEGITIMATE single wake still works: an app connecting with
#      valid creds through pggw-apps wakes its sleeping compute 0->1 and gets a row
#      back (the wake-on-connect UX is untouched, within budget).
#   2. BUDGET CAP — an UNAUTHENTICATED in-cluster burst CANNOT force unbounded 0->1
#      churn: a co-tenant/foreign pod firing many startup packets (no valid password)
#      for one app wakes it at most GW_WAKE_BUDGET times, then the gateway REFUSES the
#      excess with a clean 53400 (compute NOT scaled past 1) and counts them.
#   3. OBSERVABLE — pggw_wake_budget_exceeded_total rises and the WakeBudgetExceeded
#      alert goes firing in alertmanager (plane=apps).
#
# It stands up ONE throwaway per-app branch (wgapp) via provision-app.sh and NEVER
# touches the live plane's real apps. It does NOT patch the live gateway env: it
# reads the configured GW_WAKE_BUDGET and simply fires (budget + EXCESS) attempts, so
# it is non-disruptive. The burst pod uses a bogus password — the wake happens BEFORE
# auth, which is exactly the #116 side-channel.
#
# Usage:
#   deploy/_verify-wake-guard.sh run       # full drill (provision -> prove -> teardown)
#   deploy/_verify-wake-guard.sh teardown  # remove the throwaway wgapp branch
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg),
#      APP (default wgapp), EXCESS (default 12 attempts over budget),
#      MIN_REFUSALS (default 4), ATK_IMAGE (default the compute image).
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
APP="${APP:-wgapp}"
EXCESS="${EXCESS:-12}"
MIN_REFUSALS="${MIN_REFUSALS:-4}"
ATK_IMAGE="${ATK_IMAGE:-${PSQL_IMG:-postgres:17-alpine}}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
log()  { printf '\033[36m[wake-guard]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[wake-guard] PASS:\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[wake-guard] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

app_pw() { K get secret "app-db-$1" -o jsonpath='{.data.PGPASSWORD}' | base64 -d; }
replicas_of() { K get deploy "compute-$1" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "?"; }
prom() { K exec deploy/prometheus -- wget -qO- "$1" 2>/dev/null; }

teardown() {
  log "teardown: destroying throwaway app $APP"
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$APP" --delete-timeline >/dev/null 2>&1 || true
  K delete pod -l wakeguard-drill=1 --ignore-not-found --wait=false >/dev/null 2>&1 || true
}

sleep0() {
  K scale deploy/"compute-$APP" --replicas=0 >/dev/null
  K wait --for=delete pod -l app="compute-$APP" --timeout=90s >/dev/null 2>&1 || sleep 5
}

case "${1:-run}" in
  teardown) teardown; ok "torn down"; exit 0;;
  run) ;;
  *) echo "usage: $0 run|teardown" >&2; exit 2;;
esac
trap teardown EXIT

# 0. preconditions -----------------------------------------------------------
K rollout status deploy/pggw-apps --timeout=120s >/dev/null || fail "apps-gateway not ready"
K rollout status deploy/prometheus --timeout=120s >/dev/null || fail "prometheus not ready"
ok "apps-gateway + prometheus ready"

# The control MUST be configured, else the whole side-channel is open. Read the
# live budget straight off the Deployment env.
BUDGET="$(K get deploy pggw-apps -o jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="GW_WAKE_BUDGET")]}{.value}{end}')"
[ -n "$BUDGET" ] || fail "GW_WAKE_BUDGET is UNSET on pggw-apps — the #116 wake-budget control is not deployed (apply deploy/81-apps-gateway.yaml with the wake-guard image)"
# The budget is enforced PER GATEWAY REPLICA (each pod runs its own in-memory
# token bucket), and the burst load-balances across all replicas — so the effective
# per-app ceiling before refusals begin is BUDGET * replicas. Fire past that.
REPLICAS="$(K get deploy pggw-apps -o jsonpath='{.spec.replicas}')"
REPLICAS="${REPLICAS:-1}"
ATTEMPTS=$(( BUDGET * REPLICAS + EXCESS ))
ok "wake budget configured: GW_WAKE_BUDGET=$BUDGET x ${REPLICAS} replica(s) => ~$(( BUDGET * REPLICAS )) ceiling; drill fires $ATTEMPTS unauth attempts"

# 1. provision the throwaway app --------------------------------------------
log "provisioning throwaway app $APP"
KCTX="$KCTX" NS="$NS" "$PROV" init-plane >/dev/null 2>&1 || true
KCTX="$KCTX" NS="$NS" "$PROV" create "$APP" --replicas 1 >/dev/null || fail "create $APP failed"
K rollout status deploy/"compute-$APP" --timeout=120s >/dev/null || fail "$APP compute not ready"
PW="$(app_pw "$APP")"
[ -n "$PW" ] || fail "could not read app-db-$APP password"
ok "provisioned $APP (its own branch + per-app compute)"

# 2. NO-REGRESSION — a legit single wake still works -------------------------
log "regression check: legit wake-on-connect (valid creds) after scale-to-zero"
sleep0
[ "$(replicas_of "$APP")" = "0" ] || fail "$APP compute did not scale to 0"
LEGIT_POD="wg-legit-$$"
K run "$LEGIT_POD" --image="$ATK_IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
  --labels=wakeguard-drill=1 --quiet --command -- \
  psql "postgres://app_$APP:$PW@pggw-apps:55432/$APP?sslmode=disable&connect_timeout=90" \
  -tAc 'select 42 as woke' >/dev/null 2>&1 || true
phase=""; i=0
while [ $i -lt 120 ]; do
  phase=$(K get pod "$LEGIT_POD" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
done
LEGIT_OUT="$(K logs "$LEGIT_POD" 2>&1 || true)"
K delete pod "$LEGIT_POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
printf '%s\n' "$LEGIT_OUT" | grep -q '42' \
  || fail "legit wake-on-connect REGRESSED: did not get a row back through pggw-apps (got: $LEGIT_OUT)"
ok "no regression: a legitimate single wake still cold-starts the app and returns a row"

# 3. BUDGET CAP — unauth burst cannot exceed the budget ---------------------
log "budget cap: firing $ATTEMPTS UNAUTHENTICATED parallel startups for $APP while it sleeps"
sleep0
[ "$(replicas_of "$APP")" = "0" ] || fail "$APP compute did not scale to 0 before burst"
# Snapshot the metric before the burst (via prometheus instant query).
BEFORE="$(prom "http://localhost:9090/api/v1/query?query=sum(pggw_wake_budget_exceeded_total%7Bgateway%3D%22pggw-apps%22%7D)" \
  | grep -o '"value":\[[^]]*\]' | grep -o '[0-9.]*"' | tr -d '"' | tail -1)"
BEFORE="${BEFORE:-0}"

BURST_POD="wg-burst-$$"
# One pod fires N psql in parallel (bogus password) so they all hit the gateway
# near-simultaneously WHILE the compute is at 0 — every attempt reaches the wake
# path and consults the budget. The refusal text is the gateway's 53400 message.
K run "$BURST_POD" --image="$ATK_IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
  --labels=wakeguard-drill=1 --quiet --command -- sh -c "
    for n in \$(seq 1 $ATTEMPTS); do
      PGPASSWORD=not-the-password psql \
        \"postgres://app_$APP:not-the-password@pggw-apps:55432/$APP?sslmode=disable&connect_timeout=30\" \
        -tAc 'select 1' 2>&1 &
    done
    wait
  " >/dev/null 2>&1 || true
phase=""; i=0
while [ $i -lt 150 ]; do
  phase=$(K get pod "$BURST_POD" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
done
BURST_OUT="$(K logs "$BURST_POD" 2>&1 || true)"
K delete pod "$BURST_POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true

REFUSALS="$(printf '%s\n' "$BURST_OUT" | grep -c 'wake rate limit exceeded' || true)"
log "client-visible 53400 wake-budget refusals: $REFUSALS / $ATTEMPTS attempts"
[ "$REFUSALS" -ge "$MIN_REFUSALS" ] \
  || fail "expected >= $MIN_REFUSALS wake-budget refusals from an over-budget burst, got $REFUSALS — the budget did NOT cap the wake churn"
ok "unauth burst CAPPED: $REFUSALS/$ATTEMPTS attempts refused (53400) — churn bounded, compute not scaled for the excess"

# compute must not have exceeded a single replica (single-writer; wake is 0->1 only)
REP="$(replicas_of "$APP")"
[ "$REP" = "0" ] || [ "$REP" = "1" ] || fail "compute-$APP scaled to $REP replicas under the burst — churn NOT bounded"
ok "compute-$APP bounded to <=1 replica under the burst (spec.replicas=$REP)"

# gateway logs corroborate the server-side refusal + name the app
GWLOG="$(K logs -l app=pggw-apps --tail=2000 --since=4m 2>/dev/null | grep -c 'wake budget exceeded' || true)"
[ "$GWLOG" -ge 1 ] || fail "apps-gateway logs show no 'wake budget exceeded' line — refusal not server-confirmed"
ok "apps-gateway logged $GWLOG wake-budget refusals (server-side confirmation)"

# 4. OBSERVABLE — metric rose + alert fires ---------------------------------
log "observability: waiting for pggw_wake_budget_exceeded_total to rise and the alert to fire"
AFTER=""; i=0
while [ $i -lt 30 ]; do
  AFTER="$(prom "http://localhost:9090/api/v1/query?query=sum(pggw_wake_budget_exceeded_total%7Bgateway%3D%22pggw-apps%22%7D)" \
    | grep -o '"value":\[[^]]*\]' | grep -o '[0-9.]*"' | tr -d '"' | tail -1)"
  AFTER="${AFTER:-0}"
  awk "BEGIN{exit !($AFTER > $BEFORE)}" && break
  i=$((i+1)); sleep 5
done
awk "BEGIN{exit !($AFTER > $BEFORE)}" \
  || fail "pggw_wake_budget_exceeded_total did not rise in prometheus (before=$BEFORE after=$AFTER)"
ok "metric rose: pggw_wake_budget_exceeded_total{gateway=pggw-apps} $BEFORE -> $AFTER"

# the WakeBudgetExceeded rule must be loaded, and go firing (for: 1m).
prom "http://localhost:9090/api/v1/rules" | grep -q 'WakeBudgetExceeded' \
  || fail "WakeBudgetExceeded rule not loaded in prometheus (apply deploy/60-prometheus.yaml + reload)"
log "WakeBudgetExceeded rule loaded; polling alertmanager for it to fire (up to ~3.5min for the 1m 'for')"
FIRED=""; i=0
while [ $i -lt 42 ]; do
  if prom "http://localhost:9090/api/v1/alerts" | grep -o '"alertname":"WakeBudgetExceeded"[^}]*"state":"firing"' | grep -q firing \
     || K exec deploy/prometheus -- wget -qO- 'http://alertmanager:9093/api/v2/alerts?active=true' 2>/dev/null | grep -q 'WakeBudgetExceeded'; then
    FIRED=1; break
  fi
  i=$((i+1)); sleep 5
done
[ -n "$FIRED" ] || fail "WakeBudgetExceeded did not reach firing/active within the window (metric rose, but the alert did not fire)"
ok "WakeBudgetExceeded alert is FIRING (plane=apps) — the wake side-channel is observable + pages"

ok "ALL WAKE-GUARD CHECKS PASSED (#116): legit wake intact, unauth burst budget-capped, alert fires"
