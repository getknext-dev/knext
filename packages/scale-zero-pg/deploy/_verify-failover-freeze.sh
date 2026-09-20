#!/usr/bin/env bash
# _verify-failover-freeze.sh — LIVE drill for the T5 failover-trigger contract (#1099):
# the pswatcher must (1) DISCRIMINATE a recoverable dependency degradation from a
# genuine node/process death, and (2) honor a TTL-bounded MAINTENANCE FREEZE.
#
# WHY A SIBLING (not folded into _verify-failover-multitenant.sh): that drill fires ONE
# real, one-way failover and asserts the post-failover plane. The two scenarios here are
# the OPPOSITE — they must assert that NO failover fires — so running them in the same
# pass as a real kill is impossible (the plane has already flipped, one-way). This drill
# therefore never kills the pageserver; it only exercises the SUPPRESSION paths.
#
# Scenarios:
#   [FZ1] FREEZE gauge — with no freeze set, pswatcher_failover_frozen == 0. Create the
#         pageserver-failover-freeze ConfigMap (until = now+10m); within a couple polls
#         pswatcher_failover_frozen == 1 and pswatcher_failover_freeze_expiry_seconds
#         matches. Delete it; the gauge returns to 0. (Creates + deletes a NEW object;
#         never mutates a live plane object.)
#   [FZ2] FREEZE suppresses a real death — OPT-IN (RUN_KILL=1), because it consumes the
#         standby. With a freeze active, kill the primary pageserver and assert the
#         client `pageserver` Service selector does NOT flip for the hold window and
#         pswatcher_failover_freeze_suppressed_total rises. Deferred by default.
#   [FZ3] NATURAL TTL EXPIRY — set a freeze with a ~20s `until` and poll until
#         pswatcher_failover_frozen returns to 0 WITHOUT deleting the ConfigMap. FZ1
#         only proves deletion clears the gauge; this proves a FORGOTTEN freeze lapses
#         on its own, which is the actual safety argument.
#   [DG1] DEPENDENCY DEGRADATION — OPT-IN (RUN_DEGRADE=1), reversible: degrade the
#         object store (scale MinIO to 0 on a MinIO-backed plane) so the pageserver
#         PROCESS stays up (container Running) while its readiness probe fails; assert
#         the Service selector does NOT flip, pswatcher_dependency_degraded_total rises
#         (a HARD assertion — a branch never entered proves nothing), then restore MinIO
#         and assert normal operation resumes. Skipped unless the backend is in-cluster
#         MinIO.
#         SCOPE: DG1 proves the discrimination for a degradation SHORTER than the
#         pageserver's own liveness window (~60s; its livenessProbe also hits
#         /v1/status). A degradation that outlasts that window crashloops the container
#         and the watcher correctly promotes. The mitigation for the minutes-long class
#         (cred rotation, object-store migration) is the maintenance FREEZE (FZ2), not
#         the discrimination — see ADR-0011.
#   [DG2] discrimination surface — the metric pswatcher_dependency_degraded_total is
#         exposed (registered), so alerting can bind to it even before it fires.
#
# Usage:
#   deploy/_verify-failover-freeze.sh run            # FZ1 + DG2 (safe, non-destructive)
#   RUN_DEGRADE=1 deploy/_verify-failover-freeze.sh run   # + DG1 (reversible MinIO drop)
#   RUN_KILL=1   deploy/_verify-failover-freeze.sh run    # + FZ2 (CONSUMES the standby)
#   deploy/_verify-failover-freeze.sh teardown       # remove a leftover freeze CM
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg),
#      FREEZE_CM (default pageserver-failover-freeze), PS_SVC (default pageserver),
#      STANDBY_APP (default pageserver-standby), POLL_WAIT (default 12s).
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
FREEZE_CM="${FREEZE_CM:-pageserver-failover-freeze}"
PS_SVC="${PS_SVC:-pageserver}"
STANDBY_APP="${STANDBY_APP:-pageserver-standby}"
POLL_WAIT="${POLL_WAIT:-12}"
K="kubectl --context=$KCTX -n $NS"

FAILS=0
ok()   { printf '  ok   - %s\n' "$1"; }
bad()  { printf '  FAIL - %s\n' "$1"; FAILS=$((FAILS+1)); }
info() { printf '  ..   - %s\n' "$1"; }

# psw_metrics — scrape the pswatcher /metrics through a standby-pod curl (same trick as
# the multitenant drill: the metrics Service is ClusterIP-only, never LB-fronted).
psw_metrics() {
  _ip="$($K get pod -l app=pswatcher -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || echo '')"
  [ -z "$_ip" ] && { echo ''; return; }
  $K exec sts/pageserver-standby -- curl -s --max-time 10 "http://$_ip:9091/metrics" 2>/dev/null || echo ''
}

# metric_val NAME — value of a bare (unlabeled) metric line, or empty.
metric_val() { printf '%s\n' "$1" | awk -v n="$2" '$1==n {print $2; exit}'; }

selector_app() { $K get svc "$PS_SVC" -o jsonpath='{.spec.selector.app}' 2>/dev/null || echo ''; }

teardown() {
  $K delete configmap "$FREEZE_CM" --ignore-not-found >/dev/null 2>&1 || true
  ok "removed any leftover $FREEZE_CM"
}

run() {
  echo "=== T5 failover-trigger drill (#1099) — ns=$NS ctx=$KCTX ==="
  $K get deploy pswatcher >/dev/null 2>&1 || { bad "pswatcher not deployed in $NS"; exit 1; }

  # Clean slate: no freeze.
  $K delete configmap "$FREEZE_CM" --ignore-not-found >/dev/null 2>&1 || true
  sleep "$POLL_WAIT"

  M="$(psw_metrics)"
  [ -z "$M" ] && { bad "could not scrape pswatcher /metrics"; exit 1; }

  # --- [DG2] discrimination metric surface ---------------------------------
  if printf '%s\n' "$M" | grep -q '^pswatcher_dependency_degraded_total '; then
    ok "[DG2] pswatcher_dependency_degraded_total is exposed (alerting can bind)"
  else
    bad "[DG2] pswatcher_dependency_degraded_total absent — the discrimination metric is not exposed"
  fi

  # --- [FZ1] freeze gauge lifecycle ----------------------------------------
  fz0="$(metric_val "$M" pswatcher_failover_frozen)"
  if [ "${fz0:-x}" = "0" ]; then
    ok "[FZ1] no freeze set ⇒ pswatcher_failover_frozen 0"
  else
    bad "[FZ1] expected pswatcher_failover_frozen 0 with no freeze, got '${fz0:-<none>}'"
  fi

  # Create a freeze expiring 10m out. RFC3339, UTC.
  UNTIL="$(date -u -d '+10 min' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+10M +%Y-%m-%dT%H:%M:%SZ)"
  $K create configmap "$FREEZE_CM" \
     --from-literal=until="$UNTIL" \
     --from-literal=reason="drill: T5 freeze verification" >/dev/null
  info "[FZ1] created $FREEZE_CM until=$UNTIL"
  sleep "$POLL_WAIT"

  M="$(psw_metrics)"
  fz1="$(metric_val "$M" pswatcher_failover_frozen)"
  exp="$(metric_val "$M" pswatcher_failover_freeze_expiry_seconds)"
  want_exp="$(date -u -d "$UNTIL" +%s 2>/dev/null || date -u -j -f %Y-%m-%dT%H:%M:%SZ "$UNTIL" +%s)"
  if [ "${fz1:-x}" = "1" ]; then
    ok "[FZ1] freeze active ⇒ pswatcher_failover_frozen 1"
  else
    bad "[FZ1] freeze set but pswatcher_failover_frozen != 1 (got '${fz1:-<none>}')"
  fi
  # Expiry within the 2h clamp of a just-created freeze == the raw until.
  if [ -n "${exp:-}" ] && [ "$exp" -ge "$((want_exp - 5))" ] && [ "$exp" -le "$((want_exp + 5))" ]; then
    ok "[FZ1] published expiry ($exp) matches until ($want_exp) within the clamp"
  else
    bad "[FZ1] expiry '${exp:-<none>}' != until $want_exp (clamped or missing)"
  fi

  # --- [FZ2] freeze suppresses a real death (OPT-IN — consumes the standby) --
  if [ "${RUN_KILL:-0}" = "1" ]; then
    before_sel="$(selector_app)"
    supp0="$(metric_val "$M" pswatcher_failover_freeze_suppressed_total)"
    info "[FZ2] scaling pageserver (primary) to 0 with a freeze ACTIVE — selector should NOT flip"
    $K scale statefulset pageserver --replicas=0 >/dev/null
    # Wait past the fail threshold (~6s) plus a margin.
    sleep "$POLL_WAIT"
    after_sel="$(selector_app)"
    M2="$(psw_metrics)"
    supp1="$(metric_val "$M2" pswatcher_failover_freeze_suppressed_total)"
    if [ "$after_sel" = "$before_sel" ] && [ "$after_sel" != "$STANDBY_APP" ]; then
      ok "[FZ2] Service selector stayed '$after_sel' (no flip) while frozen despite a dead primary"
    else
      bad "[FZ2] selector flipped to '$after_sel' during an active freeze (suppression failed)"
    fi
    if [ -n "${supp1:-}" ] && [ "${supp1:-0}" -gt "${supp0:-0}" ]; then
      ok "[FZ2] pswatcher_failover_freeze_suppressed_total rose ($supp0 -> $supp1)"
    else
      bad "[FZ2] suppressed-count did not rise ($supp0 -> ${supp1:-<none>})"
    fi
    info "[FZ2] restoring pageserver primary to 1"
    $K scale statefulset pageserver --replicas=1 >/dev/null
  else
    info "[FZ2] skipped (set RUN_KILL=1 to prove suppression against a real death — CONSUMES the standby)"
  fi

  # Clear the freeze; gauge must fall back to 0.
  $K delete configmap "$FREEZE_CM" --ignore-not-found >/dev/null 2>&1 || true
  sleep "$POLL_WAIT"
  M="$(psw_metrics)"
  fz2="$(metric_val "$M" pswatcher_failover_frozen)"
  if [ "${fz2:-x}" = "0" ]; then
    ok "[FZ1] freeze cleared ⇒ pswatcher_failover_frozen 0 (HA resumes)"
  else
    bad "[FZ1] freeze deleted but pswatcher_failover_frozen still '${fz2:-<none>}'"
  fi

  # --- [FZ3] NATURAL TTL EXPIRY (no CM deletion) ---------------------------
  # FZ1 above proves the gauge clears when the ConfigMap is DELETED. That is not the
  # same claim as "a freeze lapses on its own", which is the entire safety argument for
  # a forgotten freeze. Set a freeze that expires in FZ3_TTL seconds and poll until the
  # gauge falls to 0 with the ConfigMap STILL PRESENT.
  FZ3_TTL="${FZ3_TTL:-20}"
  UNTIL3="$(date -u -d "+${FZ3_TTL} sec" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+"${FZ3_TTL}"S +%Y-%m-%dT%H:%M:%SZ)"
  $K create configmap "$FREEZE_CM" \
     --from-literal=until="$UNTIL3" \
     --from-literal=reason="drill: T5 natural-expiry verification" >/dev/null
  info "[FZ3] created $FREEZE_CM until=$UNTIL3 (+${FZ3_TTL}s) — waiting for it to lapse WITHOUT deleting it"
  fz3=""
  # Bound: the TTL plus a generous couple of poll intervals.
  _deadline=$(( $(date +%s) + FZ3_TTL + 2 * POLL_WAIT + 10 ))
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    fz3="$(metric_val "$(psw_metrics)" pswatcher_failover_frozen)"
    [ "${fz3:-x}" = "0" ] && break
    sleep 3
  done
  if [ "${fz3:-x}" = "0" ] && $K get configmap "$FREEZE_CM" >/dev/null 2>&1; then
    ok "[FZ3] freeze lapsed at its until with the ConfigMap STILL PRESENT ⇒ frozen 0 (a forgotten freeze really does end)"
  elif ! $K get configmap "$FREEZE_CM" >/dev/null 2>&1; then
    bad "[FZ3] the freeze ConfigMap vanished mid-test — this scenario must prove NATURAL expiry, not deletion"
  else
    bad "[FZ3] freeze did not lapse on its own within ${FZ3_TTL}s+margin (gauge '${fz3:-<none>}') — a forgotten freeze would suppress HA past its until"
  fi
  $K delete configmap "$FREEZE_CM" --ignore-not-found >/dev/null 2>&1 || true

  # --- [DG1] dependency degradation, process UP (OPT-IN, reversible) --------
  #
  # SCOPE — READ THIS BEFORE QUOTING THE RESULT. DG1 proves the discrimination for a
  # degradation SHORTER than the pageserver's own liveness window only. The pageserver's
  # livenessProbe also hits /v1/status (deploy/53-pageserver.yaml: failureThreshold 6 x
  # periodSeconds 10 => ~60s), so an object-store degradation that OUTLASTS that window
  # restarts the container into a crashloop, and the watcher then correctly promotes —
  # which is NOT a bug but IS the boundary of what this scenario can assert. The
  # mitigation for the minutes-long class (a credential rotation, an object-store
  # migration) is the maintenance FREEZE, exercised by FZ2 — not the discrimination.
  # The bounded wait below is deliberately kept INSIDE the liveness window.
  if [ "${RUN_DEGRADE:-0}" = "1" ]; then
    if $K get deploy minio >/dev/null 2>&1; then
      before_sel="$(selector_app)"
      deg0="$(metric_val "$(psw_metrics)" pswatcher_dependency_degraded_total)"
      info "[DG1] scaling MinIO to 0 — object store degraded, pageserver PROCESS stays up (sub-liveness-window only)"
      $K scale deploy minio --replicas=0 >/dev/null
      # Bounded wait for readiness to flip and the discrimination branch to be ENTERED.
      # Capped at DG1_WAIT (default 40s) so we stay inside the ~60s liveness window: past
      # it the container crashloops and the promote branch legitimately takes over.
      DG1_WAIT="${DG1_WAIT:-40}"
      deg1=""
      _deadline=$(( $(date +%s) + DG1_WAIT ))
      while [ "$(date +%s)" -lt "$_deadline" ]; do
        deg1="$(metric_val "$(psw_metrics)" pswatcher_dependency_degraded_total)"
        [ -n "${deg1:-}" ] && [ "${deg1:-0}" -gt "${deg0:-0}" ] && break
        sleep 3
      done
      after_sel="$(selector_app)"
      if [ "$after_sel" = "$before_sel" ] && [ "$after_sel" != "$STANDBY_APP" ]; then
        ok "[DG1] no failover on a sub-liveness-window dependency degradation (selector stayed '$after_sel')"
      else
        bad "[DG1] FAILED OVER on a recoverable degradation (selector '$after_sel') — the split-brain class"
      fi
      # HARD assertion (was informational): if the counter never rises, the
      # discrimination branch was never entered and DG1 proved nothing — a silently
      # decorative drill. Only the PROMOTE path is an acceptable alternative outcome,
      # and the selector assertion above already covers that.
      if [ -n "${deg1:-}" ] && [ "${deg1:-0}" -gt "${deg0:-0}" ]; then
        ok "[DG1] pswatcher_dependency_degraded_total rose ($deg0 -> $deg1) — the discrimination branch was entered"
      else
        bad "[DG1] degraded-count did not rise within ${DG1_WAIT}s ($deg0 -> ${deg1:-<none>}) — the discrimination branch was NEVER entered, so this scenario asserted nothing. Check that the pageserver readiness probe actually flipped (kubectl describe pod -l app=pageserver)."
      fi
      info "[DG1] restoring MinIO to 1"
      $K scale deploy minio --replicas=1 >/dev/null
      # POST-RESTORE: "restore creds => normal operation" is an explicit exit criterion
      # and was previously unchecked. Assert the plane actually recovers: the primary
      # serves again AND the selector is still the ORIGINAL one (no late flip).
      up=""
      _deadline=$(( $(date +%s) + 3 * POLL_WAIT + 30 ))
      while [ "$(date +%s)" -lt "$_deadline" ]; do
        up="$(metric_val "$(psw_metrics)" pswatcher_primary_up)"
        [ "${up:-x}" = "1" ] && break
        sleep 3
      done
      if [ "${up:-x}" = "1" ]; then
        ok "[DG1] object store restored ⇒ pswatcher_primary_up 1 (normal operation resumed)"
      else
        bad "[DG1] object store restored but pswatcher_primary_up is '${up:-<none>}' — the plane did not return to normal operation"
      fi
      restored_sel="$(selector_app)"
      if [ "$restored_sel" = "$before_sel" ]; then
        ok "[DG1] selector still the original '$restored_sel' after restore — the standby was never consumed"
      else
        bad "[DG1] selector is '$restored_sel' (was '$before_sel') — a failover fired during or after the degradation"
      fi
    else
      info "[DG1] skipped — no in-cluster MinIO Deployment (object store is external); degrade it out-of-band to exercise this path"
    fi
  else
    info "[DG1] skipped (set RUN_DEGRADE=1 to degrade the object store reversibly and assert NO failover)"
  fi

  echo "=========================================================================="
  if [ "$FAILS" -eq 0 ]; then
    echo " T5 FAILOVER-TRIGGER DRILL PASSED — freeze + discrimination contract holds"
    echo "=========================================================================="
    exit 0
  else
    echo " T5 FAILOVER-TRIGGER DRILL FAILED — $FAILS assertion(s) unmet"
    echo "=========================================================================="
    exit 1
  fi
}

case "${1:-run}" in
  run)      run ;;
  teardown) teardown ;;
  *) echo "usage: $0 [run|teardown]"; exit 2 ;;
esac
