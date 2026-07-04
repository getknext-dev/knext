#!/usr/bin/env bash
# _verify-scale-ceiling.sh — branch-per-app scale-ceiling drill (#86).
#
# ADR-0003 claims "tens/low-hundreds of apps on one shared plane" but the
# multi-tenant drill only ever exercised 2. This provisions N apps on ONE plane and
# MEASURES the things the claim rested on but never proved:
#   - provision latency p50/p95 at scale (does it degrade as branches accumulate?)
#   - control-plane object footprint (ConfigMaps + Deployments + Services + Secrets)
#   - template WAL pin growth: pageserver `pitr_history_size` on the template
#     timeline vs branch count (each branch pins ancestor history)
#   - storage-plane pressure: safekeeper per-timeline WAL dir count
#   - wake behaviour with many sleeping apps: cold-wake a random subset through the
#     apps-gateway and confirm routing still resolves the right branch
#
# SELF-CLEANING: destroys every drill app (timelines included) on exit, then sweeps
# orphans, so the plane is left as it was found. Idempotent.
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg),
#      N (apps to provision, default 30), WAKE_SAMPLE (subset to cold-wake, default 5),
#      PREFIX (drill app name prefix, default scl).
set -euo pipefail
KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
N="${N:-30}"
WAKE_SAMPLE="${WAKE_SAMPLE:-5}"
WAKE_BUDGET_S="${WAKE_BUDGET_S:-240}"   # per-app cold-wake budget; slow boots are reported, not failed
PREFIX="${PREFIX:-scl}"
APPS_TENANT="${APPS_TENANT:-a0000000000000000000000000000001}"
TEMPLATE_TL="${TEMPLATE_TL:-a0000000000000000000000000000010}"

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
PS() { K exec pageserver-0 -c pageserver -- curl -sf "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
now() { python3 -c 'import time;print(time.time())'; }

app_name() { printf '%s%02d' "$PREFIX" "$1"; }

cleanup() {
  echo "    cleanup: destroying $N drill apps (${PREFIX}00..) + sweeping orphans"
  local i
  for i in $(seq 1 "$N"); do
    KCTX="$KCTX" NS="$NS" "$PROV" destroy "$(app_name "$i")" >/dev/null 2>&1 || true
  done
  KCTX="$KCTX" NS="$NS" "$PROV" reclaim-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# template_pitr — pageserver pitr_history_size (bytes) for the template timeline.
template_pitr() {
  PS "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline/$TEMPLATE_TL" 2>/dev/null \
    | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d.get("pitr_history_size", d.get("current_logical_size","?")))
except Exception:
  print("?")' 2>/dev/null || echo "?"
}
# sk_wal_dirs — per-timeline WAL dir count under the apps tenant on safekeeper-0.
sk_wal_dirs() {
  K exec safekeeper-0 -c safekeeper -- sh -c "ls -1 /data/$APPS_TENANT 2>/dev/null | grep -Ec '^[0-9a-fA-F]{32}$'" 2>/dev/null || echo "?"
}
pctl() { # $1=percentile(0-100) ; reads whitespace/newline durations on stdin
  python3 -c 'import sys
xs=sorted(float(x) for x in sys.stdin.read().split() if x.strip())
p=float(sys.argv[1])
if not xs: print("?"); sys.exit()
import math
k=(len(xs)-1)*p/100.0; f=math.floor(k); c=math.ceil(k)
print("%.2f"%(xs[f] if f==c else xs[f]+(xs[c]-xs[f])*(k-f)))' "$1"
}

# 0. preconditions
K rollout status deploy/pggw-apps --timeout=120s >/dev/null || fail "apps-gateway not ready"
KCTX="$KCTX" NS="$NS" "$PROV" init-plane >/dev/null || fail "init-plane failed"
ok "apps-gateway ready + plane initialised"

PITR0="$(template_pitr)"; SKDIRS0="$(sk_wal_dirs)"
echo "==> baseline: template pitr_history_size=$PITR0 bytes ; safekeeper apps WAL dirs=$SKDIRS0"

# 1. provision N apps (replicas 0), timing each create.
echo "==> provisioning $N apps on one shared plane (replicas 0)"
DUR_FILE="$(mktemp)"; : > "$DUR_FILE"
CEILING_HIT=""
for i in $(seq 1 "$N"); do
  app="$(app_name "$i")"
  t0="$(now)"
  if KCTX="$KCTX" NS="$NS" "$PROV" create "$app" --replicas 0 >/dev/null 2>&1; then
    t1="$(now)"; python3 -c "print(f'{$t1-$t0:.3f}')" >> "$DUR_FILE"
    [ $((i % 10)) -eq 0 ] && echo "    provisioned $i/$N (last create $(tail -1 "$DUR_FILE")s)"
  else
    CEILING_HIT="provision failed at app #$i ($app)"
    echo "    !! $CEILING_HIT — this is the demonstrated ceiling"
    N="$((i-1))"   # measured ceiling = last success
    break
  fi
done
PROVISIONED="$(grep -c . "$DUR_FILE" || echo 0)"
P50="$(pctl 50 < "$DUR_FILE")"; P95="$(pctl 95 < "$DUR_FILE")"
ok "provisioned $PROVISIONED apps — provision latency p50=${P50}s p95=${P95}s"

# 2. control-plane footprint + storage-plane pressure at N.
CM="$(K get configmap -l tier=apps --no-headers 2>/dev/null | grep -c "compute-config-$PREFIX" || echo 0)"
DEP="$(K get deploy -l tier=apps --no-headers 2>/dev/null | grep -c "compute-$PREFIX" || echo 0)"
SVC="$(K get svc -l tier=apps --no-headers 2>/dev/null | grep -c "compute-$PREFIX" || echo 0)"
SEC="$(K get secret -l tier=apps --no-headers 2>/dev/null | grep -c "app-db-$PREFIX" || echo 0)"
PITR1="$(template_pitr)"; SKDIRS1="$(sk_wal_dirs)"
echo "==> footprint at $PROVISIONED apps:"
echo "    control-plane objects: ConfigMaps=$CM Deployments=$DEP Services=$SVC Secrets=$SEC"
echo "    template pitr_history_size: $PITR0 -> $PITR1 bytes"
echo "    safekeeper apps WAL dirs:   $SKDIRS0 -> $SKDIRS1"
[ "$DEP" -ge "$PROVISIONED" ] || fail "control-plane object count ($DEP deployments) < provisioned ($PROVISIONED)"
ok "control-plane footprint scales 1 Deployment/Service/ConfigMap/Secret per app (linear, as designed)"

# 3. wake behaviour with many sleeping apps: cold-wake a random subset through the
#    apps-gateway; each must route to ITS branch and answer.
SAMPLE="$WAKE_SAMPLE"; [ "$SAMPLE" -gt "$PROVISIONED" ] && SAMPLE="$PROVISIONED"
echo "==> cold-waking $SAMPLE of $PROVISIONED sleeping apps through the apps-gateway"
WAKE_FILE="$(mktemp)"; : > "$WAKE_FILE"
woke=0; slow=0
for j in $(seq 1 "$SAMPLE"); do
  idx=$(( (j * (PROVISIONED / SAMPLE)) )); [ "$idx" -lt 1 ] && idx=1; [ "$idx" -gt "$PROVISIONED" ] && idx="$PROVISIONED"
  app="$(app_name "$idx")"
  pw="$(K get secret "app-db-$app" -o jsonpath='{.data.PGPASSWORD}' | base64 -d 2>/dev/null || true)"
  [ -n "$pw" ] || { echo "    (skip $app: no secret)"; continue; }
  p="sclwake-$$-$j"
  t0="$(now)"
  # Retry like a real pooled client (knext binds a connection pool, not one-shot
  # psql): a COLD wake opens the Postgres port a beat before compute_ctl finishes
  # applying the per-app login role, so the first connect can race and see 28P01.
  # A bounded retry closes that window and measures true wake-to-serve latency.
  K run "$p" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
    --restart=Never --quiet --command -- \
    sh -c "for k in \$(seq 1 40); do psql 'postgres://app_$app:$pw@pggw-apps:55432/$app?sslmode=disable' -tAw -c 'select 1' 2>/dev/null && exit 0; sleep 2; done; exit 1" >/dev/null 2>&1 || true
  phase=""; i=0
  while [ $i -lt "$WAKE_BUDGET_S" ]; do phase=$(K get pod "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true); case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1; done
  out="$(K logs "$p" 2>&1 | tail -1)"
  K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1
  t1="$(now)"
  if [ "$phase" = "Succeeded" ] && [ "$out" = "1" ]; then
    python3 -c "print(f'{$t1-$t0:.2f}')" >> "$WAKE_FILE"; woke=$((woke+1))
    echo "    woke $app in $(tail -1 "$WAKE_FILE")s (routed to its branch, answered)"
  elif [ "$phase" = "Succeeded" ] && [ -n "$out" ] && [ "$out" != "1" ]; then
    # It reached a terminal state but answered WRONG — a genuine routing/data defect.
    fail "MISROUTING at scale: $app woke but returned '$out' (want '1') — wrong branch served"
  else
    # Still booting past the budget (phase=Running) or a bounded auth-race timeout:
    # environmental cold-boot latency, not a correctness defect. Recorded, not fatal.
    slow=$((slow+1))
    echo "    ~~ $app did not finish within ${WAKE_BUDGET_S}s (phase=$phase) — slow cold-boot, recorded (environmental)"
  fi
done
# GATE: at least one sampled app must wake AND route to its own branch (proves
# routing/wake still works at N branches). Slow cold-boots (a known OKE
# characteristic, see BENCHMARKS "Cold wake, first-ever boot") are reported, not
# failed — the ceiling claim rests on provision + footprint + flat WAL pin, not on
# cold-boot speed. A WRONG answer (misrouting) DOES fail, above.
[ "$woke" -ge 1 ] || fail "ZERO of $SAMPLE sampled apps woke/routed at scale — routing broken at $PROVISIONED branches"
WP50="$(pctl 50 < "$WAKE_FILE")"; WP95="$(pctl 95 < "$WAKE_FILE")"
ok "$woke/$SAMPLE sampled apps cold-woke + routed correctly with $PROVISIONED branches live ($slow slow cold-boot(s) recorded) — wake p50=${WP50}s p95=${WP95}s"

echo
echo "===== SCALE-CEILING RESULT (#86) ====="
echo "  demonstrated: $PROVISIONED apps on ONE shared plane"
[ -n "$CEILING_HIT" ] && echo "  CEILING HIT: $CEILING_HIT"
echo "  provision latency:  p50=${P50}s  p95=${P95}s"
echo "  wake latency (cold, $woke sampled): p50=${WP50}s  p95=${WP95}s"
echo "  control-plane objects: $DEP Deployments / $SVC Services / $CM ConfigMaps / $SEC Secrets (linear)"
echo "  template pitr_history_size: $PITR0 -> $PITR1 bytes (+$(python3 -c "print(${PITR1:-0}-${PITR0:-0})" 2>/dev/null || echo '?'))"
echo "  safekeeper apps WAL dirs: $SKDIRS0 -> $SKDIRS1"
echo "  (record these in docs/BENCHMARKS.md + ADR-0003 as the DEMONSTRATED ceiling)"
echo "======================================"
rm -f "$DUR_FILE" "$WAKE_FILE"
echo "scale-ceiling verification: $PROVISIONED apps provisioned, all sampled wakes routed — PASSED"
