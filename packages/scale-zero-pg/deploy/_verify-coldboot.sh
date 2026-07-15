#!/bin/sh
# Issue #132 — cold-boot role-apply race drill (PER-APP path, apps-gateway).
#
# compute_ctl opens the Postgres socket a beat BEFORE it (re)applies the per-app
# spec role on every boot, so the FIRST connection during a 0->1 cold wake could
# transiently return 28P01 ("password authentication failed") and self-heal on the
# next request. The gateway now holds the client for a bounded role-apply settle
# window (GW_ROLE_APPLY_SETTLE_MS) on a GENUINE cold wake of a per-app front door,
# BEFORE the single auth attempt — so the role is applied by the time auth runs.
#
# This drill proves, on the LIVE cluster:
#   (a) across N repeated cold cycles the FIRST connect with VALID creds NEVER
#       surfaces a transient 28P01;
#   (b) a WRONG password STILL fast-fails with 28P01 (the gate never masks a bad
#       credential — the non-negotiable safety property);
#   (c) the cold-wake end-to-end latency (mean/max over N cycles) so the settle
#       cost is visible.
#
# Requires the apps-gateway to run the gateway image built from THIS branch (the
# settle gate). Client pods use postgres:17-alpine (issue #171). Reuses an existing
# per-app app (default pgdemo: role app_pgdemo + Secret app-db-pgdemo).
#
# Env: APP (default pgdemo), CYCLES (default 8), PSQL_IMG, connect_timeout via CT.
set -eu
NS=scale-zero-pg
APP="${APP:-pgdemo}"
CYCLES="${CYCLES:-8}"
PSQL_IMG="${PSQL_IMG:-postgres:17-alpine}"
CT="${CT:-20}" # psql connect_timeout: must exceed wake + settle

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
nowms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# kc wraps kubectl and pins the context via KUBECTL_CONTEXT when set, so a wrapper
# that self-resets current-context mid-run cannot silently redirect the drill at
# another cluster (the OKE kubectl wrapper is known to do this — set
# KUBECTL_CONTEXT=context-ckmva7v7zvq). The flag goes AFTER the subcommand because
# the wrapper rejects a leading --context.
KFLAG=""
[ -n "${KUBECTL_CONTEXT:-}" ] && KFLAG="--context=${KUBECTL_CONTEXT}"
kc() { _sub="$1"; shift; kubectl "$_sub" ${KFLAG:+$KFLAG} "$@"; }

app_pw() { kc get secret "app-db-$1" -n "$NS" -o jsonpath='{.data.PGPASSWORD}' | base64 -d; }

# CLIENT_PW runs one-shot psql THROUGH the apps-gateway as app_<APP> with a GIVEN
# password, printing combined stdout+stderr (so wrong-password runs surface the
# 28P01 text) and returning psql's success as the exit status. Polls for a TERMINAL
# phase (Succeeded|Failed) so a failing auth pod never stalls on the 150s wait.
CLIENT_PW() { # $1 tag  $2 password  $3 sql
  P="pgcb-$$-$1"
  dsn="postgres://app_${APP}:$2@pggw-apps:55432/${APP}?sslmode=disable&connect_timeout=${CT}"
  kc run -n "$NS" "$P" --image="$PSQL_IMG" --image-pull-policy=IfNotPresent \
    --restart=Never --quiet --command -- psql "$dsn" -tA -w -c "$3" >/dev/null 2>&1 || true
  _i=0
  while :; do
    _ph=$(kc get -n "$NS" pod "$P" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$_ph" in Succeeded | Failed) break ;; esac
    _i=$((_i + 1))
    [ "$_i" -gt 150 ] && break
    sleep 1
  done
  _out=$(kc logs -n "$NS" "$P" 2>&1 || true)
  kc delete -n "$NS" pod "$P" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  printf '%s' "$_out"
  [ "$_ph" = "Succeeded" ]
}

# cold scales compute-<APP> to 0 and waits until no pods remain (a draining pod
# still holds the timeline, so "zero pods" is the settled state a cold wake starts
# from). This guarantees the NEXT connect triggers a genuine 0->1 wake (woke==true),
# the ONLY case the settle gate fires.
cold() {
  kc scale -n "$NS" "deploy/compute-$APP" --replicas=0 >/dev/null
  _i=0
  while [ "$(kc get -n "$NS" pods -l "app=compute-$APP" --no-headers 2>/dev/null | grep -c .)" != "0" ]; do
    _i=$((_i + 1))
    [ "$_i" -gt 90 ] && fail "compute-$APP did not reach 0"
    sleep 1
  done
}

PW="$(app_pw "$APP")"
[ -n "$PW" ] || fail "no PGPASSWORD in Secret app-db-$APP"

# 0. apps-gateway ready
kc rollout -n "$NS" status "deploy/pggw-apps" --timeout=120s >/dev/null || fail "apps-gateway not ready"
SETTLE=$(kc get -n "$NS" deploy pggw-apps -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="GW_ROLE_APPLY_SETTLE_MS")].value}' 2>/dev/null)
ok "apps-gateway ready (GW_ROLE_APPLY_SETTLE_MS=${SETTLE:-<default 250>})"

# 1. seed a tiny table (wakes the app if needed) — establishes valid creds work.
CLIENT_PW seed "$PW" "drop table if exists cb; create table cb(id int); insert into cb values (1)" >/dev/null ||
  fail "seed with VALID creds failed — cannot run drill"
ok "seeded through apps-gateway as app_${APP} (valid creds)"

# 2. N cold cycles: the first VALID-cred connect must NEVER surface a transient 28P01.
tot=0
max=0
transients=0
i=1
while [ "$i" -le "$CYCLES" ]; do
  cold
  t0=$(nowms)
  out=$(CLIENT_PW "v$i" "$PW" "select count(*) from cb") && st=0 || st=1
  t1=$(nowms)
  ms=$((t1 - t0))
  if printf '%s' "$out" | grep -qiE "28P01|password authentication failed"; then
    transients=$((transients + 1))
    echo "  cycle $i: TRANSIENT 28P01 on VALID creds: $(printf '%s' "$out" | tr '\n' ' ')" >&2
  fi
  [ "$st" -eq 0 ] || fail "cycle $i: valid-cred cold connect FAILED: $(printf '%s' "$out" | tr '\n' ' ')"
  [ "$(printf '%s' "$out" | tail -1)" = "1" ] || fail "cycle $i: unexpected row count: $(printf '%s' "$out" | tr '\n' ' ')"
  tot=$((tot + ms))
  [ "$ms" -gt "$max" ] && max=$ms
  echo "  cycle $i: valid cold connect ok in ${ms}ms"
  i=$((i + 1))
done
[ "$transients" -eq 0 ] || fail "$transients/$CYCLES cold cycles surfaced a transient 28P01 on VALID creds"
mean=$((tot / CYCLES))
ok "$CYCLES/$CYCLES cold cycles: VALID creds NEVER saw a transient 28P01 (mean ${mean}ms, max ${max}ms end-to-end)"

# 3. SAFETY: a WRONG password must STILL fast-fail with 28P01 on the cold path —
# the settle gate holds the connection but must NOT retry auth or mask a bad cred.
cold
w0=$(nowms)
out=$(CLIENT_PW wrong "definitely-wrong-$$" "select 1") && wst=0 || wst=1
w1=$(nowms)
wms=$((w1 - w0))
[ "$wst" -ne 0 ] || fail "WRONG password SUCCEEDED through the apps-gateway — auth was MASKED"
printf '%s' "$out" | grep -qiE "28P01|password authentication failed" ||
  fail "wrong password did not surface 28P01: $(printf '%s' "$out" | tr '\n' ' ')"
ok "WRONG password fast-failed with 28P01 in ${wms}ms on the cold path (gate did NOT mask it)"

echo "cold-boot role-apply drill: PASS (app=$APP cycles=$CYCLES settle=${SETTLE:-250} mean=${mean}ms max=${max}ms wrong-pw=${wms}ms/28P01)"
