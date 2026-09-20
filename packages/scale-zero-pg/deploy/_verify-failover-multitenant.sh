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
#   At the time of that run the pswatcher (deploy/58) promoted ONLY the base tenant
#   (PSW_TENANT_ID = compute-config.TENANT_ID) and bounced only the base writer
#   (PSW_COMPUTE_SELECTOR was app=compute; it is plane=compute now) — then flipped
#   the `pageserver` Service selector to the standby. Every OTHER tenant (the
#   `apps` tenant a0000…001 that owns every per-app timeline, and thus every
#   per-app database) is NEVER re-attached on the promoted pageserver, yet the
#   Service now routes them there. Result: stranded per-app tenants, a
#   storage-init generation wedge on re-bootstrap, per-app computes still pointed
#   at the dead pageserver, and the operator keep-alive pinned to the stale one.
#
# This drill runs against the LIVE plane (scale-zero-pg + the apps plane), forces
# a real failover, and asserts every link the incident exposed. Each assertion is
# mapped to a sprint task [T1..T6]. The chain is CAUSAL, not fully independent:
# T2/T3/T5 and T1's BASE-tenant leg attribute to their own task. Everything that
# routes THROUGH the apps tenant is DOWNSTREAM of T2 — T4, T6, and T1's apps-tenant
# leg (a stranded apps tenant NotFounds on re-attach for T2's reason, not a wedge) —
# so those are reported BLOCKED (not a failure) while T2 is red, EXCEPT T6, which
# legitimately reds with T2 because its own fix IS promote-all-tenants. So a fix
# greens its task and any downstream check it unblocks — honestly stated rather than
# claimed independent:
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
#   [T4] operator recovers, NO restart — after the flip, a BRAND-NEW AppDatabase
#                          (operator-driven) reaches phase=Ready through the promoted
#                          `pageserver` Service, operator not restarted/rescheduled
#                          (end-to-end, no timestamps). DOWNSTREAM of T2: reported
#                          BLOCKED (not a failure) while T2's apps tenant is stranded;
#                          a genuine [T4] failure needs T2 green (T4's own fix #1096
#                          is already merged).
#   [T5] death-vs-maintenance — the pswatcher must classify a genuine node-death
#                          vs a non-death (maintenance/freeze/drain) event and
#                          expose that verdict (pswatcher_failover_reason), so a
#                          non-death event does not trigger a needless failover.
#                          (The full behavioral non-death scenario is deferred with
#                          a documented reason — see the [T5] assertion block.)
#   [T6] convergence/MTTR — the Service selector + tenant states converge within a
#                          bounded budget WITHOUT a manual pswatcher-stop or
#                          selector-patch. Asserts its OWN end-state, independent of
#                          T1..T4's verdicts.
#
# ASSERTION ORDER IS LOAD-BEARING: the tenant-observation checks (T6, T2, T3) and
# the read-only T5 run BEFORE the single tenant-mutating check (T1 re-attaches
# location_config), so T1 cannot self-remediate them. T4 provisions its OWN
# probe AppDatabase (a fresh TIMELINE under the same apps tenant — the operator has a
# single APPDB_TENANT_ID) — it neither reads nor remediates the tenants the other
# checks observe — and still runs before T1. T6 is measured first and judged on
# its own end-state; reverting T1/T3 does not red it, but reverting T2 does (its
# end-state includes apps-tenant reachability) — stated, not claimed independent.
#
# RED BY CONSTRUCTION ON MAIN: on today's plane T2 strands the apps tenant, T1 wedges
# its re-attach, T3 leaves per-app computes unbounced, T5 exposes no discrimination
# verdict, and T6 never converges — each with its own [Tn] message. T4's own fix
# (#1096, the operator's non-pinning transport) is ALREADY MERGED, so [T4] is not an
# independent red here: while T2 is red it reports BLOCKED (its precondition — apps-
# tenant reachability — is unmet), and it only becomes a genuine attributable failure
# if it stays red once T2 is green. The assertion phase COLLECTS all verdicts (like
# _validate.sh) and reports every task in one run, so the fix team sees which greened.
#
# KILL MECHANISM (chosen deliberately): the primary pageserver StatefulSet is
# SCALED TO ZERO (`kubectl scale statefulset/pageserver --replicas=0`), NOT
# deleted. This is recoverable (the drill scales it back on cleanup) and avoids
# the human-gated `kubectl delete` of a durable object. The pswatcher detects the
# vanished endpoint via the pageserver-primary liveness Service and fails over on
# its own — no manual step. Because pswatcher failover is ONE-WAY, the drill first
# asserts the plane STARTS on the primary selector (fail-back required otherwise)
# and asserts the primary->standby TRANSITION, never the end state. It does NOT
# touch any maintenance-freeze signal — none exists in the plane today, and the T5
# block records that T5 must define how a drill declares an intentional kill.
# NOTE: this drill MAY call `kubectl delete` only for
# its OWN throwaway helper pods and to deprovision the objects it created; it never
# deletes a plane object. The two initial per-app tenants are provisioned with
# deploy/provision-app.sh (break-glass). The [T4] check additionally APPLIES a live
# AppDatabase CR (t4probe*) so the OPERATOR reconciles it — that is deliberate (it is
# how T4's operator-reconcile path is exercised) — and reaps it best-effort on exit.
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
#   T6_BUDGET     [T6] MTTR window in seconds, from the kill (default FAILOVER_BUDGET+CONVERGE_BUDGET)
#   PER_CHECK_BUDGET  per-check retry window (T2/T3/T4) in seconds, from when each
#                 check starts (default CONVERGE_BUDGET)
#   T7_KEEP=1     leave the provisioned apps + probe up for inspection (skip deprovision)
#   RUN_RESTART_IDEMPOTENCY=1  [T6] extra: after the failover converges, RESTART the
#                 pswatcher (rollout restart) to model an interrupted/resumed watcher,
#                 then assert it CONVERGES the plane again WITHOUT advancing the
#                 generation a second time (single-advance idempotency) and WITHOUT any
#                 manual step. Opt-in — it restarts a live controller, so the default
#                 lead run leaves it off. Bounded by RESTART_CONVERGE_BUDGET.
#   RESTART_CONVERGE_BUDGET  seconds for the post-restart re-convergence (default 120)
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
# [T6] gets its OWN convergence budget (measured from FAILOVER_AT) — the whole
# failover+converge window — so its verdict is independent of the other tasks.
T6_BUDGET="${T6_BUDGET:-$((FAILOVER_BUDGET + CONVERGE_BUDGET))}"
# [T6] owns a wall-clock deadline (FAILOVER_AT + T6_BUDGET) because it is the MTTR
# assertion. Every OTHER timed check (T2/T3/T4) instead gets its OWN budget measured
# from the moment that check STARTS (PER_CHECK_BUDGET) — NOT the shared T6 deadline,
# which T6 fully consumes whenever T6 is red. Without a per-check floor a red T6 would
# leave T2/T3/T4 a single straddle probe with zero retry, re-creating defect C ("not
# fixed" vs "too slow") on those checks: landing only the T3 fix while T6 is still red
# must still give T3 a real window to observe the bounce.
PER_CHECK_BUDGET="${PER_CHECK_BUDGET:-$CONVERGE_BUDGET}"
RUN_RESTART_IDEMPOTENCY="${RUN_RESTART_IDEMPOTENCY:-0}"
RESTART_CONVERGE_BUDGET="${RESTART_CONVERGE_BUDGET:-120}"

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
ASSERT_BLOCKED=0
t_fail() { ASSERT_FAILS=$((ASSERT_FAILS + 1)); echo "not ok - [$1] $2" >&2; }
t_ok()   { echo "ok - [$1] $2"; }
# t_blocked — a DOWNSTREAM check whose precondition (an upstream task) is unmet, so
# it is NOT independently attributable and must NOT count as a failure of its own
# task. Distinct verdict; recorded for the summary but never added to ASSERT_FAILS.
t_blocked() { ASSERT_BLOCKED=$((ASSERT_BLOCKED + 1)); echo "blocked - [$1] $2 (downstream of an unmet upstream task; NOT counted as a [$1] failure)"; }

command -v "$KUBECTL" >/dev/null 2>&1 || fail "kubectl not found"
CUR_CTX="$($KUBECTL config current-context 2>/dev/null || echo '')"
[ "$CUR_CTX" = "$KCTX" ] || fail "expected kube-context '$KCTX' (current '$CUR_CTX'; set KCTX/KSPG_CONTEXT to override)"
$K get ns "$NS" >/dev/null 2>&1 || fail "namespace $NS not found on context $KCTX"

# ---------------------------------------------------------------------------
# GATE: apps plane present? (skip cleanly only if ENTIRELY absent). ----------
HAVE_CRD=0; $KUBECTL get crd appdatabases.apps.scale-zero-pg.dev >/dev/null 2>&1 && HAVE_CRD=1
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
T4PROBE=""   # the [T4] probe AppDatabase (created later); reaped here, guarded for set -u
cleanup() {
  code=$?
  info "cleanup: restoring primary pageserver + deprovisioning drill apps"
  # scale the primary back up (recoverable kill). After a real promotion the
  # standby is authoritative; re-seeding the old primary is an operator concern —
  # this only undoes the scale so the StatefulSet is not left at 0 by the drill.
  $K scale statefulset/"$PRIMARY_STS" --replicas=1 >/dev/null 2>&1 || true
  if [ "${T7_KEEP:-0}" = "1" ]; then
    info "cleanup: T7_KEEP=1 — leaving provisioned apps [$PROVISIONED] + probe [$T4PROBE] up"
  else
    for a in $PROVISIONED; do
      KCTX="$KCTX" NS="$NS" sh "$DIR/provision-app.sh" destroy "$a" >/dev/null 2>&1 || true
    done
    # the [T4] probe is an AppDatabase CR — delete the CR and let the operator's
    # finalizer reclaim its timeline (best-effort; the drill owns this object).
    [ -n "$T4PROBE" ] && $K delete appdatabase "$T4PROBE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
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

# RETRY <tag> <dsn> <sql> — like PSQL but retries a POSITIVE connect a BOUNDED
# number of times, the SAME cold-wake handling the sibling drills use
# (_verify-perapp-ro.sh, _measure-ro-staleness.sh). A cold per-app compute wakes
# 0->1 on the FIRST connect and compute_ctl applies the per-app role during boot,
# so that first `select 1` can lose a race with the role-apply and fail transiently
# even though the compute is coming up healthy (the documented cold-boot role race,
# #132) — on a slow/ad-hoc cluster that is exactly what stranded this drill at
# SETUP. Each attempt also resets the compute idle timer, so a later attempt hits
# the fully-settled compute. A positive read retries; an ALL-attempts failure still
# returns non-zero, so the caller's fail() keeps setup a hard failure. Distinct pod
# name per attempt ($1-$_rt): a --restart=Never pod name cannot be reused.
RETRY() { # $1 tag  $2 dsn  $3 sql -> echoes last output line; rc!=0 iff EVERY try failed
  _rout=""
  for _rt in 1 2 3 4 5 6; do
    if _rout="$(PSQL "$1-$_rt" "$2" "$3" 2>/dev/null)"; then echo "$_rout"; return 0; fi
    info "  RETRY $1 attempt $_rt did not connect yet (cold wake / #132 role-apply settling) — retrying in 3s"
    sleep 3
  done
  return 1
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
SVC_GEN() { # $1 = tenant -> echoes the tenant's generation as the ROUTED pageserver
            # reports it, or '' when it is absent/unreadable. This is the same vantage
            # pswatcher converges against, so it is what proves a tenant actually
            # reached the ledger generation — reachability alone does not (#1100 review).
  _b="$($K exec sts/"$STANDBY_STS" -- curl -s --max-time 10 \
        "http://$PS_SVC:9898/v1/tenant/$1" 2>/dev/null || echo '')"
  printf '%s' "$_b" | tr ',{}' '\n' | grep '"generation"' | head -1 \
    | sed -E 's/.*"generation"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/'
}
SVC_PUT() { # $1 = path  $2 = json body -> echoes the response body, then a FINAL
            # line carrying the HTTP status code (000 on transport/exec failure).
            # Never swallow the status: an unreachable pageserver, a failed exec,
            # or a 404 NotFound body must be visible to the caller, not fall
            # through as "success" (defect #2).
  $K exec sts/"$STANDBY_STS" -- curl -s -w '\n%{http_code}' --max-time 15 -X PUT \
    -H 'Content-Type: application/json' -d "$2" "http://$PS_SVC:9898$1" 2>/dev/null \
    || printf '\n000'
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
# compute scales 0->1 (Active). A wake failure here is a setup failure. The FIRST
# connection after a cold start races the wake (0->1 scale, page fetch) and the
# per-app role apply (the #132 cold-boot role race). RETRY absorbs that race the
# same bounded way the sibling drills do (_verify-perapp-ro.sh wakes each app's
# writer with RETRY for exactly this reason); an all-attempts failure is still a
# hard setup failure.
for a in $T7_APPS; do
  APPPW="$($K get secret "app-db-$a" -o jsonpath='{.data.PGPASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || echo '')"
  [ -n "$APPPW" ] || fail "no app-db-$a Secret (PGPASSWORD) minted by provision-app — cannot wake app '$a'"
  DSN="postgres://app_$a:$APPPW@$APPS_GW:55432/$a?sslmode=disable"
  [ "$(RETRY "wake-$a" "$DSN" 'select 1' 2>/dev/null)" = "1" ] \
    || fail "could not wake per-app compute for '$a' through $APPS_GW after 6 bounded retries — the app is not Active (cold-wake role-apply race did not settle), so a failover assertion would be meaningless"
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
# Guard against label drift (defect F): with the base + two woken per-app writers
# there MUST be pods here. An empty snapshot would make [T3] vacuously green (no
# survivors because none were ever recorded), so treat it as a setup failure.
[ -n "$PRE_PODS" ] || fail "no compute pods matched plane=compute / compute-ro / compute-warm before the kill — the labels this drill snapshots have drifted; [T3] would be vacuously green. Fix the selectors before trusting the drill."
# --field-selector=status.phase=Running on EVERY operator-pod read (MED): without it
# kubectl returns items in NAME order, so a single lingering Evicted/Failed operator
# pod object that sorts first would be read at both capture points -> uid+restartCount
# always equal -> the restart/reschedule guard could NEVER go red (decoration) while
# the live operator actually restarted. The phase filter reads ONLY the live pod.
OP_RESTARTS_BEFORE="$($K get pods -l app="$OPERATOR" --field-selector=status.phase=Running -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' 2>/dev/null || echo 0)"
[ -n "$OP_RESTARTS_BEFORE" ] || OP_RESTARTS_BEFORE=0
# Capture the operator POD IDENTITY too (LOW): comparing restartCount alone false-REDs
# [T4] if the single operator pod is RESCHEDULED (a new pod reports restartCount 0 vs
# BEFORE=N). [T4] compares uid to tell an in-place restart from a pod replacement.
OP_UID_BEFORE="$($K get pods -l app="$OPERATOR" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.uid}' 2>/dev/null || echo '')"
# An empty baseline uid (no Running operator pod pre-kill) must be a hard setup
# failure, NOT silently tolerated — otherwise the [T4] uid comparison is disabled
# for the whole run and a post-recovery restart/reschedule goes unseen. "No operator
# pod running" is a real failure, never a pass.
[ -n "$OP_UID_BEFORE" ] || fail "no Running $OPERATOR pod before the kill — cannot baseline the operator for the [T4] restart/reschedule guard; the apps-plane operator is not healthy"
info "pre-failover: $(echo "$PRE_PODS" | grep -c . ) compute pod(s), operator restartCount=$OP_RESTARTS_BEFORE (pod uid ${OP_UID_BEFORE})"

# ---------------------------------------------------------------------------
info "STEP 2: KILL the primary pageserver — pswatcher must fail over"
# Snapshot the selector BEFORE the kill. pswatcher failover is ONE-WAY (watcher.go
# never flips back), and this drill's cleanup only scales the STS, never restores
# the selector — so a plane that already failed over sits on the standby selector
# as its steady state. Reading the selector only AFTER the kill would break the
# flip-wait on iteration 0 and FALSELY report "failover fired" while exercising
# ZERO failover (defect #1: on the already-failed-over GKE plane it would print
# DRILL PASSED without any failover). Require the plane to START on the primary
# selector, and assert the primary->standby TRANSITION, not the end state.
PRE_SEL="$($K get svc "$PS_SVC" -o jsonpath='{.spec.selector.app}' 2>/dev/null || echo '?')"
case "$PRE_SEL" in
  ""|"?")
    fail "could not read the $PS_SVC Service selector (.spec.selector.app is empty/unreadable, got '${PRE_SEL}') — the Service selector shape is unexpected; cannot establish the pre-failover baseline. This is an INFRA error, NOT 'already failed over' (defect G)." ;;
  "$STANDBY_STS")
    fail "the $PS_SVC Service selector is already '$PRE_SEL' (the standby) — the plane is ALREADY failed over (pswatcher failover is one-way). Fail back first (re-seed $PRIMARY_STS as primary + flip the selector) before running this drill; otherwise it would exercise no failover and lie." ;;
  "$PRIMARY_STS")
    : ;; # expected pre-failover baseline
  *)
    fail "the $PS_SVC Service selector is '$PRE_SEL' — neither the primary '$PRIMARY_STS' nor the standby '$STANDBY_STS'. Unexpected topology; refusing to run rather than misattribute the state." ;;
esac

# NOTE (T5): a genuine node-death vs a maintenance/freeze event must be
# distinguished by the pswatcher ITSELF (task T5). This drill deliberately does NOT
# pre-clear any maintenance-freeze signal: no such signal exists in the plane today
# (defect D — clearing a non-existent object is dead code, and deleting a LIVE one
# the moment T5 ships would defeat the mechanism under test and violate this drill's
# "never mutate a plane object" stance). When T5 lands it must define how a drill
# declares an intentional kill (e.g. a drill-scoped opt-out) and update this step.
info "  killing primary via scale $PRIMARY_STS -> 0 (recoverable; avoids human-gated delete of a durable object; keeps it down long enough to cross the fail threshold)"
FAILOVER_AT="$(date +%s)"
$K scale statefulset/"$PRIMARY_STS" --replicas=0 >/dev/null 2>&1 \
  || fail "could not scale $PRIMARY_STS to 0 (kill step)"
# Assert the TRANSITION: the selector must be observed to LEAVE the primary and
# LAND on the standby within the budget.
SEL="$PRE_SEL"; w=0
while [ "$w" -lt "$FAILOVER_BUDGET" ]; do
  SEL="$($K get svc "$PS_SVC" -o jsonpath='{.spec.selector.app}' 2>/dev/null || echo '?')"
  [ "$SEL" = "$STANDBY_STS" ] && break
  w=$((w + 1)); sleep 1
done
if [ "$SEL" = "$STANDBY_STS" ]; then
  ok "pswatcher flipped the $PS_SVC Service selector $PRIMARY_STS -> $STANDBY_STS (failover TRANSITION observed, not a pre-existing state)"
else
  # The failover machinery itself did not act — every downstream [Tn] would be
  # attributed wrongly. This is a setup-level failure, not a task assertion.
  fail "pswatcher did NOT flip the $PS_SVC Service $PRIMARY_STS -> $STANDBY_STS within ${FAILOVER_BUDGET}s (selector=$SEL) — the base-tenant failover never fired, so the multi-tenant assertions cannot be attributed"
fi

CUR_GEN="$($K get configmap "$GEN_CM" -o jsonpath='{.data.generation}' 2>/dev/null || echo '')"
[ -n "$CUR_GEN" ] || CUR_GEN=1
info "post-flip generation ledger = $CUR_GEN"

# now() is wall-clock epoch seconds. [T6] uses the DEADLINE below (its MTTR window,
# measured from the kill so flip-wait + kubectl round-trip latency count against it).
# Every other timed check computes its OWN start-relative deadline off PER_CHECK_BUDGET.
# No timestamp/clock comparison is done anywhere in this drill (the round-3 host-vs-pod
# clock-skew hazard is gone — [T4] now uses an end-to-end provisioning signal).
now() { date +%s; }
DEADLINE=$(( FAILOVER_AT + T6_BUDGET ))

# ===========================================================================
# ASSERTION PHASE (collect-all). Each [Tn] fails for its OWN reason on main.
# ORDERING IS LOAD-BEARING (defect #3): the tenant-observation checks (T6, T2, T3)
# and read-only T5 run BEFORE the one tenant-mutating check (T1 re-attaches
# location_config). T4 provisions a fresh TIMELINE under the apps tenant (the
# operator has a single APPDB_TENANT_ID) — it does not touch the tenants the other
# checks observe — and also runs before T1. T1 runs LAST so its PUT cannot
# self-remediate the others or contradict T6's "no manual intervention".
# ===========================================================================
echo ""
info "ASSERTIONS (each maps to a sprint task; red-by-construction on main; observation-only checks run BEFORE the single mutating check so none can remediate another)"

# --- [T6] convergence/MTTR (measured FIRST) ---------------------------------
# Asserts its OWN end-state condition — the Service selector on the standby AND
# both the base and apps tenants reachable through the Service — bounded by its own
# T6_BUDGET measured from FAILOVER_AT. It is not gated on the OTHER tasks' pass/fail
# verdicts, so reverting T1/T3 does not blanket-red it. It DOES depend on apps-tenant
# reachability, so reverting T2 reds T6 too — this is legitimate and stated, not a
# false coupling: T6's own fix IS promote-all-tenants, the same fix T2 asserts. T6
# reds when the plane fails to reach a correct multi-tenant end-state within budget
# without manual intervention (the drill issues no pswatcher-stop / selector-patch).
t6_converged() {
  _sel="$($K get svc "$PS_SVC" -o jsonpath='{.spec.selector.app}' 2>/dev/null || echo '?')"
  [ "$_sel" = "$STANDBY_STS" ] || return 1
  [ "$(SVC_CODE "/v1/tenant/$BASE_TENANT")" = "200" ] || return 1
  [ "$(SVC_CODE "/v1/tenant/$APPS_TENANT")" = "200" ] || return 1
  return 0
}
# Drive the loop off the REAL wall-clock DEADLINE (defect A): the old sleep-only
# counter ignored the ~3 kubectl round-trips per iteration, so wall time from
# FAILOVER_AT could reach 2x+ T6_BUDGET while still printing "in 420s (<= 300s)".
# Probe first (at least once even if the flip-wait ran the clock near the deadline),
# then check the deadline. T6 IS the MTTR assertion: it must fail when convergence
# is too slow, so t_ok is additionally GATED on T6_MTTR <= T6_BUDGET.
T6_MTTR=""
while : ; do
  if t6_converged; then T6_MTTR=$(( $(now) - FAILOVER_AT )); break; fi
  [ "$(now)" -ge "$DEADLINE" ] && break
  sleep 5
done
# One FINAL probe AFTER the deadline break (minor): a convergence that lands late
# must report TOO SLOW (T6_MTTR set, > budget), not NO CONVERGENCE.
if [ -z "$T6_MTTR" ] && t6_converged; then T6_MTTR=$(( $(now) - FAILOVER_AT )); fi
if [ -n "$T6_MTTR" ] && [ "$T6_MTTR" -le "$T6_BUDGET" ]; then
  t_ok T6 "multi-tenant plane converged to a CORRECT end-state (selector=$STANDBY_STS + base AND apps tenants reachable via the $PS_SVC Service) in ${T6_MTTR}s (<= ${T6_BUDGET}s MTTR budget), with NO manual pswatcher-stop / selector-patch (the drill issued neither)"
elif [ -n "$T6_MTTR" ]; then
  t_fail T6 "CONVERGENCE TOO SLOW: the plane reached the correct end-state only after ${T6_MTTR}s, past the ${T6_BUDGET}s MTTR budget — a bounded-MTTR failover is the requirement, so an over-budget convergence FAILS T6. Fix: cut the multi-tenant failover MTTR under budget"
else
  t_fail T6 "NO AUTONOMOUS CONVERGENCE: the plane did not reach a correct multi-tenant end-state within ${T6_BUDGET}s without manual intervention — the apps tenant stays stranded on the promoted pageserver behind the flipped Service. Fix: promote every tenant so the failover converges on its own"
fi

# --- [T2] no split-brain: EVERY tenant attached on the promoted pageserver AND
#     reachable through the `pageserver` Service. Each call gets its OWN
#     PER_CHECK_BUDGET window from when it starts (defect C), probe-first. ---------
tenant_reachable_via_svc() { # $1 tenant -> rc 0 iff GET /v1/tenant/<T> == 200 within PER_CHECK_BUDGET
  _t="$1"; _cdl=$(( $(now) + PER_CHECK_BUDGET ))
  while : ; do
    [ "$(SVC_CODE "/v1/tenant/$_t")" = "200" ] && return 0
    [ "$(now)" -ge "$_cdl" ] && return 1
    sleep 3
  done
}
if tenant_reachable_via_svc "$BASE_TENANT"; then
  t_ok T2 "base tenant $BASE_TENANT attached + reachable through the $PS_SVC Service after failover"
else
  t_fail T2 "base tenant $BASE_TENANT is NOT reachable through the $PS_SVC Service after failover (GET /v1/tenant returned != 200) — the promoted pageserver is not serving it"
fi
# The apps tenant owns every per-app timeline. On main the pswatcher only promotes
# the base tenant, so the apps tenant is unattached on the promoted pageserver
# while the Service routes to it — the split-brain. This is the load-bearing check.
# T2_APPS_OK is the apps-tenant reachability verdict — the load-bearing split-brain
# signal AND the precondition the downstream [T4]/[T6] checks gate on (the operator
# reconciles per-app tenants THROUGH this apps tenant, so a new app cannot go Ready
# while the apps tenant is stranded, regardless of the operator's transport).
T2_APPS_OK=0
if tenant_reachable_via_svc "$APPS_TENANT"; then
  T2_APPS_OK=1
  t_ok T2 "apps tenant $APPS_TENANT attached + reachable through the $PS_SVC Service (no split-brain)"
else
  t_fail T2 "SPLIT-BRAIN: apps tenant $APPS_TENANT is NOT attached/reachable through the $PS_SVC Service after failover — the pswatcher promoted only the base tenant, so every per-app database is stranded. Fix: promote ALL tenants, not just PSW_TENANT_ID"
fi
# each per-app timeline must be reachable under the (attached) apps tenant — with the
# SAME start-relative PER_CHECK_BUDGET retry as the tenant checks, so a tail-of-window
# reachability does not false-RED T2 on timing (MED).
timeline_reachable_via_svc() { # $1 tenant  $2 timeline -> rc 0 iff GET .../timeline/<TL> == 200 within budget
  _t="$1"; _tl="$2"; _cdl=$(( $(now) + PER_CHECK_BUDGET ))
  while : ; do
    [ "$(SVC_CODE "/v1/tenant/$_t/timeline/$_tl")" = "200" ] && return 0
    [ "$(now)" -ge "$_cdl" ] && return 1
    sleep 3
  done
}
for a in $T7_APPS; do
  TL="$($K get configmap "compute-config-$a" -o jsonpath='{.data.TIMELINE_ID}' 2>/dev/null || echo '')"
  if [ -n "$TL" ] && timeline_reachable_via_svc "$APPS_TENANT" "$TL"; then
    t_ok T2 "per-app tenant '$a' (timeline $TL) reachable through the $PS_SVC Service"
  else
    t_fail T2 "per-app tenant '$a' (timeline ${TL:-?}) is NOT reachable through the $PS_SVC Service after failover — stranded because its apps tenant was not promoted"
  fi
done

# --- [T3] computes bounced: no pre-failover compute pod survives. Before the
#     plane=compute selector shipped the pswatcher bounced only app=compute (base),
#     so every per-app writer pod (and any RO/warm) that predated the failover was
#     still there; the bounce now targets every compute. --------------------------
survivors_check() {
  _cdl=$(( $(now) + PER_CHECK_BUDGET ))
  while : ; do
    _now="$(snapshot_compute_pods)"
    _surv=""
    for p in $PRE_PODS; do
      echo "$_now" | grep -qx "$p" && _surv="$_surv $p"
    done
    [ -z "$_surv" ] && { echo ""; return 0; }
    [ "$(now)" -ge "$_cdl" ] && { echo "$_surv"; return 1; }
    sleep 5
  done
}
SURV="$(survivors_check)"
if [ -z "$SURV" ]; then
  t_ok T3 "all pre-failover compute pods were bounced (base + per-app writers + RO)"
else
  t_fail T3 "UNBOUNCED COMPUTES: these compute pods predate the failover and survived:${SURV} — the pswatcher bounce (PSW_COMPUTE_SELECTOR, plane=compute) did not reach them, so they are still pointed at the dead pageserver. Check PSW_COMPUTE_SELECTOR is plane=compute and that every compute stamps plane: compute on its POD TEMPLATE"
fi

# --- [T4] operator recovers with NO restart — DOWNSTREAM E2E CONFIRMATION of T2 ---
# Round-5 reframe. T4 (#1096) is ALREADY MERGED: the operator uses a non-pinning
# per-request pageserver client that follows the Service flip via DNS. So the probe
# below is NOT a transport-pinning test — it is a downstream END-TO-END confirmation
# that the operator can reconcile a NEW per-app tenant post-failover. Because the
# operator reconciles per-app tenants THROUGH the apps tenant, this probe CANNOT go
# green while T2's apps-tenant reachability is RED — it is causally downstream of T2,
# not independently greenable. Therefore:
#   * T2 apps RED  -> [T4] is BLOCKED / not-attributable (t_blocked, NOT a failure):
#                     the split-brain is T2's to fix; blaming T4 would misattribute.
#   * T2 apps GREEN -> run the probe for real: provision a BRAND-NEW AppDatabase
#                     (operator-driven CR, not the break-glass provision-app path) and
#                     require the OPERATOR to drive it to phase==Ready with NO restart.
#                     A genuine failure HERE (T2 green) means the operator regressed
#                     its non-pinning transport (#1096) or cannot reconcile for another
#                     reason. The probe CR is reaped in cleanup().
# The design is round-4's end-to-end signal (no timestamps — the round-3
# condition-lastTransitionTime check was wrong both ways: k8s stamps it only on a
# value flip, so a seamless recovery wrote none, and max() over conditions false-GREENed
# on the kill-time CondColdRestorable->Unknown; host-vs-pod clock skew made it fragile).
if [ "$T2_APPS_OK" != 1 ]; then
  t_blocked T4 "operator reconcile-through-Service is a downstream confirmation of T2, and T2's apps-tenant reachability is RED — a new app cannot reconcile while the apps tenant is stranded on the promoted pageserver. Not attributable to T4 (its non-pinning transport, #1096, is already in main); this greens once T2 (promote-all-tenants) lands"
else
  T4PROBE="t4probe$(date +%H%M%S)"
  T4_APPLIED=0
  $K apply -f - >/dev/null 2>&1 <<YAML && T4_APPLIED=1
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata: { name: $T4PROBE, namespace: $NS }
spec: { appName: $T4PROBE, tier: cold }
YAML
  t4_probe_ready() { # rc 0 iff the probe AppDatabase reaches phase==Ready within PER_CHECK_BUDGET
    _cdl=$(( $(now) + PER_CHECK_BUDGET ))
    while : ; do
      _ph="$($K get appdatabase "$T4PROBE" -o jsonpath='{.status.phase}' 2>/dev/null || echo '')"
      [ "$_ph" = "Ready" ] && return 0
      [ "$(now)" -ge "$_cdl" ] && return 1
      sleep 5
    done
  }
  if [ "$T4_APPLIED" != 1 ]; then
    t_fail T4 "could not create the [T4] probe AppDatabase '$T4PROBE' — cannot exercise the operator's reconcile path"
  else
    T4_READY=1; t4_probe_ready || T4_READY=0
    # Re-read restartCount AND pod identity AFTER the wait: a restart DURING recovery,
    # or a pod RESCHEDULE, must be visible and must be told apart (LOW).
    OP_RESTARTS_AFTER="$($K get pods -l app="$OPERATOR" --field-selector=status.phase=Running -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' 2>/dev/null || echo 0)"
    [ -n "$OP_RESTARTS_AFTER" ] || OP_RESTARTS_AFTER=0
    OP_UID_AFTER="$($K get pods -l app="$OPERATOR" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.uid}' 2>/dev/null || echo '')"
    _restart_ok=1; _restart_why=""
    # An EMPTY post-recovery uid = NO Running operator pod (replicas:1 + Recreate can
    # leave zero Running pods mid-reschedule). That is a real failure, NOT "same pod":
    # check it FIRST, before the uid-equality and restartCount branches (which would
    # both be silently skipped by an empty/0 value and wrongly report clean recovery).
    if [ -z "$OP_UID_AFTER" ]; then
      _restart_ok=0; _restart_why="no Running $OPERATOR pod at the post-recovery read (operator is down / mid-reschedule)"
    elif [ "$OP_UID_AFTER" != "$OP_UID_BEFORE" ]; then
      _restart_ok=0; _restart_why="operator pod was RESCHEDULED/replaced during recovery (uid $OP_UID_BEFORE -> $OP_UID_AFTER)"
    elif [ "$OP_RESTARTS_AFTER" != "$OP_RESTARTS_BEFORE" ]; then
      _restart_ok=0; _restart_why="operator restarted IN PLACE (restartCount $OP_RESTARTS_BEFORE -> $OP_RESTARTS_AFTER)"
    fi
    if [ "$T4_READY" = 1 ] && [ "$_restart_ok" = 1 ]; then
      t_ok T4 "$OPERATOR drove a NEW AppDatabase ('$T4PROBE') to phase=Ready through the promoted $PS_SVC Service, no restart/reschedule (restartCount $OP_RESTARTS_AFTER, same pod)"
    else
      _why=""
      [ "$T4_READY" != 1 ] && _why="the new probe app '$T4PROBE' never reached phase=Ready within ${PER_CHECK_BUDGET}s even though the apps tenant IS reachable (T2 green)"
      [ "$_restart_ok" != 1 ] && _why="${_why:+$_why; }$_restart_why"
      t_fail T4 "OPERATOR DID NOT RECOVER CLEANLY (T2 is green, so this IS attributable to the operator): $_why — the operator regressed its non-pinning per-request pageserver transport (#1096) or cannot reconcile a new tenant post-failover for another reason. Fix belongs in the operator, not the pswatcher"
    fi
  fi
fi

# --- [T5] death-vs-maintenance discrimination ------------------------------
# T5 teaches the pswatcher to tell a genuine node-death from a NON-death event
# (maintenance / freeze / graceful drain) and to fail over only on the former.
#
# DEFERRAL (documented, defect #4): a full behavioral non-death scenario — inject
# a non-fatal degradation and assert NO failover — is NOT feasible as a second
# in-run cycle here, for two independent reasons: (1) pswatcher failover is
# ONE-WAY and this is a single live standby, so a second cycle cannot run without
# a fail-back mechanism that T5 itself would introduce; and (2) today's watcher is
# a naive liveness probe, so a "process-up but dependency-degraded" stimulus does
# NOT trip it — that scenario would GREEN on main, i.e. it is not red-by-
# construction. So the attributable proxy asserted here is the discrimination
# VERDICT the fix must expose: after a genuine node-death failover the watcher must
# publish a death-classification signal (pswatcher_failover_reason) on its metrics.
# On main no such signal exists -> [T5] red; it greens when T5 adds discrimination.
# The FULL behavioral non-death + freeze scenarios (assert NO failover fires) live in
# the sibling drill deploy/_verify-failover-freeze.sh, which never kills the plane and
# so can assert the suppression paths without a fail-back — see that script's header.
PSW_IP="$($K get pod -l app=pswatcher -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || echo '')"
T5_MET=""
if [ -n "$PSW_IP" ]; then
  T5_MET="$($K exec sts/"$STANDBY_STS" -- curl -s --max-time 10 "http://$PSW_IP:9091/metrics" 2>/dev/null || echo '')"
fi
# Require a REAL labeled SAMPLE, not mere name presence (defect E): a `# HELP` line
# or a registered-but-zero counter must NOT satisfy this. Match a metric line (not a
# comment) named pswatcher_failover_reason, carrying a non-empty reason="..." label,
# whose sample value is > 0 — i.e. the watcher actually CLASSIFIED this failover.
if printf '%s\n' "$T5_MET" | awk '
    /^[[:space:]]*#/ { next }
    /^pswatcher_failover_reason\{/ && /reason="[^"]+"/ { if ($NF+0 > 0) { found=1 } }
    END { exit found?0:1 }'; then
  t_ok T5 "pswatcher published a death-vs-maintenance classification for this failover (pswatcher_failover_reason{reason=...} > 0) — a non-death event can be distinguished and skipped"
else
  t_fail T5 "NO DEATH DISCRIMINATION: pswatcher published no classified failover-reason sample (pswatcher_failover_reason{reason=\"...\"} > 0 absent), so it fails over on ANY primary unreachability — a maintenance freeze or graceful drain would trigger a needless multi-tenant failover. Fix: classify node-death vs non-death and expose pswatcher_failover_reason. (Full behavioral non-death scenario deferred — see the [T5] block comment for why.)"
fi

# --- [T1] no gen-wedge (MUTATING — RUN LAST) --------------------------------
# Re-attaching a tenant at the CURRENT ledger generation must SUCCEED. On main the
# re-bootstrap/attach hits "Generation N is less than existing M" because the
# storage-init/operator attach path does not track the failover-advanced
# generation. This is the ONLY mutating check; it runs after every observation
# above so its location_config PUT cannot self-remediate T4/T6 (defect #3). The
# PUT's HTTP status is captured (defect #2): a non-2xx / unreachable / NotFound
# response is the wedge/stranded symptom, never "no wedge".
gen_wedge_check() { # $1 tenant -> rc 0 iff attach at $CUR_GEN returns 2xx AND no wedge/NotFound body
  _t="$1"
  _full="$(SVC_PUT "/v1/tenant/$_t/location_config" \
      "{\"mode\":\"AttachedSingle\",\"generation\":$CUR_GEN,\"tenant_conf\":{}}")"
  _code="$(printf '%s\n' "$_full" | tail -1)"
  _body="$(printf '%s\n' "$_full" | sed '$d')"
  case "$_code" in
    2[0-9][0-9]) : ;;
    *) GENWEDGE_WHY="attach returned HTTP '${_code:-<none>}' (unreachable/stranded on the promoted pageserver); body='${_body}'"; return 1 ;;
  esac
  # The HTTP-status gate above already fails every non-2xx (i.e. every genuine
  # pageserver error) response, so this body scan is narrowed to the two wedge
  # shapes that can ride on a 2xx or an error envelope — NOT a broad *Error*
  # substring, which false-RED on a success body containing e.g. "error_count"
  # (defect H).
  case "$_body" in
    *"less than existing"*|*[Gg]eneration*less*) GENWEDGE_WHY="pageserver REJECTED the attach (generation wedge): ${_body}"; return 1 ;;
    *NotFound*|*"not found"*) GENWEDGE_WHY="tenant not attached on the promoted pageserver (NotFound): ${_body}"; return 1 ;;
    *) return 0 ;;
  esac
}
for TEN in "$BASE_TENANT" "$APPS_TENANT"; do
  _label="base"; [ "$TEN" = "$APPS_TENANT" ] && _label="apps"
  # The APPS leg is DOWNSTREAM of T2 (same class as the [T4] gating): while the apps
  # tenant is stranded, its re-attach 404s as a NotFound — that is T2's split-brain
  # symptom, not a generation wedge, so blaming [T1] would misattribute and landing
  # T1's fix alone would not green it. Gate the apps leg on T2_APPS_OK; the BASE leg
  # stays fully attributable to T1.
  if [ "$_label" = "apps" ] && [ "$T2_APPS_OK" != 1 ]; then
    t_blocked T1 "the apps-tenant re-attach is downstream of T2 — while the apps tenant is stranded (T2 red) its attach NotFounds for T2's reason, not a generation wedge; this becomes an attributable [T1] check once T2 is green"
    continue
  fi
  GENWEDGE_WHY=""
  if gen_wedge_check "$TEN"; then
    t_ok T1 "re-attach of $_label tenant $TEN at ledger generation $CUR_GEN SUCCEEDS (no gen-wedge)"
  else
    t_fail T1 "GEN-WEDGE: re-attaching $_label tenant $TEN at ledger generation $CUR_GEN did NOT cleanly succeed — $GENWEDGE_WHY. The bootstrap/attach path does not honor the failover-advanced generation. Fix: attach at the current ledger generation, not a hardcoded 1"
  fi
done

# --- [T6] restart-idempotency (OPT-IN) --------------------------------------
# Model an INTERRUPTED-then-resumed watcher and make the assertion able to FAIL on its
# own subject (#1100 review, FIX 4). The earlier shape restarted pswatcher on an
# ALREADY-converged plane and then waited for `t6_converged` — which was already true
# and stayed true even if convergeFailover were deleted entirely: decorative. So this
# block now STRANDS the plane first, with the watcher stopped so it cannot heal the
# strand before the restart:
#   1. scale pswatcher to 0 (the "killed mid-failover" state);
#   2. advance the LEDGER one generation without attaching anything — exactly the
#      interrupted-failover shape: the ledger committed, the tenants did not follow;
#   3. PROVE the strand is real (a routed tenant observed BELOW the new ledger gen),
#      else the check cannot assert anything and says so;
#   4. start pswatcher and require it to RE-CONVERGE: selector on the standby AND both
#      tenants reachable AND both AT the ledger generation (reachability alone is what
#      made the old predicate unfalsifiable);
#   5. and to do it WITHOUT advancing the ledger again (single-writer / no double
#      advance — the invariant a converge loop must never break).
# Opt-in (it stops a live controller and moves the ledger).
if [ "$RUN_RESTART_IDEMPOTENCY" = "1" ]; then
  echo ""
  info "[T6] restart-idempotency: stopping pswatcher, STRANDING the plane one generation behind the ledger, then restarting and asserting RE-convergence with NO second generation advance"
  GEN_BEFORE_RESTART="$($K get configmap "$GEN_CM" -o jsonpath='{.data.generation}' 2>/dev/null || echo '')"
  [ -n "$GEN_BEFORE_RESTART" ] || GEN_BEFORE_RESTART="$CUR_GEN"
  STRANDED_GEN=$((GEN_BEFORE_RESTART + 1))
  # t6_reconverged is t6_converged PLUS the generation check the old predicate lacked:
  # a tenant that answers 200 while sitting at the OLD generation is precisely the
  # stranded state this drill exists to detect.
  t6_reconverged() {
    t6_converged || return 1
    for _t in "$BASE_TENANT" "$APPS_TENANT"; do
      _g="$(SVC_GEN "$_t")"
      [ -n "$_g" ] || return 1
      [ "$_g" -ge "$STRANDED_GEN" ] || return 1
    done
    return 0
  }
  if ! $K scale deploy/pswatcher --replicas=0 >/dev/null 2>&1 \
     || ! $K rollout status deploy/pswatcher --timeout=60s >/dev/null 2>&1; then
    t_fail T6 "could not stop pswatcher (scale to 0) — cannot create the interrupted-watcher precondition, so restart-idempotency is unasserted"
  elif ! $K patch configmap "$GEN_CM" --type merge \
        -p "{\"data\":{\"generation\":\"$STRANDED_GEN\"}}" >/dev/null 2>&1; then
    $K scale deploy/pswatcher --replicas=1 >/dev/null 2>&1 || true
    t_fail T6 "could not advance the ledger ConfigMap $GEN_CM to $STRANDED_GEN — cannot STRAND the plane, so restart-idempotency is unasserted"
  else
    # (3) prove the strand: at least one routed tenant must actually be BELOW the
    # ledger now, or a green result below would prove nothing.
    STRAND_OK=0
    for _t in "$BASE_TENANT" "$APPS_TENANT"; do
      _g="$(SVC_GEN "$_t")"
      [ -n "$_g" ] && [ "$_g" -lt "$STRANDED_GEN" ] && STRAND_OK=1
    done
    if [ "$STRAND_OK" != 1 ]; then
      $K scale deploy/pswatcher --replicas=1 >/dev/null 2>&1 || true
      t_fail T6 "could not OBSERVE a stranded tenant after advancing the ledger to $STRANDED_GEN (the routed vantage reports every tenant at or above it) — the restart-idempotency check would have been unfalsifiable, so it is reported as unasserted rather than passed"
    elif $K scale deploy/pswatcher --replicas=1 >/dev/null 2>&1 \
         && $K rollout status deploy/pswatcher --timeout="${RESTART_CONVERGE_BUDGET}s" >/dev/null 2>&1; then
      _rdl=$(( $(date +%s) + RESTART_CONVERGE_BUDGET )); RECONVERGED=0
      while : ; do
        t6_reconverged && { RECONVERGED=1; break; }
        [ "$(date +%s)" -ge "$_rdl" ] && break
        sleep 5
      done
      GEN_AFTER_RESTART="$($K get configmap "$GEN_CM" -o jsonpath='{.data.generation}' 2>/dev/null || echo '')"
      if [ "$RECONVERGED" != 1 ]; then
        t_fail T6 "RESTART DID NOT RE-CONVERGE A STRANDED PLANE: with the ledger at $STRANDED_GEN and a routed tenant left behind at $GEN_BEFORE_RESTART, a resumed pswatcher did not re-attach every routed tenant at the ledger generation within ${RESTART_CONVERGE_BUDGET}s (base=$(SVC_GEN "$BASE_TENANT") apps=$(SVC_GEN "$APPS_TENANT")). Fix: make the adopt path CONVERGE (re-attach lagging routed tenants at the ledger generation), not just latch and bounce"
      elif [ "$GEN_AFTER_RESTART" != "$STRANDED_GEN" ]; then
        t_fail T6 "DOUBLE GENERATION ADVANCE: the ledger went $STRANDED_GEN -> $GEN_AFTER_RESTART while a restarted watcher converged a stranded plane (no new failover occurred) — converge must re-promote at the SAME generation, never advance the ledger. Fix: generation-guard the converge/adopt path"
      else
        t_ok T6 "restart-idempotency: with pswatcher stopped the ledger was advanced to $STRANDED_GEN, stranding a routed tenant at $GEN_BEFORE_RESTART; the restarted watcher RE-CONVERGED the plane with NO manual step (selector=$STANDBY_STS, base AND apps reachable AND at generation $STRANDED_GEN) and left the ledger UNCHANGED at $GEN_AFTER_RESTART (single advance, no second writer)"
      fi
    else
      t_fail T6 "could not restart pswatcher (scale to 1 / rollout status failed) after stranding the plane — the plane is left at ledger $STRANDED_GEN with a lagging tenant; restart the watcher and re-run"
    fi
  fi
fi

# ---------------------------------------------------------------------------
CONVERGED_AT="$(date +%s)"
# elapsed from the KILL (includes the flip-wait + every check), not just the
# assertion phase — labelled accordingly below.
ELAPSED=$((CONVERGED_AT - FAILOVER_AT))
echo ""
echo "=========================================================================="
if [ "$ASSERT_FAILS" -eq 0 ]; then
  echo " MULTI-TENANT FAILOVER DRILL PASSED — every tenant survived the flip"
  echo "   MTTR (kill -> converged): ${T6_MTTR:-n/a}s; ${ASSERT_BLOCKED} downstream check(s) BLOCKED (precondition unmet)"
  echo "=========================================================================="
  exit 0
else
  echo " MULTI-TENANT FAILOVER DRILL FAILED — $ASSERT_FAILS task assertion(s) unmet; ${ASSERT_BLOCKED} downstream check(s) BLOCKED (not counted)"
  echo "   (red-by-construction on main; the causal chain is documented — T4/T6 are"
  echo "    downstream of T2). T6 budget ${T6_BUDGET}s; total kill->end elapsed ${ELAPSED}s."
  echo "=========================================================================="
  exit 1
fi
