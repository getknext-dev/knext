#!/bin/sh
# KSM self-guard drill (issue #48). kube-state-metrics is the SOLE producer of the
# kube_job_*/kube_cronjob_*/kube_*_replicas series that five platform alerts key off.
# If it dies, those series go absent and every dependent rule silently stops firing.
# The KubeStateMetricsDown alert (deploy/60) is supposed to page on exactly that.
# This drill proves it end-to-end: scale KSM to 0, assert KubeStateMetricsDown reaches
# the sink, then restore KSM. Sibling to _verify-cronjob-alerting.sh (which drills the
# producer's OUTPUT path); this one drills the producer's OWN liveness.
set -eu
cd "$(dirname "$0")"
NS=scale-zero-pg
K="kubectl --request-timeout=20s -n $NS"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

for d in prometheus alertmanager alert-sink kube-state-metrics; do
  $K rollout status deploy/$d --timeout=120s >/dev/null 2>&1 || fail "deploy/$d not ready"
done
ok "prometheus + alertmanager + alert-sink + kube-state-metrics ready"

# rule must be shipped (not injected) — this is a REAL alert, not a synthetic one.
$K exec deploy/prometheus -- cat /etc/prometheus/rules/rules.yml 2>/dev/null | grep -q 'KubeStateMetricsDown' \
  || fail "KubeStateMetricsDown rule not loaded in Prometheus (deploy/60 not applied?)"
ok "KubeStateMetricsDown rule is loaded"

# restore trap: bring KSM back no matter how we exit.
RESTORED=0
restore() {
  [ "$RESTORED" = "1" ] && return 0
  RESTORED=1
  $K scale deploy/kube-state-metrics --replicas=1 >/dev/null 2>&1 || true
  $K rollout status deploy/kube-state-metrics --timeout=120s >/dev/null 2>&1 || true
}
trap restore EXIT INT TERM

# take KSM down. up{job=kube-state-metrics} goes 0 within a scrape interval; the
# rule's `for: 2m` then holds before it fires.
$K scale deploy/kube-state-metrics --replicas=0 >/dev/null || fail "could not scale KSM to 0"
ok "scaled kube-state-metrics to 0 — its series now go absent"

# the alert must reach the webhook sink (up==0 for 2m + group_wait ~= up to ~3m).
i=0
until $K logs deploy/alert-sink --since=10m 2>/dev/null | grep -q 'KubeStateMetricsDown'; do
  i=$((i+1)); [ $i -gt 110 ] && fail "KubeStateMetricsDown never reached the sink (>330s) with KSM down"
  sleep 3
done
ok "KubeStateMetricsDown delivered to the sink while KSM is down"

restore
ok "kube-state-metrics restored to 1 replica"
echo "KSM self-guard verification: a dead kube-state-metrics pages (KubeStateMetricsDown), producer liveness is monitored (issue #48)"
