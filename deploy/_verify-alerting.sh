#!/bin/sh
# Alert-routing verification: an alert that fires must actually REACH a
# receiver — Prometheus evaluating rules into the void pages nobody
# (round-2 DevOps CRITICAL). Proves the path Prometheus -> Alertmanager ->
# webhook sink with a synthetic always-firing drill rule, then cleans up.
set -eu
NS=scale-zero-pg
# Every kubectl call is bounded (a hung exec must not hang the operator —
# devops-r3 had to kill this script), and rules are restored on ANY exit.
K="kubectl --request-timeout=15s -n $NS"

# Unique per-run alert identity: Alertmanager dedups by labelset, so a fixed
# drill name is suppressed for repeat_interval (4h) after any prior success —
# which is exactly how the drill "hung" for a second operator.
DRILL="KsPgDrill$(date +%s)"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# 0. components exist and are ready
for d in prometheus alertmanager alert-sink; do
  $K rollout status deploy/$d --timeout=120s >/dev/null 2>&1 || fail "deploy/$d not ready"
done
ok "prometheus + alertmanager + alert-sink ready"

# 1. prometheus persists and routes: PVC bound, alerting block configured
$K get pvc prometheus-data >/dev/null 2>&1 || fail "prometheus-data PVC missing"
$K get cm prometheus-config -o jsonpath='{.data.prometheus\.yml}' | grep -q 'alertmanager:9093' \
  || fail "prometheus config lacks alerting -> alertmanager:9093"
ok "prometheus on PVC, alerting block points at alertmanager"

# 1b. DEAD-MAN'S-SWITCH (#60): the always-firing Watchdog must be ACTIVE in
#     Alertmanager — that is the heartbeat the external monitor watches for. If it
#     is NOT active, the dead-man's-switch is silent and the alerting stack's own
#     death would go unnoticed. Query Alertmanager's own API (v2) for it.
i=0
until $K exec deploy/prometheus -- wget -qO- 'http://alertmanager:9093/api/v2/alerts?active=true' 2>/dev/null | grep -q 'Watchdog'; do
  i=$((i+1)); [ $i -gt 60 ] && fail "Watchdog dead-man's-switch never became active in Alertmanager (>120s) — is the ks-pg-watchdog rule loaded? (#60)"
  sleep 2
done
ok "Watchdog dead-man's-switch is ACTIVE in Alertmanager (external heartbeat present, #60)"

# 1c. MULTI-TENANT SCRAPE COVERAGE (#80): the apps-gateway (pggw-apps) must be an UP
#     Prometheus target — before this it was never scraped, so the whole branch-per-app
#     plane emitted metrics no rule ever saw. Assert (a) at least one UP target whose
#     `gateway` label is pggw-apps, and (b) the new multi-tenant/read-pool wake rules are
#     LOADED in Prometheus (so a crash-looping per-app compute / stuck RO pool can page).
i=0
until $K exec deploy/prometheus -- wget -qO- 'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null \
    | grep -q '"gateway":"pggw-apps"'; do
  i=$((i+1)); [ $i -gt 30 ] && fail "apps-gateway (pggw-apps) never became an active Prometheus target (>60s) — scrape keep not widened to pggw(-apps)? (#80)"
  sleep 2
done
# require it HEALTHY (up), not merely discovered.
$K exec deploy/prometheus -- wget -qO- 'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
apps=[t for t in d["data"]["activeTargets"] if t["labels"].get("gateway")=="pggw-apps"]
up=[t for t in apps if t.get("health")=="up"]
sys.exit(0 if up else 1)' || fail "pggw-apps target present but not UP — apps-gateway metrics are not being scraped (#80)"
ok "apps-gateway (pggw-apps) is an UP Prometheus target — multi-tenant plane is scraped (#80)"
for a in ComputeWakeStuckApps ComputeRoPoolStuck ComputeStuckNotReady; do
  $K exec deploy/prometheus -- wget -qO- 'http://localhost:9090/api/v1/rules' 2>/dev/null | grep -q "\"$a\"" \
    || fail "rule $a is not loaded in Prometheus (#80)"
done
ok "multi-tenant/read-pool wake rules loaded (ComputeWakeStuckApps, ComputeRoPoolStuck, ComputeStuckNotReady) (#80)"

# 2. inject a synthetic always-firing drill rule
CLEANED=0
restore_rules() {
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  $K get cm prometheus-config -o json | \
    python3 -c "import json,sys; d=json.load(sys.stdin); d['data']['rules.yml']=open('/tmp/rules-backup-$$.yml').read(); print(json.dumps(d))" | \
    $K replace -f - >/dev/null
  $K rollout restart deploy/prometheus >/dev/null
}
$K get cm prometheus-config -o jsonpath='{.data.rules\.yml}' > /tmp/rules-backup-$$.yml
trap restore_rules EXIT INT TERM
cat /tmp/rules-backup-$$.yml > /tmp/rules-drill-$$.yml
cat >> /tmp/rules-drill-$$.yml <<EOF
      - alert: ${DRILL}
        expr: vector(1)
        labels: { severity: drill }
        annotations: { summary: "synthetic drill alert - safe to ignore" }
EOF
$K create configmap prometheus-config --from-file=rules.yml=/tmp/rules-drill-$$.yml \
  --from-literal=keep=1 -o yaml --dry-run=client | true
# patch only the rules.yml key (keep prometheus.yml intact)
$K get cm prometheus-config -o json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); d['data']['rules.yml']=open('/tmp/rules-drill-$$.yml').read(); print(json.dumps(d))" | \
  $K replace -f - >/dev/null
# ConfigMap volumes propagate on the kubelet sync period (~1min): wait until
# the file the pod actually sees contains the drill rule, THEN reload.
i=0
until $K exec deploy/prometheus -- cat /etc/prometheus/rules/rules.yml 2>/dev/null | grep -q "${DRILL}"; do
  i=$((i+1)); [ $i -gt 60 ] && { restore_rules; fail "drill rule never propagated into the pod (>120s)"; }
  sleep 2
done
$K exec deploy/prometheus -- kill -HUP 1 2>/dev/null || $K rollout restart deploy/prometheus >/dev/null
ok "drill rule injected + propagated + config reloaded (${DRILL})"

# 3. the alert must arrive at the webhook sink (via alertmanager).
# Budget: evaluation interval (<=1m) + group_wait + delivery.
i=0
until $K logs deploy/alert-sink --since=10m 2>/dev/null | grep -q "${DRILL}"; do
  i=$((i+1)); [ $i -gt 120 ] && { restore_rules; fail "drill alert never reached the sink (>240s)"; }
  sleep 2
done
ok "drill alert delivered: prometheus -> alertmanager -> webhook sink"

# 4. restore original rules
restore_rules
rm -f /tmp/rules-backup-$$.yml /tmp/rules-drill-$$.yml
ok "original rules restored"

echo "alerting verification: the pager path works"
