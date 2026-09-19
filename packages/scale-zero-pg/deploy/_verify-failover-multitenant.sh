#!/bin/sh
# _verify-failover-multitenant.sh — does a pageserver failover keep the WHOLE
# multi-tenant plane (base tenant + every per-app tenant), or does it strand all
# but one tenant behind a Service that has flipped to a pageserver where only one
# tenant is attached?
#
# WHY THIS EXISTS (separate from _verify-pageserver-failover.sh): the existing
# failover drill is SINGLE-TENANT by construction — it stands up its own throwaway
# namespace with ONE fixed tenant (TENANT=e0e0…001) and one compute, so it can
# only ever observe the single-tenant flip. It structurally cannot see the
# multi-tenant split-brain that the live GKE run hit 2026-09-19:
#
#   The pswatcher (deploy/58) promotes ONLY the base tenant — PSW_TENANT_ID is
#   compute-config.TENANT_ID and PSW_COMPUTE_SELECTOR is app=compute — then flips
#   the `pageserver` Service selector to the standby. Every OTHER tenant (the
#   `apps` tenant a0000…001 that owns every per-app timeline, and thus every
#   per-app database) is NEVER re-attached on the promoted pageserver, yet the
#   Service now routes them there. Result: stranded per-app tenants, a
#   storage-init generation wedge on re-bootstrap, per-app computes still pointed
#   at the dead pageserver, and the operator keep-alive pinned to the stale one.
#
# This drill runs against the LIVE plane (scale-zero-pg + the apps plane), forces
# a real failover, and asserts every link the incident exposed. Each assertion is
# mapped to a sprint task [T1..T6] so a later fix greens exactly one:
#
#   [T2] no split-brain  — after failover EVERY tenant (base + each per-app) is
#                          attached on the promoted pageserver AND reachable via
#                          the `pageserver` Service (GET /v1/tenant/<T> == 200
#                          through the Service, never a pod IP).
#   [T1] no gen-wedge    — re-attaching a tenant at the CURRENT ledger generation
#                          SUCCEEDS (no "Generation N is less than existing M").
#   [T3] computes bounced— zero compute pods (base + per-app writer + RO,
#                          plane=compute / compute-ro) that predate the failover
#                          survive.
#   [T4] operator recovers, NO restart — appdb-operator reconciles a per-app
#                          tenant through the Service after the flip with its
#                          restartCount unchanged.
#   [T6] convergence/MTTR — the Service selector + tenant states converge within a
#                          bounded time WITHOUT a manual pswatcher-stop or
#                          selector-patch (soft in this task).
#
# RED BY CONSTRUCTION ON MAIN: none of T1..T6 are implemented yet, so on today's
# plane T2 strands the apps tenant, T1 wedges its re-attach, T3 leaves per-app
# computes unbounced, T4 fails to reconcile through the Service, and T6 never
# converges. Each fails with its own [Tn] message; a fix turns exactly one green.
# The assertion phase COLLECTS all failures (like _validate.sh) and reports every
# task in one run, so the fix team can see which task greened.
#
# KILL MECHANISM (chosen deliberately): the primary pageserver StatefulSet is
# SCALED TO ZERO (`kubectl scale statefulset/pageserver --replicas=0`), NOT
# deleted. This is recoverable (the drill scales it back on cleanup) and avoids
# the human-gated `kubectl delete` of a durable object. The pswatcher detects the
# vanished endpoint via the pageserver-primary liveness Service and fails over on
# its own — no manual step. NOTE: this drill MAY call `kubectl delete` only for
# its OWN throwaway helper pods and to deprovision the apps it created; it never
# deletes a plane object. Provisioning uses deploy/provision-app.sh (break-glass
# path) so no operator CR contract is bypassed.
#
# Honesty rule (mirrors _verify-tls.sh leg-b): the drill SKIPS cleanly ONLY when
# the apps plane is entirely absent (nothing multi-tenant to test). A
# present-but-broken chain (apps CRD without the operator, or the failover
# machinery — pswatcher/standby — missing) is a FAILURE, never a half-run that
# still reports success.
#
# Env (same KCTX/NS pattern as provision-app.sh; KSPG_CONTEXT also honored):
#   KCTX          kube context (default context-ckmva7v7zvq)
#   NS            namespace   (default scale-zero-pg)
#   T7_APPS       space-separated app names to provision (default "t7drilla t7drillb")
#   APPS_TENANT   apps tenant id (default a0000000000000000000000000000001)
#   FAILOVER_BUDGET  seconds to wait for the Service to flip (default 120)
#   CONVERGE_BUDGET  seconds allowed for full multi-tenant convergence (default 180)
#   T7_KEEP=1     leave the provisioned apps up for inspection (skip deprovision)
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
KUBECTL="${KUBECTL:-kubectl}"
KCTX="${KCTX:-${KSPG_CONTEXT:-context-ckmva7v7zvq}}"
NS="${NS:-scale-zero-pg}"
RT="--request-timeout=60s"
K="$KUBECTL -n $NS $RT"

T7_APPS="${T7_APPS:-t7drilla t7drillb}"
APPS_TENANT="${APPS_TENANT:-a0000000000000000000000000000001}"
FAILOVER_BUDGET="${FAILOVER_BUDGET:-120}"
CONVERGE_BUDGET="${CONVERGE_BUDGET:-180}"

PS_SVC=pageserver              # client-facing Service the pswatcher flips a->standby
PRIMARY_STS=pageserver         # primary pageserver StatefulSet (the kill target)
STANDBY_STS=pageserver-standby # warm standby the pswatcher promotes
GEN_CM=pageserver-generation   # generation ledger
OPERATOR=appdb-operator        # apps-plane reconcile operator
APPS_GW=pggw-apps              # apps gateway (wakes per-app computes)

DIR="$(dirname "$0")"
# psql client image (public, always-pullable) — same rationale as _verify-tls.sh.
PSQL_IMG="${PSQL_IMG:-postgres:17-alpine}"

info() { echo ">> $*"; }
ok()   { echo "ok - $*"; }
skip() { echo "SKIP: $*"; exit 0; }
fail() { echo "FAIL(setup): $*" >&2; exit 1; }

# --- collect-all assertion recorder (the #797 pattern from _validate.sh): a
# failing task does NOT abort the run, so EVERY [Tn] verdict prints in one pass
# and the fix team can see which task greened. ------------------------------
ASSERT_FAILS=0
t_fail() { ASSERT_FAILS=$((ASSERT_FAILS + 1)); echo "not ok - [$1] $2" >&2; }
t_ok()   { echo "ok - [$1] $2"; }

command -v "$KUBECTL" >/dev/null 2>&1 || fail "kubectl not found"
CUR_CTX="$($KUBECTL config current-context 2>/dev/null || echo '')"
[ "$CUR_CTX" = "$KCTX" ] || fail "expected kube-context '$KCTX' (current '$CUR_CTX'; set KCTX/KSPG_CONTEXT to override)"
$K get ns "$NS" >/dev/null 2>&1 || fail "namespace $NS not found on context $KCTX"

# ---------------------------------------------------------------------------
# GATE: apps plane present? (skip cleanly only if ENTIRELY absent). ----------
HAVE_CRD=0; $KUBECTL get crd appdatabases.ks-pg.dev >/dev/null 2>&1 && HAVE_CRD=1
HAVE_OP=0;  $K get deploy "$OPERATOR" >/dev/null 2>&1 && HAVE_OP=1
if [ "$HAVE_CRD" = 0 ] && [ "$HAVE_OP" = 0 ]; then
  skip "apps plane entirely absent (no AppDatabase CRD, no $OPERATOR) — nothing multi-tenant to test on this cluster. Provision the apps plane (deploy/82+83) to run this drill."
fi
[ "$HAVE_CRD" = 1 ] || fail "present-but-broken apps plane: $OPERATOR is deployed but the AppDatabase CRD is missing (deploy/82-appdb-crd.yaml)"
[ "$HAVE_OP" = 1 ]  || fail "present-but-broken apps plane: the AppDatabase CRD exists but $OPERATOR is not deployed (deploy/83-appdb-operator.yaml)"

# The failover machinery MUST be live — this drill relies on the LIVE pswatcher +
# standby, not a self-contained fixture. Their absence is a broken chain, not a skip.
$K get deploy pswatcher >/dev/null 2>&1 || fail "present-but-broken failover chain: pswatcher (deploy/58) not deployed — a multi-tenant failover cannot be exercised"
$K get statefulset "$STANDBY_STS" >/dev/null 2>&1 || fail "present-but-broken failover chain: $STANDBY_STS (deploy/57) not deployed — nothing to fail over to"
$K get statefulset "$PRIMARY_STS" >/dev/null 2>&1 || fail "primary pageserver StatefulSet $PRIMARY_STS not found"
$K get svc "$PS_SVC" >/dev/null 2>&1 || fail "client-facing $PS_SVC Service not found"

BASE_TENANT="$($K get configmap compute-config -o jsonpath='{.data.TENANT_ID}' 2>/dev/null || echo '')"
[ -n "$BASE_TENANT" ] || fail "could not read the base tenant id from the compute-config ConfigMap"
info "apps plane present: base tenant $BASE_TENANT, apps tenant $APPS_TENANT; failover machinery live"

# ---------------------------------------------------------------------------
# Cleanup: restore the primary + deprovision the drill's apps. Best-effort. ---
PROVISIONED=""
cleanup() {
  code=$?
  info "cleanup: restoring primary pageserver + deprovisioning drill apps"
  # scale the primary back up (recoverable kill). After a real promotion the
  # standby is authoritative; re-seeding the old primary is an operator concern —
  # this only undoes the scale so the StatefulSet is not left at 0 by the drill.
  $K scale statefulset/"$PRIMARY_STS" --replicas=1 >/dev/null 2>&1 || true
  if [ "${T7_KEEP:-0}" = "1" ]; then
    info "cleanup: T7_KEEP=1 — leaving provisioned apps [$PROVISIONED] up"
  else
    for a in $PROVISIONED; do
      KCTX="$KCTX" NS="$NS" sh "$DIR/provision-app.sh" destroy "$a" >/dev/null 2>&1 || true
    done
  fi
  exit $code
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# psql one-shot from a throwaway in-cluster pod (wakes a compute through a
# gateway Service). Returns the last output line; rc!=0 on pod failure. --------
PSQL() { # $1 tag  $2 dsn  $3 sql
  P="t7psql-$$-$1"
  $K run "$P" --image="$PSQL_IMG" --image-pull-policy=IfNotPresent \
    --restart=Never --quiet --command -- psql "$2" -tA -c "$3" >/dev/null 2>&1
  $K wait --for=jsonpath='{.status.phase}'=Succeeded pod/"$P" --timeout=180s >/dev/null 2>&1 || true
  _out="$($K logs "$P" 2>&1)"
  _phase="$($K get pod "$P" -o jsonpath='{.status.phase}' 2>/dev/null)"
  $K delete pod "$P" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  [ "$_phase" = Succeeded ] || { echo "$_out"; return 1; }
  echo "$_out" | tail -1
}

# curl the pageserver *through the Service* by exec'ing inside the standby pod
# (neon image ships curl; the pod resolves `pageserver` via cluster DNS, so the
# request is Service-routed to whichever endpoint the Service currently selects —
# exactly what the incident's stranded tenants hit). --------------------------
SVC_CODE() { # $1 = path -> echoes HTTP status code (000 on transport failure)
  c="$($K exec sts/"$STANDBY_STS" -- curl -s -o /dev/null -w '%{http_code}' \
        --max-time 10 "http://$PS_SVC:9898$1" 2>/dev/null || echo 000)"
  [ -n "$c" ] && echo "$c" || echo 000
}
SVC_PUT() { # $1 = path  $2 = json body -> echoes response body
  $K exec sts/"$STANDBY_STS" -- curl -s --max-time 15 -X PUT \
    -H 'Content-Type: application/json' -d "$2" "http://$PS_SVC:9898$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
info "STEP 1: provision >=2 per-app tenants and wake them Active"
for a in $T7_APPS; do
  info "  provisioning app '$a' (provision-app.sh create)"
  KCTX="$KCTX" NS="$NS" sh "$DIR/provision-app.sh" create "$a" >/dev/null 2>&1 \
    || fail "provision-app.sh create $a failed — cannot stand up the multi-tenant fixture"
  PROVISIONED="$PROVISIONED $a"
done
# init the apps plane if create implied it exists; provision-app create requires
# init-plane to have run — surface a clear error rather than a confusing timeline miss.
for a in $T7_APPS; do
  TL="$($K get configmap "compute-config-$a" -o jsonpath='{.data.TIMELINE_ID}' 2>/dev/null || echo '')"
  [ -n "$TL" ] || fail "app '$a' has no per-app timeline (compute-config-$a) — is the apps plane initialized (provision-app.sh init-plane)?"
done
# Wake: connect through the apps gateway as the per-app role so the per-app
# compute scales 0->1 (Active). A wake failure here is a setup failure.
for a in $T7_APPS; do
  APPPW="$($K get secret "app-db-$a" -o jsonpath='{.data.PGPASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || echo '')"
  [ -n "$APPPW" ] || fail "no app-db-$a Secret (PGPASSWORD) minted by provision-app — cannot wake app '$a'"
  DSN="postgres://app_$a:$APPPW@$APPS_GW:55432/$a?sslmode=disable"
  [ "$(PSQL "wake-$a" "$DSN" 'select 1' 2>/dev/null)" = "1" ] \
    || fail "could not wake per-app compute for '$a' through $APPS_GW — the app is not Active, so a failover assertion would be meaningless"
  ok "app '$a' woke Active (per-app compute up, tenant $APPS_TENANT timeline $TL)"
done
# Wake the base tenant too (rely on it + warm/ro as the incident did).
BASE_CRED="$($K get secret myapp-database -o jsonpath='{.data.DATABASE_URL}' 2>/dev/null | base64 -d 2>/dev/null | sed -E 's#^postgres://(.*)@[^@]*#\1#' || echo '')"
[ -n "$BASE_CRED" ] || BASE_CRED="cloud_admin:cloud_admin"
PSQL base-wake "postgres://$BASE_CRED@pggw:55432/postgres?sslmode=disable" 'select 1' >/dev/null 2>&1 \
  && ok "base tenant woke Active" || info "  base tenant wake best-effort (continuing)"

# ---------------------------------------------------------------------------
# Snapshot pre-failover state used by T3 (survivor pods) and T4 (operator restart).
snapshot_compute_pods() {
  { $K get pods -l plane=compute --no-headers -o custom-columns=:metadata.name 2>/dev/null
    $K get pods -l app=compute-ro --no-headers -o custom-columns=:metadata.name 2>/dev/null
    $K get pods -l app=compute-warm --no-headers -o custom-columns=:metadata.name 2>/dev/null
  } | grep -v '^$' | sort -u
}
PRE_PODS="$(snapshot_compute_pods)"
OP_RESTARTS_BEFORE="$($K get pods -l app="$OPERATOR" -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' 2>/dev/null || echo 0)"
[ -n "$OP_RESTARTS_BEFORE" ] || OP_RESTARTS_BEFORE=0
info "pre-failover: $(echo "$PRE_PODS" | grep -c . ) compute pod(s), operator restartCount=$OP_RESTARTS_BEFORE"

# ---------------------------------------------------------------------------
info "STEP 2: KILL the primary pageserver (scale $PRIMARY_STS -> 0) — pswatcher must fail over"
FAILOVER_AT="$(date +%s)"
$K scale statefulset/"$PRIMARY_STS" --replicas=0 >/dev/null 2>&1 \
  || fail "could not scale $PRIMARY_STS to 0 (kill step)"
# wait for the pswatcher to flip the client Service selector off the primary.
SEL=""; w=0
while [ "$w" -lt "$FAILOVER_BUDGET" ]; do
  SEL="$($K get svc "$PS_SVC" -o jsonpath='{.spec.selector.app}' 2>/dev/null || echo '?')"
  [ "$SEL" = "$STANDBY_STS" ] && break
  w=$((w + 1)); sleep 1
done
if [ "$SEL" = "$STANDBY_STS" ]; then
  ok "pswatcher flipped the $PS_SVC Service selector to $STANDBY_STS (failover fired)"
else
  # The failover machinery itself did not act — every downstream [Tn] would be
  # attributed wrongly. This is a setup-level failure, not a task assertion.
  fail "pswatcher did NOT flip the $PS_SVC Service to $STANDBY_STS within ${FAILOVER_BUDGET}s (selector=$SEL) — the base-tenant failover never fired, so the multi-tenant assertions cannot be attributed"
fi

CUR_GEN="$($K get configmap "$GEN_CM" -o jsonpath='{.data.generation}' 2>/dev/null || echo '')"
[ -n "$CUR_GEN" ] || CUR_GEN=1
info "post-flip generation ledger = $CUR_GEN"

# ===========================================================================
# ASSERTION PHASE (collect-all). Each [Tn] fails for its OWN reason on main.
# ===========================================================================
echo ""
info "ASSERTIONS (each maps to a sprint task; red-by-construction on main)"

# --- [T2] no split-brain: EVERY tenant attached on the promoted pageserver AND
#     reachable through the `pageserver` Service. -----------------------------
T2_BUDGET="$CONVERGE_BUDGET"
tenant_reachable_via_svc() { # $1 tenant -> rc 0 iff GET /v1/tenant/<T> == 200 within budget
  _t="$1"; _s=0
  while [ "$_s" -lt "$T2_BUDGET" ]; do
    [ "$(SVC_CODE "/v1/tenant/$_t")" = "200" ] && return 0
    _s=$((_s + 3)); sleep 3
  done
  return 1
}
if tenant_reachable_via_svc "$BASE_TENANT"; then
  t_ok T2 "base tenant $BASE_TENANT attached + reachable through the $PS_SVC Service after failover"
else
  t_fail T2 "base tenant $BASE_TENANT is NOT reachable through the $PS_SVC Service after failover (GET /v1/tenant returned != 200) — the promoted pageserver is not serving it"
fi
# The apps tenant owns every per-app timeline. On main the pswatcher only promotes
# the base tenant, so the apps tenant is unattached on the promoted pageserver
# while the Service routes to it — the split-brain. This is the load-bearing check.
if tenant_reachable_via_svc "$APPS_TENANT"; then
  t_ok T2 "apps tenant $APPS_TENANT attached + reachable through the $PS_SVC Service (no split-brain)"
else
  t_fail T2 "SPLIT-BRAIN: apps tenant $APPS_TENANT is NOT attached/reachable through the $PS_SVC Service after failover — the pswatcher promoted only the base tenant, so every per-app database is stranded (the 2026-09-19 incident). Fix: promote ALL tenants, not just PSW_TENANT_ID"
fi
# each per-app timeline must be reachable under the (attached) apps tenant.
for a in $T7_APPS; do
  TL="$($K get configmap "compute-config-$a" -o jsonpath='{.data.TIMELINE_ID}' 2>/dev/null || echo '')"
  if [ -n "$TL" ] && [ "$(SVC_CODE "/v1/tenant/$APPS_TENANT/timeline/$TL")" = "200" ]; then
    t_ok T2 "per-app tenant '$a' (timeline $TL) reachable through the $PS_SVC Service"
  else
    t_fail T2 "per-app tenant '$a' (timeline ${TL:-?}) is NOT reachable through the $PS_SVC Service after failover — stranded because its apps tenant was not promoted"
  fi
done

# --- [T1] no gen-wedge: re-attaching a tenant at the CURRENT ledger generation
#     SUCCEEDS. On main, re-bootstrap/attach hits "Generation N is less than
#     existing M" because the storage-init/operator attach path does not track the
#     failover-advanced generation. --------------------------------------------
gen_wedge_check() { # $1 tenant -> rc 0 iff attach at $CUR_GEN has no wedge error
  _t="$1"
  _resp="$(SVC_PUT "/v1/tenant/$_t/location_config" \
      "{\"mode\":\"AttachedSingle\",\"generation\":$CUR_GEN,\"tenant_conf\":{}}")"
  case "$_resp" in
    *"less than existing"*|*"Generation"*less*) return 1 ;;
    *"error"*|*"Error"*) return 1 ;;
    *) return 0 ;;
  esac
}
for TEN in "$BASE_TENANT" "$APPS_TENANT"; do
  _label="base"; [ "$TEN" = "$APPS_TENANT" ] && _label="apps"
  if gen_wedge_check "$TEN"; then
    t_ok T1 "re-attach of $_label tenant $TEN at ledger generation $CUR_GEN SUCCEEDS (no gen-wedge)"
  else
    t_fail T1 "GEN-WEDGE: re-attaching $_label tenant $TEN at ledger generation $CUR_GEN was REJECTED ('Generation N is less than existing M') — the bootstrap/attach path does not honor the failover-advanced generation. Fix: attach at the current ledger generation, not a hardcoded 1"
  fi
done

# --- [T3] computes bounced: no pre-failover compute pod survives. On main the
#     pswatcher bounces only app=compute (base), so every per-app writer pod (and
#     any RO/warm) that predates the failover is still there. -------------------
survivors_check() {
  _budget="$CONVERGE_BUDGET"; _s=0
  while [ "$_s" -lt "$_budget" ]; do
    _now="$(snapshot_compute_pods)"
    _surv=""
    for p in $PRE_PODS; do
      echo "$_now" | grep -qx "$p" && _surv="$_surv $p"
    done
    [ -z "$_surv" ] && { echo ""; return 0; }
    _s=$((_s + 5)); sleep 5
  done
  echo "$_surv"; return 1
}
SURV="$(survivors_check)"
if [ -z "$SURV" ]; then
  t_ok T3 "all pre-failover compute pods were bounced (base + per-app writers + RO)"
else
  t_fail T3 "UNBOUNCED COMPUTES: these compute pods predate the failover and survived:${SURV} — the pswatcher only bounces app=compute (base), leaving per-app/RO computes pointed at the dead pageserver. Fix: bounce every plane=compute + compute-ro pod on failover"
fi

# --- [T4] operator recovers with NO restart: reconciles a per-app tenant through
#     the Service after the flip, restartCount unchanged. On main the operator
#     keep-alive is pinned to the stale pageserver, so reconcile fails and/or it
#     restarts. -----------------------------------------------------------------
OP_RESTARTS_AFTER="$($K get pods -l app="$OPERATOR" -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' 2>/dev/null || echo 0)"
[ -n "$OP_RESTARTS_AFTER" ] || OP_RESTARTS_AFTER=0
# reconcile proof: every provisioned AppDatabase must (re)reach phase Ready after
# the flip, driven through the `pageserver` Service, within the converge budget.
op_reconciled() {
  _s=0
  while [ "$_s" -lt "$CONVERGE_BUDGET" ]; do
    _all_ready=1
    for a in $T7_APPS; do
      _ph="$($K get appdatabase "$a" -o jsonpath='{.status.phase}' 2>/dev/null || echo '')"
      [ "$_ph" = "Ready" ] || _all_ready=0
    done
    [ "$_all_ready" = 1 ] && return 0
    _s=$((_s + 5)); sleep 5
  done
  return 1
}
OP_RECONCILED=1; op_reconciled || OP_RECONCILED=0
if [ "$OP_RESTARTS_AFTER" = "$OP_RESTARTS_BEFORE" ] && [ "$OP_RECONCILED" = 1 ]; then
  t_ok T4 "$OPERATOR reconciled every per-app AppDatabase through the Service post-failover with restartCount unchanged ($OP_RESTARTS_AFTER)"
else
  _why=""
  [ "$OP_RESTARTS_AFTER" != "$OP_RESTARTS_BEFORE" ] && _why="restartCount $OP_RESTARTS_BEFORE->$OP_RESTARTS_AFTER"
  [ "$OP_RECONCILED" != 1 ] && _why="${_why:+$_why; }not every AppDatabase returned to phase Ready within ${CONVERGE_BUDGET}s"
  t_fail T4 "OPERATOR DID NOT RECOVER CLEANLY: $_why — its keep-alive/reconcile is pinned to the stale pageserver and cannot follow the Service flip. Fix: reconcile via the $PS_SVC Service so no restart is needed"
fi

# --- [T6] convergence/MTTR (soft): the whole plane converged WITHOUT any manual
#     pswatcher-stop or selector-patch — this drill performed neither. Report the
#     bounded MTTR; fail if the aggregate state never converged. -----------------
CONVERGED_AT="$(date +%s)"
MTTR=$((CONVERGED_AT - FAILOVER_AT))
# aggregate: converged iff none of the load-bearing multi-tenant checks failed.
if [ "$ASSERT_FAILS" -eq 0 ] && [ "$MTTR" -le "$CONVERGE_BUDGET" ]; then
  t_ok T6 "multi-tenant plane converged in ${MTTR}s (<= ${CONVERGE_BUDGET}s) with NO manual pswatcher-stop / selector-patch"
else
  t_fail T6 "NO AUTONOMOUS CONVERGENCE: the multi-tenant plane did not converge within ${CONVERGE_BUDGET}s without manual intervention (elapsed ${MTTR}s; ${ASSERT_FAILS} task assertion(s) unmet above). Fix: T1-T4 so the failover converges on its own within the MTTR budget"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=========================================================================="
if [ "$ASSERT_FAILS" -eq 0 ]; then
  echo " MULTI-TENANT FAILOVER DRILL PASSED — every tenant survived the flip"
  echo "   MTTR (kill -> converged): ${MTTR}s"
  echo "=========================================================================="
  exit 0
else
  echo " MULTI-TENANT FAILOVER DRILL FAILED — $ASSERT_FAILS task assertion(s) unmet"
  echo "   (red-by-construction on main until T1-T6 land; each [Tn] above greens"
  echo "    exactly one fix). MTTR budget ${CONVERGE_BUDGET}s, elapsed ${MTTR}s."
  echo "=========================================================================="
  exit 1
fi
