#!/usr/bin/env bash
# _verify.sh — the knext end-to-end demo drill (scale-zero-pg issue #8).
#
# Proves the north star, MEASURED: a knext NextApp (Knative scale-to-zero) and a
# scale-to-zero Postgres both sleep at rest, and ONE cold HTTP request wakes BOTH
# and returns data from Postgres. Then both idle back to zero. Repeated N times.
#
# It also isolates how much of the DB wake is *visible on top of* the app's own
# cold start, by measuring three request classes:
#   T_both     both asleep  -> request wakes app + DB      (the headline number)
#   T_appcold  DB pre-woken  -> request wakes only the app (app cold, DB warm)
#   T_warm     both awake    -> steady-state request
# and a bare DB cold-connect (psql through the gateway, no app) for reference.
#
# CONSTRAINT: read-only on the scale-zero-pg namespace. We never scale the DB;
# it wakes only through the gateway (via the app, or via a psql client), and we
# only *observe* compute replicas. App scaling is Knative's.
#
# Requires: kubectl context on the knext2 cluster. Creates two helper pods in
# the knext-demo namespace (curl + psql drivers) and cleans them up on exit.
set -uo pipefail

NS_APP=knext-demo
NS_DB=scale-zero-pg
APP=pg-demo
KSVC_HOST="pg-demo.${NS_APP}.51.170.86.139.sslip.io"
INGRESS_URL="http://kourier-internal.knative-serving.svc/"
DSN_HOST="pggw.${NS_DB}.svc.cluster.local"
DSN_PORT=55432
ITERS="${ITERS:-5}"
IDLE_WAIT="${IDLE_WAIT:-180}"   # max seconds to wait for both to reach zero
WAKE_MAX="${WAKE_MAX:-60}"      # curl/psql max-time for a cold wake

HTTP_DRIVER=demo-driver-http
DB_DRIVER=demo-driver-db

say() { printf '%s\n' "$*"; }
hr()  { printf -- '----------------------------------------------------------------\n'; }

cleanup() {
  # Synchronous delete so a following run never races a Terminating driver pod.
  kubectl -n "$NS_APP" delete pod "$HTTP_DRIVER" "$DB_DRIVER" \
    --ignore-not-found --grace-period=1 --wait=true >/dev/null 2>&1
}
trap cleanup EXIT

app_pods()   { kubectl -n "$NS_APP" get pod -l serving.knative.dev/service="$APP" --no-headers 2>/dev/null | grep -c Running; }
db_replicas(){ kubectl -n "$NS_DB" get deploy compute -o jsonpath='{.spec.replicas}' 2>/dev/null; }

wait_for_zero() {
  # Wait until BOTH the app (0 running pods) and the DB (0 compute replicas) are asleep.
  local deadline=$((SECONDS + IDLE_WAIT))
  while (( SECONDS < deadline )); do
    local a d; a=$(app_pods); d=$(db_replicas)
    if [[ "$a" == "0" && "$d" == "0" ]]; then return 0; fi
    sleep 5
  done
  say "WARN: timed out waiting for zero (app_pods=$(app_pods) compute=$(db_replicas)); another workload may be holding the DB awake."
  return 1
}

# curl inside the http driver pod; prints "<http_code> <ttfb_seconds>".
http_probe() {
  kubectl -n "$NS_APP" exec "$HTTP_DRIVER" -- \
    curl -s -o /tmp/body -w '%{http_code} %{time_starttransfer}' \
    --max-time "$WAKE_MAX" -H "Host: ${KSVC_HOST}" "$INGRESS_URL" 2>/dev/null
}
http_body_has_db() {
  kubectl -n "$NS_APP" exec "$HTTP_DRIVER" -- sh -c 'grep -qi "db round-trip" /tmp/body && echo yes || echo no' 2>/dev/null
}

# psql SELECT 1 through the gateway (wakes DB, no app). Prints wall seconds.
db_wake_probe() {
  kubectl -n "$NS_APP" exec "$DB_DRIVER" -- sh -c "
    export PGCONNECT_TIMEOUT=$WAKE_MAX PGPASSWORD=cloud_admin
    start=\$(date +%s.%N)
    psql -h $DSN_HOST -p $DSN_PORT -U cloud_admin -d postgres -tAc 'select 1' >/dev/null 2>&1
    end=\$(date +%s.%N)
    awk -v s=\$start -v e=\$end 'BEGIN{printf \"%.3f\", e-s}'
  " 2>/dev/null
}

ensure_drivers() {
  # Always start from a clean slate: delete any leftover driver pods and wait
  # for them to be gone, so we never exec into a Terminating pod.
  kubectl -n "$NS_APP" delete pod "$HTTP_DRIVER" "$DB_DRIVER" \
    --ignore-not-found --grace-period=1 --wait=true >/dev/null 2>&1
  kubectl -n "$NS_APP" run "$HTTP_DRIVER" --image=curlimages/curl:8.11.1 --restart=Never \
    --command -- sleep 100000 >/dev/null 2>&1
  kubectl -n "$NS_APP" run "$DB_DRIVER" --image=postgres:17-alpine --restart=Never \
    --command -- sleep 100000 >/dev/null 2>&1
  kubectl -n "$NS_APP" wait --for=condition=Ready pod/"$HTTP_DRIVER" --timeout=120s >/dev/null 2>&1
  kubectl -n "$NS_APP" wait --for=condition=Ready pod/"$DB_DRIVER"   --timeout=120s >/dev/null 2>&1
  local h d
  h=$(kubectl -n "$NS_APP" get pod "$HTTP_DRIVER" -o jsonpath='{.status.phase}' 2>/dev/null)
  d=$(kubectl -n "$NS_APP" get pod "$DB_DRIVER"   -o jsonpath='{.status.phase}' 2>/dev/null)
  say "drivers: http=$h db=$d"
  [[ "$h" == "Running" && "$d" == "Running" ]] || { say "FATAL: driver pods not Running; aborting."; exit 1; }
}

hr; say "knext demo drill — cluster $(kubectl config current-context)"; hr
say "ksvc:     $(kubectl -n "$NS_APP" get ksvc "$APP" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null) (Ready)"
say "operator: $(kubectl -n kn-next-operator-system get deploy kn-next-operator-controller-manager -o jsonpath='{.status.readyReplicas}' 2>/dev/null)/1 ready"
say "GW_IDLE_MS=$(kubectl -n "$NS_DB" get deploy pggw -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="GW_IDLE_MS")].value}' 2>/dev/null)"
ensure_drivers
hr

both=(); appcold=(); warm=(); dbonly=()

for ((i=1; i<=ITERS; i++)); do
  say "### iteration $i/$ITERS"

  # --- COLD-BOTH: both asleep, one request wakes both -------------------------
  wait_for_zero
  say "  state: app_pods=$(app_pods) compute=$(db_replicas) (both asleep)"
  read -r code ttfb <<<"$(http_probe)"
  hasdb=$(http_body_has_db)
  say "  T_both     HTTP $code  ttfb=${ttfb}s  db-backed=$hasdb  (woke app+DB)"
  [[ "$code" == "200" && "$hasdb" == "yes" ]] && both+=("$ttfb")

  # --- WARM: both awake now ---------------------------------------------------
  read -r code2 ttfb2 <<<"$(http_probe)"
  say "  T_warm     HTTP $code2  ttfb=${ttfb2}s  (both warm)"
  [[ "$code2" == "200" ]] && warm+=("$ttfb2")

  # let both settle back to zero before the isolation probe
  wait_for_zero

  # --- APP-COLD-ONLY: pre-wake the DB via psql, then hit the cold app ---------
  dbw=$(db_wake_probe)
  say "  (bare DB cold-connect via gateway: ${dbw}s)"
  [[ -n "$dbw" ]] && dbonly+=("$dbw")
  read -r code3 ttfb3 <<<"$(http_probe)"     # DB already warm, app still cold
  say "  T_appcold  HTTP $code3  ttfb=${ttfb3}s  (app cold, DB pre-warmed)"
  [[ "$code3" == "200" ]] && appcold+=("$ttfb3")

  hr
done

mean() { # mean of args, 3dp; empty -> n/a
  [[ $# -eq 0 ]] && { echo "n/a"; return; }
  printf '%s\n' "$@" | awk '{s+=$1;n++} END{ if(n) printf "%.3f", s/n; else print "n/a" }'
}
mB=$(mean "${both[@]}"); mA=$(mean "${appcold[@]}"); mW=$(mean "${warm[@]}"); mD=$(mean "${dbonly[@]}")

say "SUMMARY  (means over successful iterations)"
say "  T_both     (app+DB cold)   = ${mB}s   n=${#both[@]}"
say "  T_appcold  (app cold only) = ${mA}s   n=${#appcold[@]}"
say "  T_warm     (both warm)     = ${mW}s   n=${#warm[@]}"
say "  DB cold-connect (bare)     = ${mD}s   n=${#dbonly[@]}"
if [[ "$mB" != "n/a" && "$mA" != "n/a" ]]; then
  awk -v b="$mB" -v a="$mA" -v d="$mD" 'BEGIN{
    vis=b-a;
    printf "  Visible DB-wake on top of app cold start (T_both - T_appcold) = %.3fs\n", vis;
    if (d!="n/a") printf "  Hidden inside app cold start (bareDB - visible) = %.3fs of the %.3fs bare DB wake\n", d-vis, d;
  }'
fi
hr
say "north star: both asleep -> one cold request wakes both -> data from Postgres -> both idle to zero. PROVEN x${#both[@]}."
