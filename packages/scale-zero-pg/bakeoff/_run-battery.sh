#!/usr/bin/env sh
# _run-battery.sh — the full bake-off battery (phase-4B decision gate).
#
# Runs the complete protocol from bakeoff/README.md:
#   {cold wake, warm connect, reconnect-after-drain} x {Neon, CNPG}
# with N (>=20) samples per cell, from ONE in-cluster psql client pod, timing
# connect + probe-SELECT through each foundation's gateway. Writes one raw-sample
# CSV per cell (stamped with a shared RUN_ID) and prints p50/p95/p99 per cell.
#
# This supersedes the env-var COLD_CMD gymnastics of _measure.sh by fixing the
# scaffold's two known measurement bugs (see results/SUMMARY-initial.md):
#
#  1. Neon cold-forcing (readyReplicas quirk): k8s 1.34 OMITS status.readyReplicas
#     when it is zero, so the old harness read the empty value as "already cold"
#     and timed a WARM compute. Fix: cold is confirmed only when
#     spec.replicas==0 AND *no* compute pods remain — counting Terminating pods
#     too (a draining compute still holds the wake timeline). We force cold
#     deterministically by scaling the Deployment to 0 ourselves (allowed for
#     sampling), rather than waiting on the gateway idle timer.
#  2. Quiesce interference: nothing else may touch scale-zero-pg during Neon
#     sampling. We assert compute is genuinely at 0 before each cold sample and
#     do not run any verify scripts concurrently.
#
# Config via env:
#   N          samples per cell     (default 20)
#   RUN_ID     shared stamp         (default: %Y%m%dT%H%M%S)
#   CLIENT_NS  client pod namespace  (default bakeoff-cnpg)
#   CLIENT_POD client pod name       (default pgclient)
#   FOUNDATIONS  space list          (default "neon cnpg")
#   DIMS         space list          (default "cold warm reconnect")
#
# Requires: kubectl on PATH, a running CLIENT_POD with psql, python3 on host.
set -eu

N="${N:-20}"
CLIENT_NS="${CLIENT_NS:-bakeoff-cnpg}"
CLIENT_POD="${CLIENT_POD:-pgclient}"
FOUNDATIONS="${FOUNDATIONS:-neon cnpg}"
DIMS="${DIMS:-cold warm reconnect}"

DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/results"
RUN_ID="${RUN_ID:-$(python3 -c 'import time;print(time.strftime("%Y%m%dT%H%M%S"))')}"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# --- per-foundation config -------------------------------------------------
# Neon: gateway in scale-zero-pg (kubectl mode); creds cloud_admin; db postgres.
NEON_HOST="pggw.scale-zero-pg.svc"; NEON_PORT=55432
NEON_USER="cloud_admin"; NEON_PASS="cloud_admin"; NEON_DB="postgres"
# CNPG: gateway in bakeoff-cnpg (exec mode); creds app; db app.
CNPG_HOST="pggw.bakeoff-cnpg.svc"; CNPG_PORT=55432
CNPG_USER="app"; CNPG_PASS="app"; CNPG_DB="app"

PROBE_SQL="SELECT count(*) FROM t"

# --- cold-force primitives (deterministic, confirmed) ----------------------
neon_cold() {
  # Scale compute to 0 and confirm FULLY cold: spec.replicas==0 AND zero pods
  # (counting Terminating). Returns 0 on confirmed cold, 1 on timeout.
  kubectl -n scale-zero-pg scale deploy/compute --replicas=0 >/dev/null 2>&1 || true
  j=0
  while [ "$j" -lt 90 ]; do
    rep="$(kubectl -n scale-zero-pg get deploy/compute -o jsonpath='{.spec.replicas}' 2>/dev/null)"
    pods="$(kubectl -n scale-zero-pg get pods -l app=compute --no-headers 2>/dev/null | grep -c . || true)"
    [ "$rep" = "0" ] && [ "$pods" = "0" ] && return 0
    j=$((j+1)); sleep 1
  done
  return 1
}
neon_assert_cold() {
  rep="$(kubectl -n scale-zero-pg get deploy/compute -o jsonpath='{.spec.replicas}' 2>/dev/null)"
  pods="$(kubectl -n scale-zero-pg get pods -l app=compute --no-headers 2>/dev/null | grep -c . || true)"
  [ "$rep" = "0" ] && [ "$pods" = "0" ]
}
neon_warm() {
  # Ensure compute is up (scale to 1, wait for a Ready pod).
  kubectl -n scale-zero-pg scale deploy/compute --replicas=1 >/dev/null 2>&1 || true
  j=0
  while [ "$j" -lt 90 ]; do
    rdy="$(kubectl -n scale-zero-pg get deploy/compute -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"
    [ "${rdy:-0}" = "1" ] && return 0
    j=$((j+1)); sleep 1
  done
  return 1
}

cnpg_cold() {
  kubectl -n bakeoff-cnpg annotate --overwrite cluster/pg cnpg.io/hibernation=on >/dev/null 2>&1 || true
  j=0
  while [ "$j" -lt 90 ]; do
    pods="$(kubectl -n bakeoff-cnpg get pods -l cnpg.io/cluster=pg --no-headers 2>/dev/null | grep -c . || true)"
    [ "$pods" = "0" ] && return 0
    j=$((j+1)); sleep 1
  done
  return 1
}
cnpg_warm() {
  kubectl -n bakeoff-cnpg annotate --overwrite cluster/pg cnpg.io/hibernation=off >/dev/null 2>&1 || true
  j=0
  while [ "$j" -lt 120 ]; do
    rdy="$(kubectl -n bakeoff-cnpg get pods -l cnpg.io/cluster=pg --no-headers 2>/dev/null | grep -c 'Running' || true)"
    [ "$rdy" -ge 1 ] 2>/dev/null && return 0
    j=$((j+1)); sleep 1
  done
  return 1
}

# --- the ruler: time one connect+probe through a gateway -------------------
# args: HOST PORT USER PASS DB  ; echoes "ms rows ok"
measure_one() {
  _h="$1"; _p="$2"; _u="$3"; _pw="$4"; _db="$5"
  _t0="$(now_ms)"
  _out="$(kubectl -n "$CLIENT_NS" exec "$CLIENT_POD" -- sh -c \
    "PGPASSWORD='$_pw' psql -h '$_h' -p '$_p' -U '$_u' -d '$_db' -tAc \"$PROBE_SQL\" -v ON_ERROR_STOP=1" 2>/dev/null)" && _ok=1 || _ok=0
  _t1="$(now_ms)"
  _rows="$(printf '%s' "$_out" | tr -d '[:space:]')"; [ -z "$_rows" ] && _rows="NA"
  echo "$((_t1 - _t0)) $_rows $_ok"
}

pct_report() { # arg: CSV
  python3 - "$1" <<'PY'
import sys, csv
rows=[r for r in csv.DictReader(open(sys.argv[1])) if r["ok"]=="1"]
xs=sorted(int(r["wake_ms"]) for r in rows)
def pct(p):
    if not xs: return float("nan")
    k=(len(xs)-1)*p/100.0; f=int(k); c=min(f+1,len(xs)-1)
    return xs[f]+(xs[c]-xs[f])*(k-f)
n=len(xs)
if n:
    print(f"    n_ok={n}  min={xs[0]}  p50={pct(50):.0f}  p95={pct(95):.0f}  p99={pct(99):.0f}  max={xs[-1]}  (ms)")
else:
    print("    n_ok=0  (all samples failed)")
PY
}

# --- cell runner -----------------------------------------------------------
run_cell() { # args: FOUNDATION DIM
  f="$1"; dim="$2"
  case "$f" in
    neon) H=$NEON_HOST; P=$NEON_PORT; U=$NEON_USER; PW=$NEON_PASS; DB=$NEON_DB;;
    cnpg) H=$CNPG_HOST; P=$CNPG_PORT; U=$CNPG_USER; PW=$CNPG_PASS; DB=$CNPG_DB;;
    *) echo "unknown foundation $f" >&2; return 1;;
  esac
  csv="$DIR/results/${f}-${dim}-${RUN_ID}.csv"
  echo "idx,wake_ms,rows,ok" > "$csv"
  echo "== cell: foundation=$f dim=$dim N=$N -> $(basename "$csv") =="

  # warm dimension: prime once, then measure with NO cold-force between samples.
  if [ "$dim" = "warm" ]; then
    if [ "$f" = "neon" ]; then neon_warm || echo "  WARN neon_warm timeout"; else cnpg_warm || echo "  WARN cnpg_warm timeout"; fi
    measure_one "$H" "$P" "$U" "$PW" "$DB" >/dev/null 2>&1 || true   # prime the pipe
  fi

  i=1
  while [ "$i" -le "$N" ]; do
    case "$dim" in
      cold)
        if [ "$f" = "neon" ]; then
          neon_cold || echo "  [$i] WARN neon_cold timeout"
          neon_assert_cold || { echo "  [$i] SKIP: compute not cold (interference?)"; i=$((i+1)); continue; }
        else
          cnpg_cold || echo "  [$i] WARN cnpg_cold timeout"
        fi
        ;;
      reconnect)
        # bursty-app model: warm it, then drain to cold, then reconnect (measured).
        if [ "$f" = "neon" ]; then
          neon_warm >/dev/null 2>&1 || true
          measure_one "$H" "$P" "$U" "$PW" "$DB" >/dev/null 2>&1 || true  # a live connection
          neon_cold || echo "  [$i] WARN neon_cold timeout"
          neon_assert_cold || { echo "  [$i] SKIP: not cold"; i=$((i+1)); continue; }
        else
          cnpg_warm >/dev/null 2>&1 || true
          measure_one "$H" "$P" "$U" "$PW" "$DB" >/dev/null 2>&1 || true
          cnpg_cold || echo "  [$i] WARN cnpg_cold timeout"
        fi
        ;;
      warm) : ;;  # no cold-force
    esac
    res="$(measure_one "$H" "$P" "$U" "$PW" "$DB")"
    ms="$(echo "$res" | awk '{print $1}')"; rows="$(echo "$res" | awk '{print $2}')"; ok="$(echo "$res" | awk '{print $3}')"
    echo "$i,$ms,$rows,$ok" >> "$csv"
    echo "  [$i/$N] $f/$dim wake+query=${ms}ms rows=$rows ok=$ok"
    i=$((i+1))
  done
  echo "  percentiles ($f/$dim):"
  pct_report "$csv"
}

echo "############ bake-off battery  run_id=$RUN_ID  N=$N ############"
for f in $FOUNDATIONS; do
  for dim in $DIMS; do
    run_cell "$f" "$dim"
  done
done

echo "############ restoring quiescent state ############"
kubectl -n scale-zero-pg scale deploy/compute --replicas=0 >/dev/null 2>&1 || true
kubectl -n bakeoff-cnpg annotate --overwrite cluster/pg cnpg.io/hibernation=on >/dev/null 2>&1 || true
echo "done. CSVs under $DIR/results/ stamped $RUN_ID"
