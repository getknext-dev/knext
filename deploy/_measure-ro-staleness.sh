#!/usr/bin/env bash
# _measure-ro-staleness.sh — WARM-plane per-app RO staleness re-measurement (issue #169).
#
# WHY THIS EXISTS: a #167 sysdesign drill saw a per-app RO (compute-ro-<app>) NOT
# reflect a fresh primary write within 90s on a COLD plane (both computes just woken).
# The #99a/#127 contract is ~9s tip-following (Replica mode). The hypothesis: the 90s
# was the COLD-plane initial walreceiver catch-up (a one-time cost when a freshly
# attached RO compute first starts streaming WAL from the safekeepers), NOT the
# steady-state replication lag. This drill isolates the two by measuring RO staleness
# on a WARMED plane and reports min/median/max across N>=5 steady-state cycles.
#
# METHOD (why it is more accurate than the sibling drills' staleness step):
#   The staleness steps in _verify-perapp-ro.sh / _verify-readpool.sh poll the RO with
#   a FRESH one-shot pod per iteration (kubectl run + pod-schedule + image-pull-check),
#   so each poll costs SECONDS. That per-poll pod-spawn latency is added on top of the
#   true replication lag and inflates the reported number (the docs say so explicitly).
#   Here the ENTIRE measurement loop runs inside ONE long-lived pod that holds psql
#   connections to BOTH the writer (DATABASE_URL) and the RO (DATABASE_URL_RO) lanes and
#   polls every 100ms. Wall-clock is taken with GNU `date +%s.%N` (hence a debian, not
#   alpine, measurement image), so the reported lag is dominated by real replication +
#   visibility latency, not harness overhead.
#
#   Per cycle: commit a unique marker row through the WRITER; the instant the commit is
#   acknowledged, start the clock; poll the RO every 100ms until the row is visible; stop
#   the clock. The first WARMUP cycles are DISCARDED so the RO compute's walreceiver has
#   reached steady-state streaming (the cold initial catch-up is excluded on purpose —
#   it is a wake/catch-up cost, measured separately, not a steady-state staleness cost).
#
# Self-contained + idempotent: throwaway app "rostale" with roPool.enabled; cleans up on
# exit. Requires the appdb-operator + apps-gateway (GW_RO_PORT=55434) and an initialized
# plane, exactly like _verify-perapp-ro.sh.
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg), APP (default
#      rostale), WARMUP (default 3 discarded cycles), CYCLES (default 6 measured cycles),
#      MEAS_IMG (default postgres:17 — debian, for GNU `date +%N`), PSQL_IMG (alpine, for
#      the quick one-shot provisioning probes).
#
# Subcommands:
#   (none)      run the live drill on the cluster
#   selftest    run the cluster-free unit test for the stats function (TDD unit)
set -euo pipefail
KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
APP="${APP:-rostale}"
WARMUP="${WARMUP:-3}"
CYCLES="${CYCLES:-6}"
MEAS_IMG="${MEAS_IMG:-postgres:17}"
PSQL_IMG="${PSQL_IMG:-postgres:17-alpine}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"

# stats <<< "<one lag per line>"  — print "min=.. median=.. max=.. mean=.. n=..".
# Pure awk so it is testable WITHOUT a cluster (see `selftest`). Median = middle value
# for odd n, mean of the two middle values for even n. This is the TDD unit for #169.
stats() {
  awk '
    { v[n++] = $1 + 0 }
    END {
      if (n == 0) { print "min=na median=na max=na mean=na n=0"; exit }
      # insertion sort (n is small — a handful of cycles)
      for (i = 1; i < n; i++) { x = v[i]; j = i - 1; while (j >= 0 && v[j] > x) { v[j+1] = v[j]; j-- } v[j+1] = x }
      s = 0; for (i = 0; i < n; i++) s += v[i]
      if (n % 2) med = v[(n-1)/2]; else med = (v[n/2 - 1] + v[n/2]) / 2.0
      printf "min=%.3f median=%.3f max=%.3f mean=%.3f n=%d\n", v[0], med, v[n-1], s/n, n
    }'
}

# --- cluster-free unit test (TDD) --------------------------------------------
if [ "${1:-}" = "selftest" ]; then
  fails=0
  check() { # <label> <got> <want>
    if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1: got [$2] want [$3]"; fails=$((fails+1)); fi
  }
  # odd n, unsorted input -> median is the middle of the SORTED values
  got=$(printf '5\n1\n3\n2\n4\n' | stats)
  check "odd n sorts + median" "$got" "min=1.000 median=3.000 max=5.000 mean=3.000 n=5"
  # even n -> median is the mean of the two middle sorted values
  got=$(printf '10\n2\n8\n4\n' | stats)
  check "even n median = mean of middles" "$got" "min=2.000 median=6.000 max=10.000 mean=6.000 n=4"
  # single value
  got=$(printf '7.5\n' | stats)
  check "single value" "$got" "min=7.500 median=7.500 max=7.500 mean=7.500 n=1"
  # empty input
  got=$(printf '' | stats)
  check "empty input" "$got" "min=na median=na max=na mean=na n=0"
  # sub-second fractional lags (the expected warm regime)
  got=$(printf '0.4\n0.2\n0.9\n' | stats)
  check "fractional sub-second" "$got" "min=0.200 median=0.400 max=0.900 mean=0.500 n=3"
  if [ "$fails" -eq 0 ]; then echo "selftest PASSED"; exit 0; else echo "selftest FAILED ($fails)"; exit 1; fi
fi

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
# retry_ok <n> <cmd...> — run cmd up to n times until it exits 0. The OKE API server
# intermittently drops a single request with a "TLS handshake timeout"; the
# success-critical, single-shot precondition/provisioning gates are wrapped so one
# transient blip does not abort an otherwise-healthy drill. All wrapped calls are
# idempotent (get/apply/rollout/init-plane), so a retry is always safe.
retry_ok() { local n="$1"; shift; local i=0; while [ $i -lt "$n" ]; do if "$@"; then return 0; fi; i=$((i+1)); sleep 4; done; return 1; }

cleanup() {
  echo "    cleanup: deleting AppDatabase/$APP + reclaiming residue"
  K delete pod "meas-$APP" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  K delete appdatabase "$APP" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  local i=0; while K get appdatabase "$APP" >/dev/null 2>&1 && [ $i -lt 30 ]; do i=$((i+1)); sleep 1; done
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$APP" >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" reclaim-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

app_pw() { K get secret "app-db-$1" -o jsonpath='{.data.PGPASSWORD}' | base64 -d; }
sec_key() { K get secret "app-db-$1" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || true; }
cr_status() { K get appdatabase "$1" -o jsonpath="{.status.$2}" 2>/dev/null || true; }
writer_dsn() { echo "postgres://app_$1:$(app_pw "$1")@pggw-apps:55432/$1?sslmode=disable"; }
ro_dsn()     { sec_key "$1" DATABASE_URL_RO; }

# PSQL <tag> <dsn> <sql> — one-shot psql from a throwaway alpine pod (provisioning
# probes only; the actual measurement runs in the single long-lived pod below).
PSQL() {
  local tag="$1" dsn="$2" sql="$3"
  local p; p="msq-$$-$(printf '%s' "$tag" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
  K run "$p" --image="$PSQL_IMG" --image-pull-policy=IfNotPresent --env=PGCONNECT_TIMEOUT=10 \
    --restart=Never --quiet --command -- psql "$dsn" -tAw -c "$sql" >/dev/null 2>&1 || true
  local phase="" i=0
  while [ $i -lt 150 ]; do
    phase=$(K get pod "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
  done
  local out; out=$(K logs "$p" 2>&1 || true)
  K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if [ "$phase" = "Succeeded" ]; then echo "$out"; return 0; fi
  echo "$out" >&2; return 1
}
RETRY() { # <tag> <dsn> <sql> — retry a POSITIVE connect through the cold-boot role race (#132)
  local out
  for _t in 1 2 3 4 5 6; do
    if out="$(PSQL "$1-$_t" "$2" "$3" 2>/dev/null)"; then echo "$out"; return 0; fi
    sleep 3
  done
  return 1
}

# 0. preconditions (mirror _verify-perapp-ro.sh; retry_ok absorbs transient API blips)
retry_ok 4 K get crd appdatabases.apps.scale-zero-pg.dev >/dev/null 2>&1 || fail "AppDatabase CRD not installed"
retry_ok 3 K rollout status deploy/appdb-operator --timeout=120s >/dev/null || fail "appdb-operator not ready"
retry_ok 3 K rollout status deploy/pggw-apps --timeout=120s >/dev/null || fail "apps-gateway not ready"
retry_ok 4 sh -c "kubectl --context '$KCTX' -n '$NS' get deploy pggw-apps -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name==\"GW_RO_PORT\")].value}' | grep -q 55434" \
  || fail "apps-gateway has no GW_RO_PORT=55434 (per-app RO listener not wired)"
ok "apps-gateway RO listener wired (GW_RO_PORT=55434, template mode -> compute-ro-<app>)"
retry_ok 4 env KCTX="$KCTX" NS="$NS" "$PROV" init-plane >/dev/null || fail "init-plane failed"
ok "plane initialized"
K delete appdatabase "$APP" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
KCTX="$KCTX" NS="$NS" "$PROV" destroy "$APP" >/dev/null 2>&1 || true

# 1. provision the throwaway app with roPool enabled
echo "==> applying AppDatabase/$APP (roPool.enabled)"
MANIFEST="$(mktemp)"; trap 'rm -f "$MANIFEST"' RETURN 2>/dev/null || true
cat > "$MANIFEST" <<EOF
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata: { name: $APP, namespace: $NS }
spec:
  appName: $APP
  tier: cold
  roPool: { enabled: true, minReplicas: 0, maxReplicas: 3 }
EOF
retry_ok 4 K apply -f "$MANIFEST" >/dev/null || fail "AppDatabase/$APP apply failed"
rm -f "$MANIFEST"
PHASE=""; i=0
while [ $i -lt 120 ]; do
  PHASE="$(cr_status "$APP" phase)"
  [ "$PHASE" = "Ready" ] && break
  [ "$PHASE" = "Failed" ] && fail "AppDatabase/$APP Failed: $(cr_status "$APP" message)"
  i=$((i+1)); sleep 1
done
[ "$PHASE" = "Ready" ] || fail "AppDatabase/$APP did not reach Ready (phase=$PHASE)"
retry_ok 4 K get deploy "compute-ro-$APP" >/dev/null 2>&1 || fail "operator did not provision compute-ro-$APP"
RO="$(ro_dsn "$APP")"; [ -n "$RO" ] || fail "no DATABASE_URL_RO for $APP"
ok "$APP Ready; compute-ro-$APP provisioned; DATABASE_URL_RO -> pggw-apps:55434/$APP"

# 2. ensure the marker table exists on the WRITER (replicates to the RO via WAL). RETRY
#    absorbs the cold-boot role race on the first writer wake (#132).
RETRY mktable "$(writer_dsn "$APP")" \
  "create table if not exists app_items(id serial primary key, note text)" >/dev/null \
  || fail "could not create/verify app_items on the writer"
ok "marker table app_items present on the writer (replicates to compute-ro-$APP)"

# 3. WARM both lanes: a positive read on each wakes it 0->1 and applies the per-app role;
#    the actual walreceiver steady-state warm-up happens inside the measurement pod's
#    WARMUP cycles below.
RETRY warmw "$(writer_dsn "$APP")" "select 1" >/dev/null || fail "warm writer failed"
RETRY warmr "$(ro_dsn "$APP")" "select 1" >/dev/null || fail "warm RO failed"
ok "writer + compute-ro-$APP both awake (0->1); walreceiver warm-up follows in-pod"

# 4. the measurement pod: ONE long-lived pod, both DSNs, 100ms poll, GNU date +%N.
#    Base64 the body so nested SQL single-quotes survive the kubectl argv boundary.
read -r -d '' POD_BODY <<'POD' || true
set -u
seen() { psql "$RO_DSN" -tAqc "select count(*) from app_items where note='$1'" 2>/dev/null | tr -dc '0-9'; }
uniq() { echo "$1-$(date +%s%N)-$$"; }
# commit <marker> — INSERT the marker on the writer, retrying until psql actually exits
# 0 (a server-acknowledged COMMIT). This is the crux of an honest staleness number on a
# flaky control plane: a write whose connection was reset by an API-server blip must NOT
# be mistaken for replication lag. psql exits non-zero on a reset/refused/timed-out
# connection (nothing committed) and exits 0 only after the row is durably committed on
# the writer — so we retry the WRITE, then time only the WRITE->RO-visible interval.
commit() {
  a=0
  while [ "$a" -lt 40 ]; do
    if psql "$W_DSN" -tAqc "insert into app_items(note) values ('$1')" >/dev/null 2>&1; then return 0; fi
    a=$((a+1)); sleep 0.5
  done
  return 1
}
echo "MEAS-POD-START warmup=$WARMUP cycles=$CYCLES"
# WARMUP cycles (DISCARDED): drive the RO's walreceiver into steady-state streaming so
# the one-time COLD initial catch-up is excluded from the measured window. The RO poll
# here is generous (up to 150s) precisely to absorb that cold catch-up on the first cycle.
w=0
while [ "$w" -lt "$WARMUP" ]; do
  m="$(uniq warm)"
  if ! commit "$m"; then echo "WARM $w WRITE-FAILED (write never committed on a blip)"; w=$((w+1)); continue; fi
  j=0; while [ "$j" -lt 1500 ]; do [ "$(seen "$m")" = "1" ] && break; j=$((j+1)); sleep 0.1; done
  if [ "$(seen "$m")" = "1" ]; then echo "WARM $w visible polls=$j"; else echo "WARM $w NOT-VISIBLE-in-150s polls=$j"; fi
  w=$((w+1)); sleep 1
done
# MEASURED cycles: commit (retried to a real COMMIT) -> START clock -> poll RO @100ms
# until visible -> STOP clock. The RO poll is bounded to 60s here: on a WARM plane a
# tip-following replica catches up in well under the ~9s contract, so a >60s wait is a
# genuine anomaly to surface, NOT something to silently fold into the lag number.
c=0
while [ "$c" -lt "$CYCLES" ]; do
  m="$(uniq meas)"
  if ! commit "$m"; then echo "CYCLE $c WRITE-FAILED (excluded — dropped write, not lag)"; c=$((c+1)); continue; fi
  t0=$(date +%s.%N)              # clock starts at the acknowledged writer COMMIT
  j=0; while [ "$j" -lt 600 ]; do [ "$(seen "$m")" = "1" ] && break; j=$((j+1)); sleep 0.1; done
  t1=$(date +%s.%N)
  if [ "$(seen "$m")" != "1" ]; then echo "CYCLE $c RO-NOT-CAUGHTUP-in-60s polls=$j"; c=$((c+1)); continue; fi
  lag=$(awk "BEGIN{printf \"%.3f\", $t1-$t0}")
  echo "CYCLE $c lag_s=$lag polls=$j"
  c=$((c+1)); sleep 1
done
echo "MEAS-POD-DONE"
POD
B64="$(printf '%s' "$POD_BODY" | base64 | tr -d '\n')"

echo "==> running the in-pod measurement (image=$MEAS_IMG, warmup=$WARMUP, cycles=$CYCLES)"
K delete pod "meas-$APP" --ignore-not-found --wait=true --timeout=30s >/dev/null 2>&1 || true
retry_ok 4 K run "meas-$APP" --image="$MEAS_IMG" --image-pull-policy=IfNotPresent --restart=Never --quiet \
  --env="W_DSN=$(writer_dsn "$APP")" --env="RO_DSN=$(ro_dsn "$APP")" \
  --env="WARMUP=$WARMUP" --env="CYCLES=$CYCLES" \
  --command -- sh -c "echo $B64 | base64 -d | sh" >/dev/null \
  || fail "could not launch the measurement pod"

# wait for the pod to finish (bounded: warmup+cycles cycles, each <=150s poll ceiling)
PHASE=""; i=0; MAXW=$(( (WARMUP + CYCLES) * 170 + 120 ))
while [ $i -lt $MAXW ]; do
  PHASE=$(K get pod "meas-$APP" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  case "$PHASE" in Succeeded|Failed) break;; esac; i=$((i+2)); sleep 2
done
LOG="$(K logs "meas-$APP" 2>&1 || true)"
echo "----- measurement pod log -----"
echo "$LOG"
echo "-------------------------------"
[ "$PHASE" = "Succeeded" ] || fail "measurement pod did not Succeed (phase=$PHASE)"
echo "$LOG" | grep -q "MEAS-POD-DONE" || fail "measurement pod did not complete all cycles"

# 5. compute + report warm-plane steady-state stats
LAGS="$(echo "$LOG" | sed -n 's/^CYCLE [0-9]* lag_s=\([0-9.]*\).*/\1/p')"
NMEAS=$(printf '%s\n' "$LAGS" | grep -c . || true)
[ "$NMEAS" -ge 5 ] || fail "fewer than 5 measured cycles (got $NMEAS) — re-run (set CYCLES>=5)"
STATS="$(printf '%s\n' "$LAGS" | stats)"
ok "warm-plane per-app RO staleness over $NMEAS steady-state cycles: $STATS"
echo "RO_STALENESS_WARM app=$APP mode=Replica plane=warm $STATS raw=[$(printf '%s' "$LAGS" | tr '\n' ' ' | sed 's/ $//')]"

# verdict
MED=$(printf '%s' "$STATS" | sed -n 's/.*median=\([0-9.]*\).*/\1/p')
if awk "BEGIN{exit !($MED <= 9.0)}"; then
  ok "VERDICT: steady-state median ${MED}s <= ~9s contract HOLDS — the #167 90s was COLD-plane initial catch-up"
else
  echo "VERDICT: steady-state median ${MED}s EXCEEDS ~9s — real contract concern, root-cause required" >&2
fi

trap - EXIT
cleanup
echo "warm-plane RO staleness measurement complete."
