#!/bin/sh
# Alert-routing verification: an alert that fires must actually REACH a
# receiver — Prometheus evaluating rules into the void pages nobody
# (round-2 DevOps CRITICAL). Proves the path Prometheus -> Alertmanager ->
# webhook sink with a synthetic always-firing drill rule, then cleans up.
set -eu
NS=scale-zero-pg
K="kubectl -n $NS"

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

# 2. inject a synthetic always-firing drill rule
restore_rules() {
  $K get cm prometheus-config -o json | \
    python3 -c "import json,sys; d=json.load(sys.stdin); d['data']['rules.yml']=open('/tmp/rules-backup-$$.yml').read(); print(json.dumps(d))" | \
    $K replace -f - >/dev/null
  $K rollout restart deploy/prometheus >/dev/null
}
$K get cm prometheus-config -o jsonpath='{.data.rules\.yml}' > /tmp/rules-backup-$$.yml
cat /tmp/rules-backup-$$.yml > /tmp/rules-drill-$$.yml
cat >> /tmp/rules-drill-$$.yml <<'EOF'
      - alert: KsPgAlertDrill
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
$K exec deploy/prometheus -- kill -HUP 1 2>/dev/null || $K rollout restart deploy/prometheus >/dev/null
ok "drill rule injected (KsPgAlertDrill, vector(1))"

# 3. the alert must arrive at the webhook sink (via alertmanager)
i=0
until $K logs deploy/alert-sink --since=5m 2>/dev/null | grep -q 'KsPgAlertDrill'; do
  i=$((i+1)); [ $i -gt 60 ] && { restore_rules; fail "drill alert never reached the sink (>120s)"; }
  sleep 2
done
ok "drill alert delivered: prometheus -> alertmanager -> webhook sink"

# 4. restore original rules
restore_rules
rm -f /tmp/rules-backup-$$.yml /tmp/rules-drill-$$.yml
ok "original rules restored"

echo "alerting verification: the pager path works"
