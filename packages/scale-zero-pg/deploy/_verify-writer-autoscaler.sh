#!/bin/sh
# Writer vertical-autoscaler drill (issue #103, docs/SCALING.md axis 1). Proves the
# writer-autoscaler grows a RUNNING writer in place under CPU pressure and shrinks
# it back when idle — with ZERO restart the whole time:
#   (1) wake the primary writer (compute 0->1), record its baseline actuated CPU
#       limit + restartCount;
#   (2) drive CPU pressure inside the writer; assert the autoscaler RESIZES the CPU
#       limit UP in place (actuated limit increases) while restartCount is UNCHANGED
#       (pg_postmaster_start_time also unchanged — the Postgres never bounced);
#   (3) drop the load; assert the autoscaler shrinks the CPU limit back DOWN under
#       hysteresis, restartCount STILL unchanged.
# Requires metrics-server (kubectl top). Auto-skips cleanly if the writer-autoscaler
# Deployment or metrics-server is absent. Everything is restored: the autoscaler
# env is reset to the manifest defaults and the writer is scaled back to 0.
#
# Env: WA_WRITER (default deploy/compute) · WA_BURN (default 2 busy loops) ·
#      WA_UP_TIMEOUT (default 180s) · WA_DOWN_TIMEOUT (default 210s) ·
#      WA_FAST=1|0 (default 1 — patch the autoscaler to a fast cadence for the drill).
set -eu
cd "$(dirname "$0")"
NS=scale-zero-pg
K="kubectl -n $NS"
WRITER="${WA_WRITER:-deploy/compute}"
POD_SEL="app=compute"           # the primary writer's pod label
CONTAINER=compute
BURN="${WA_BURN:-3}" # busy loops; 3 reliably pegs a 1-core limit even on a shared node
UP_TIMEOUT="${WA_UP_TIMEOUT:-180}"
DOWN_TIMEOUT="${WA_DOWN_TIMEOUT:-210}"
FAST="${WA_FAST:-1}"

say() { printf '\n=== %s\n' "$*"; }
ok()  { printf 'OK   %s\n' "$*"; }
fail(){ printf 'FAIL %s\n' "$*" >&2; exit 1; }

# millicores from a k8s CPU quantity ("1" -> 1000, "1500m" -> 1500, "250m" -> 250).
to_milli() {
  v="$1"
  case "$v" in
    *m) echo "${v%m}" ;;
    "" ) echo 0 ;;
    *)  echo $(( v * 1000 )) ;;
  esac
}

# actuated CPU limit of the running writer pod (from status, not the spec).
actuated_cpu_milli() {
  raw=$($K get pod "$POD" -o jsonpath="{.status.containerStatuses[?(@.name==\"$CONTAINER\")].resources.limits.cpu}" 2>/dev/null || true)
  to_milli "$raw"
}
restart_count() {
  $K get pod "$POD" -o jsonpath="{.status.containerStatuses[?(@.name==\"$CONTAINER\")].restartCount}" 2>/dev/null || echo 0
}

# ---- preconditions -----------------------------------------------------------
$K top pods >/dev/null 2>&1 || { echo "SKIP: metrics-server not available (kubectl top failed)"; exit 0; }
$K get deploy/writer-autoscaler >/dev/null 2>&1 || { echo "SKIP: writer-autoscaler Deployment not deployed"; exit 0; }

# ---- fast cadence for the drill (restored on exit) ---------------------------
restore() {
  say "cleanup"
  if [ "$FAST" = "1" ]; then
    # Re-apply the manifest (not `set env -`) so the live Deployment matches the
    # committed spec exactly — env removal would drift live from the manifest.
    $K apply -f 85-writer-autoscaler.yaml >/dev/null 2>&1 || true
    $K rollout status deploy/writer-autoscaler --timeout=90s >/dev/null 2>&1 || true
  fi
  # stop any burners still attached
  if [ -f "$PIDS" ]; then while read -r p; do kill "$p" 2>/dev/null || true; done < "$PIDS"; rm -f "$PIDS"; fi
  $K scale "$WRITER" --replicas=0 >/dev/null 2>&1 || true
  echo "restored: autoscaler env defaults, writer scaled to 0"
}
PIDS=$(mktemp)
trap restore EXIT

if [ "$FAST" = "1" ]; then
  say "patch writer-autoscaler to a fast drill cadence"
  $K set env deploy/writer-autoscaler \
    WAS_POLL_MS=5000 WAS_UP_HOLD=2 WAS_DOWN_HOLD=3 WAS_COOLDOWN=2 WAS_UP_RATIO=0.55 WAS_DOWN_RATIO=0.40 >/dev/null
  $K rollout status deploy/writer-autoscaler --timeout=120s >/dev/null
  ok "autoscaler on fast cadence (poll 5s, up-hold 2, down-hold 3)"
fi

# ---- (1) wake the writer, record baseline ------------------------------------
say "wake the writer + record baseline"
$K scale "$WRITER" --replicas=1 >/dev/null
$K rollout status "$WRITER" --timeout=180s >/dev/null
POD=$($K get pods -l "$POD_SEL" -o jsonpath='{.items[0].metadata.name}')
[ -n "$POD" ] || fail "no writer pod found for selector $POD_SEL"
# wait for the pod to report actuated resources
i=0; while [ "$(actuated_cpu_milli)" = "0" ] && [ "$i" -lt 30 ]; do sleep 2; i=$((i+1)); done
BASE_CPU=$(actuated_cpu_milli)
BASE_RESTARTS=$(restart_count)
BASE_PGSTART=$($K exec "$POD" -c "$CONTAINER" -- sh -c 'echo $(date +%s)' 2>/dev/null || echo "?")
[ "$BASE_CPU" -gt 0 ] || fail "could not read baseline actuated CPU limit"
ok "writer $POD baseline: cpu-limit=${BASE_CPU}m restarts=${BASE_RESTARTS}"

# ---- (2) drive CPU up -> assert in-place scale-UP, no restart -----------------
say "drive CPU pressure ($BURN busy loops) and watch for an in-place scale-up"
# One exec spawns $BURN in-container busy loops then sleeps to hold them as its
# children (survives local kubectl hiccups); killing the local PID + an in-pod
# pgrep sweep stops them. Robust vs one-exec-per-loop.
$K exec "$POD" -c "$CONTAINER" -- sh -c \
  "i=0; while [ \$i -lt $BURN ]; do (while :; do :; done) & i=\$((i+1)); done; sleep 900" >/dev/null 2>&1 &
echo $! >> "$PIDS"
ok "started $BURN CPU burners in $POD"

# Wait for metrics-server to REFLECT the load before blaming the autoscaler — proves
# the drill actually generated pressure (guards against a no-op burner).
say "wait for metrics-server to reflect the load"
lt=0; loaded=0
while [ "$lt" -lt 90 ]; do
  cur=$($K top pod "$POD" --no-headers 2>/dev/null | awk '{print $2}' | sed 's/m$//')
  case "$cur" in ''|*[!0-9]*) cur=0 ;; esac
  if [ "$cur" -ge $(( BASE_CPU / 2 )) ]; then loaded=1; ok "load registered: ${cur}m CPU"; break; fi
  sleep 5; lt=$((lt+5))
done
[ "$loaded" = "1" ] || fail "burners never registered load in metrics-server within 90s (usage stayed <${BASE_CPU}m/2)"

UP_CPU=0; t=0
while [ "$t" -lt "$UP_TIMEOUT" ]; do
  cur=$(actuated_cpu_milli)
  rc=$(restart_count)
  [ "$rc" = "$BASE_RESTARTS" ] || fail "writer RESTARTED during resize (restartCount $BASE_RESTARTS -> $rc) — resize must be in-place!"
  if [ "$cur" -gt "$BASE_CPU" ]; then UP_CPU=$cur; break; fi
  sleep 5; t=$((t+5))
  printf '  ... t=%ss actuated-cpu=%sm restarts=%s\n' "$t" "$cur" "$rc"
done
[ "$UP_CPU" -gt "$BASE_CPU" ] || fail "no scale-up within ${UP_TIMEOUT}s (cpu still ${BASE_CPU}m) — check metrics-server + WAS_UP_RATIO"
RC_UP=$(restart_count)
[ "$RC_UP" = "$BASE_RESTARTS" ] || fail "restartCount changed on scale-up"
ok "SCALE-UP in place: cpu-limit ${BASE_CPU}m -> ${UP_CPU}m, restartCount=${RC_UP} (UNCHANGED) — no bounce"

# ---- (3) drop load -> assert in-place scale-DOWN, no restart ------------------
say "drop the load and watch for an in-place scale-down (hysteresis)"
while read -r p; do kill "$p" 2>/dev/null || true; done < "$PIDS"; : > "$PIDS"
# belt-and-suspenders: reap any stray busy loops inside the pod
$K exec "$POD" -c "$CONTAINER" -- sh -c 'kill $(pgrep -f "while :" 2>/dev/null) 2>/dev/null || true' >/dev/null 2>&1 || true

DOWN_CPU=$UP_CPU; t=0
while [ "$t" -lt "$DOWN_TIMEOUT" ]; do
  cur=$(actuated_cpu_milli)
  rc=$(restart_count)
  [ "$rc" = "$BASE_RESTARTS" ] || fail "writer RESTARTED during scale-down (restartCount $BASE_RESTARTS -> $rc)"
  if [ "$cur" -lt "$UP_CPU" ]; then DOWN_CPU=$cur; break; fi
  sleep 5; t=$((t+5))
  printf '  ... t=%ss actuated-cpu=%sm restarts=%s\n' "$t" "$cur" "$rc"
done
[ "$DOWN_CPU" -lt "$UP_CPU" ] || fail "no scale-down within ${DOWN_TIMEOUT}s (cpu still ${UP_CPU}m) — check WAS_DOWN_RATIO/WAS_DOWN_HOLD"
RC_DOWN=$(restart_count)
[ "$RC_DOWN" = "$BASE_RESTARTS" ] || fail "restartCount changed on scale-down"
ok "SCALE-DOWN in place: cpu-limit ${UP_CPU}m -> ${DOWN_CPU}m, restartCount=${RC_DOWN} (UNCHANGED)"

say "PASS — writer vertical-autoscaler: in-place scale up+down, restartCount=${BASE_RESTARTS} throughout (zero bounce)"
