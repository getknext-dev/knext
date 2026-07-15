#!/usr/bin/env bash
# _verify-zone-deploy.sh — the v1.3.1 zone-ops hardening LIVE proof (issues #151 + #142).
#
# Closes the two convergent P1 findings from the v1.3.0 blind trio, both operational:
#
#  PART A (#151) — the Zone CRD + zone-operator are a STANDARD, SUSTAINED deploy, not
#  drill-only. _verify-zones.sh applies 86/87 then TEARS THEM DOWN on exit, so the
#  flagship (ADR-0007 v2-2) was proven only in ephemeral throwaway drills — on the live
#  cluster only `appdatabases` existed; no `zones` CRD, no zone-operator (the same
#  "merged ≠ deployed" class the loop caught 3× before: #27/#125/#126). This drill applies
#  86 + 87 as the standard deploy does, proves the CRD is installed + the operator runs
#  1/1 as a SUSTAINED soak (not a throwaway-ns drill), and proves applying the zone
#  manifests is IDEMPOTENT — it does not disturb existing AppDatabases.
#
#  PART B (#142) — the janitor-disarm tripwire. A missing janitor-critical ConfigMap
#  (storage-objstore/compute-config, or the repl-slot monitors' script CM) leaves the next
#  scheduled pod stuck in CreateContainerConfigError — the container NEVER starts, so no
#  Failed Job is produced and WalJanitorJobFailed / ReplicationSlot* / SafekeeperWALGrowth
#  (all kube_job_status_failed joins) stay silent; the ONLY backstop was WalJanitorStale at
#  >26h, by which time /safekeeper WAL has accumulated toward a node DiskPressure (the
#  2026-07-06 incident). This drill simulates exactly that — a janitor/monitor pod that
#  cannot start its container because a ConfigMap is missing — and proves the NEW
#  JanitorConfigDisarmed alert FIRES within one cycle (NOT the 26h stale path), for BOTH a
#  wal-janitor pod AND a repl-slot-monitor pod (same shared-config/exec coupling class).
#
# It NEVER touches the real backup/wal-janitor CronJobs or any real app: Part A only
# applies the (idempotent) zone manifests; Part B only creates its own throwaway pods.
#
# Usage:
#   deploy/_verify-zone-deploy.sh            # full proof (Part A then Part B)
#   deploy/_verify-zone-deploy.sh zone       # Part A only (#151)
#   deploy/_verify-zone-deploy.sh disarm     # Part B only (#142)
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg).
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"

K() { kubectl --context "$KCTX" -n "$NS" --request-timeout=20s "$@"; }
log() { printf '\033[36m[zone-deploy]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[zone-deploy] PASS:\033[0m %s\n' "$*"; }
bad() { printf '\033[31m[zone-deploy] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# Query Prometheus from inside its own pod (prom/prometheus ships /bin/wget).
PROMQ() { K exec deploy/prometheus -- wget -qO- "http://localhost:9090/api/v1/query?query=$1" 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# PART A — #151: zone CRD + operator are a standard, sustained, idempotent deploy.
# ---------------------------------------------------------------------------
zone_deploy() {
  local ZCRD=zones.zones.scale-zero-pg.dev

  # IDEMPOTENCY baseline: snapshot existing AppDatabases BEFORE applying zone manifests.
  # Applying the zone CRD+operator to a cluster with live apps must not disturb them.
  local BEFORE AFTER
  BEFORE="$(K get appdatabases -o name 2>/dev/null | sort | tr '\n' ' ' || true)"
  log "AppDatabases before zone apply: [${BEFORE:-<none>}]"

  # 1. Apply exactly what the standard deploy applies (the glob picks up 86/87).
  log "applying deploy/86-zone-crd.yaml + deploy/87-zone-operator.yaml (standard deploy, idempotent)"
  K apply -f "$HERE/86-zone-crd.yaml" >/dev/null
  K apply -f "$HERE/87-zone-operator.yaml" >/dev/null
  K rollout status deploy/zone-operator --timeout=150s >/dev/null

  # 2. CRD installed + serving v1alpha1.
  K get crd "$ZCRD" >/dev/null 2>&1 || bad "Zone CRD $ZCRD not installed after apply (#151)"
  local served
  served="$(K get crd "$ZCRD" -o jsonpath='{.spec.versions[?(@.name=="v1alpha1")].served}' 2>/dev/null)"
  [ "$served" = "true" ] || bad "Zone CRD $ZCRD does not serve v1alpha1 (served=$served) (#151)"
  ok "Zone CRD $ZCRD installed and serving v1alpha1 (a user can create a Zone) (#151)"

  # 3. SUSTAINED soak: operator must stay ready 1/1 across a window (not a flap that a
  #    throwaway drill would miss). Sample readyReplicas every 6s for ~60s.
  local i=0
  while [ "$i" -lt 10 ]; do
    local ready spec
    ready="$(K get deploy zone-operator -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"; ready=${ready:-0}
    spec="$(K get deploy zone-operator -o jsonpath='{.spec.replicas}' 2>/dev/null)"; spec=${spec:-0}
    [ "$ready" = "1" ] && [ "$spec" = "1" ] || bad "zone-operator not sustained-ready (sample $i: ready=$ready spec=$spec) (#151)"
    i=$((i+1)); sleep 6
  done
  ok "zone-operator sustained ready 1/1 across ~60s soak (a real deploy, not a throwaway drill) (#151)"

  # 4. IDEMPOTENCY: existing AppDatabases untouched by the zone apply.
  AFTER="$(K get appdatabases -o name 2>/dev/null | sort | tr '\n' ' ' || true)"
  [ "$BEFORE" = "$AFTER" ] || bad "AppDatabases changed by the zone apply (before=[$BEFORE] after=[$AFTER]) — not idempotent (#151)"
  ok "applying the zone manifests did not disturb existing AppDatabases (idempotent: [${AFTER:-<none>}]) (#151)"

  # 5. The drift gate agrees the zone axis is now live-present (belt-and-suspenders: run
  #    the same assertion the per-PR gate uses so this drill and the gate never diverge).
  KCTX="$KCTX" NS="$NS" "$HERE/_verify-drift.sh" >/dev/null 2>&1 \
    && ok "_verify-drift.sh section D confirms zone CRD + operator live-present (#151)" \
    || log "note: _verify-drift.sh reported drift elsewhere; re-run it directly to inspect (zone assertions themselves passed above)"
}

# ---------------------------------------------------------------------------
# PART B — #142: a missing janitor-critical ConfigMap PAGES within one cycle.
# ---------------------------------------------------------------------------
DRILL_PODS="wal-janitor-disarmdrill repl-slot-wal-monitor-disarmdrill"
disarm_cleanup() {
  for p in $DRILL_PODS; do K delete pod "$p" --ignore-not-found --grace-period=0 >/dev/null 2>&1 || true; done
}

disarm_drill() {
  trap disarm_cleanup EXIT INT TERM
  disarm_cleanup  # start clean

  # 1. Prometheus + KSM must be up (the alert reads KSM's pods collector).
  K rollout status deploy/prometheus --timeout=120s >/dev/null 2>&1 || bad "prometheus not ready"
  K rollout status deploy/kube-state-metrics --timeout=120s >/dev/null 2>&1 || bad "kube-state-metrics not ready"

  # 2. Create throwaway pods that CANNOT start their container because they reference a
  #    ConfigMap that does not exist (envFrom) — the EXACT CreateContainerConfigError the
  #    #142 incident hit. Named so they match the JanitorConfigDisarmed pod regex
  #    ((wal-janitor|repl-slot-wal-monitor|...)-.+): one janitor pod + one repl-slot
  #    monitor pod, proving the rule covers BOTH the config/exec coupling class.
  log "creating disarmed drill pods (missing ConfigMap -> CreateContainerConfigError): $DRILL_PODS"
  for p in $DRILL_PODS; do
    cat <<YAML | K apply -f - >/dev/null || bad "could not create drill pod $p"
apiVersion: v1
kind: Pod
metadata:
  name: ${p}
  labels: { drill: janitor-disarm }
spec:
  restartPolicy: Never
  containers:
    - name: prune
      image: curlimages/curl:8.11.1
      command: ["sh", "-c", "sleep 3600"]
      envFrom:
        - configMapRef: { name: storage-objstore-deleted-by-drill }  # does NOT exist
      resources:
        requests: { cpu: 5m, memory: 8Mi, ephemeral-storage: 50Mi }
        limits: { memory: 32Mi, ephemeral-storage: 100Mi }
YAML
  done

  # 3. Both drill pods must reach CreateContainerConfigError, and KSM must publish the
  #    waiting-reason series the rule reads.
  local i=0
  for p in $DRILL_PODS; do
    i=0
    until [ "$(K get pod "$p" -o jsonpath='{.status.containerStatuses[0].state.waiting.reason}' 2>/dev/null)" = "CreateContainerConfigError" ]; do
      i=$((i+1)); [ "$i" -gt 60 ] && bad "drill pod $p never reached CreateContainerConfigError (>120s)"
      sleep 2
    done
  done
  ok "both drill pods stuck in CreateContainerConfigError (container never starts — the silent hole #142)"

  # 4. KSM waiting-reason metric present for the drill pods (the alert's source).
  local q='kube_pod_container_status_waiting_reason%7Bnamespace%3D%22'"$NS"'%22%2Creason%3D%22CreateContainerConfigError%22%7D'
  i=0
  until echo "$(PROMQ "$q")" | grep -q 'disarmdrill'; do
    i=$((i+1)); [ "$i" -gt 60 ] && bad "KSM never published kube_pod_container_status_waiting_reason for the drill pods (>120s)"
    sleep 2
  done
  ok "kube-state-metrics publishes CreateContainerConfigError for the drill pods (alert source live)"

  # 5. The REAL JanitorConfigDisarmed rule (deploy/60) must FIRE — not merely pending —
  #    within one cycle. `for: 2m`, so allow up to ~4min; this is the whole point: it
  #    pages the SAME cycle instead of waiting 26h for WalJanitorStale.
  log "waiting for JanitorConfigDisarmed to FIRE (for: 2m; proves the one-cycle path, not the 26h stale path)"
  local fq='ALERTS%7Balertname%3D%22JanitorConfigDisarmed%22%2Calertstate%3D%22firing%22%7D'
  local start; start="$(date +%s)"
  i=0
  until echo "$(PROMQ "$fq")" | grep -q '"result":\[{'; do
    i=$((i+1)); [ "$i" -gt 90 ] && bad "JanitorConfigDisarmed never fired (>270s) — the disarm hole is NOT covered (#142)"
    sleep 3
  done
  local took=$(( $(date +%s) - start ))
  ok "JanitorConfigDisarmed FIRED in ~${took}s (one cycle — NOT the 26h WalJanitorStale path) (#142)"

  # 6. Prove it fired for BOTH pod classes (janitor + repl-slot monitor).
  local firing
  firing="$(PROMQ "$fq")"
  echo "$firing" | grep -q 'wal-janitor-disarmdrill' \
    && ok "JanitorConfigDisarmed fired for the wal-janitor pod (nightly janitor covered) (#142)" \
    || bad "JanitorConfigDisarmed did not include the wal-janitor pod (#142)"
  echo "$firing" | grep -q 'repl-slot-wal-monitor-disarmdrill' \
    && ok "JanitorConfigDisarmed fired for the repl-slot-monitor pod (zone repl-slot monitors covered) (#142)" \
    || bad "JanitorConfigDisarmed did not include the repl-slot-monitor pod — zone monitors not covered (#142)"

  disarm_cleanup
  ok "janitor-disarm tripwire proven: a missing janitor-critical ConfigMap PAGES within one cycle (#142)"
}

case "${1:-all}" in
  zone)   zone_deploy ;;
  disarm) disarm_drill ;;
  all)    zone_deploy; echo; disarm_drill ;;
  *) echo "usage: _verify-zone-deploy.sh {all|zone|disarm}"; exit 1 ;;
esac

echo
ok "v1.3.1 zone-ops hardening LIVE proof complete (#151 zone CRD+operator sustained-live; #142 janitor-disarm pages in one cycle)"
