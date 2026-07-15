#!/bin/sh
# CronJob-failure alerting drill (issues #29/#41): proves the NEW producer +
# rule path end-to-end — kube-state-metrics -> Prometheus rule (the exact
# kube_job_owner join the real backup/wal-janitor rules use) -> Alertmanager ->
# webhook sink. Complements _verify-alerting.sh (which drills a synthetic
# always-firing rule); this one drills the REAL failure signal a failing
# CronJob emits, without touching the production backup/janitor CronJobs.
#
# Honest-pager properties preserved from _verify-alerting.sh: unique per-run
# identity (Alertmanager dedups by labelset), every kubectl bounded by a
# request-timeout, and full cleanup (rules + throwaway CronJob) on ANY exit.
set -eu
NS=scale-zero-pg
K="kubectl --request-timeout=15s -n $NS"
TS=$(date +%s)
DRILL="CronDrill${TS}"
CJ="alert-drill-${TS}"          # throwaway CronJob; its Jobs are OWNED by it
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# Query Prometheus from inside its own pod (the image ships /bin/wget).
PROMQ() { $K exec deploy/prometheus -- wget -qO- "http://localhost:9090/api/v1/query?query=$1" 2>/dev/null || true; }
# target_up JOB -> 0 if up{job=JOB}==1, else non-zero
target_up() {
  q="up%7Bjob%3D%22$1%22%7D" # up{job="$1"}
  out=$(PROMQ "$q")
  echo "$out" | grep -q '"result":\[{' || return 1
  echo "$out" | grep -oE '"[01]"\]' | tail -1 | grep -q '"1"'
}

# 0. components ready
for d in prometheus alertmanager alert-sink kube-state-metrics; do
  $K rollout status deploy/$d --timeout=120s >/dev/null 2>&1 || fail "deploy/$d not ready"
done
ok "prometheus + alertmanager + alert-sink + kube-state-metrics ready"

# 1. the new scrape targets must be UP in Prometheus (KSM produces the metrics;
#    pswatcher is the failover authority — issue #23's "who watches the watcher").
i=0
until target_up kube-state-metrics; do
  i=$((i+1)); [ $i -gt 30 ] && fail "kube-state-metrics target never came UP in Prometheus (>60s)"
  sleep 2
done
ok "Prometheus target UP: kube-state-metrics"
i=0
until target_up pswatcher; do
  i=$((i+1)); [ $i -gt 30 ] && fail "pswatcher target never came UP in Prometheus (>60s)"
  sleep 2
done
ok "Prometheus target UP: pswatcher"

# 2. cleanup trap: restore rules + delete the throwaway CronJob (and its Jobs).
CLEANED=0
cleanup() {
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  $K get cm prometheus-config -o json 2>/dev/null | \
    python3 -c "import json,sys; d=json.load(sys.stdin); d['data']['rules.yml']=open('/tmp/cjrules-$$.yml').read(); print(json.dumps(d))" 2>/dev/null | \
    $K replace -f - >/dev/null 2>&1 || true
  $K rollout restart deploy/prometheus >/dev/null 2>&1 || true
  $K delete cronjob "$CJ" --ignore-not-found >/dev/null 2>&1 || true
  $K delete jobs -l drill="$CJ" --ignore-not-found >/dev/null 2>&1 || true
  rm -f /tmp/cjrules-$$.yml /tmp/cjrules-drill-$$.yml
}
trap cleanup EXIT INT TERM

# 3. throwaway CronJob that always FAILS. schedule every minute + not suspended
#    so the CronJob CONTROLLER creates an OWNED Job (kube_job_owner.owner_name
#    == the CronJob name) — exactly what the real rules join on.
cat <<EOF | $K apply -f - >/dev/null || fail "could not create drill CronJob"
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${CJ}
  labels: { drill: "${CJ}" }
spec:
  schedule: "* * * * *"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 30
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    metadata:
      labels: { drill: "${CJ}" }
    spec:
      backoffLimit: 0
      template:
        metadata:
          labels: { drill: "${CJ}" }
        spec:
          restartPolicy: Never
          containers:
            - name: fail
              # shell-bearing + proven pullable on this cluster (used by the
              # other in-cluster drills). The KSM image is distroless (no shell),
              # so it can't run `exit 1` — the container would never fail cleanly.
              image: curlimages/curl:8.11.1
              command: ["sh", "-c", "exit 1"]
              resources:
                requests: { cpu: 5m, memory: 8Mi, ephemeral-storage: 50Mi }
                limits: { memory: 32Mi, ephemeral-storage: 100Mi }
EOF
ok "throwaway failing CronJob ${CJ} created (schedule every minute)"

# 4. wait for the controller to create an owned Job that reaches Failed, and for
#    KSM to publish kube_job_status_failed>0 joined to owner_name=${CJ}.
FAILEDQ="sum(kube_job_status_failed%7Bnamespace%3D%22${NS}%22%7D%20%2A%20on(namespace%2Cjob_name)%20group_left(owner_name)%20kube_job_owner%7Bowner_name%3D%22${CJ}%22%7D)"
i=0
until echo "$(PROMQ "$FAILEDQ")" | grep -oE '"[0-9]+"\]' | tail -1 | grep -qvE '"0"\]'; do
  i=$((i+1)); [ $i -gt 90 ] && fail "KSM never reported a failed Job owned by ${CJ} (>180s)"
  sleep 2
done
ok "kube-state-metrics reports a FAILED Job owned by ${CJ} (owner-join works)"

# 5. inject a drill rule using the EXACT idiom the real backup/janitor rules use,
#    pointed at the throwaway CronJob's owner_name. Reuse the propagate+reload
#    dance from _verify-alerting.sh (subPath-free dir mount already in 60).
$K get cm prometheus-config -o jsonpath='{.data.rules\.yml}' > /tmp/cjrules-$$.yml
cat /tmp/cjrules-$$.yml > /tmp/cjrules-drill-$$.yml
cat >> /tmp/cjrules-drill-$$.yml <<EOF
      - alert: ${DRILL}
        expr: sum(kube_job_status_failed{namespace="${NS}"} * on(namespace, job_name) group_left(owner_name) kube_job_owner{owner_name="${CJ}"}) > 0
        labels: { severity: drill }
        annotations: { summary: "synthetic cronjob-failure drill - safe to ignore" }
EOF
$K get cm prometheus-config -o json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); d['data']['rules.yml']=open('/tmp/cjrules-drill-$$.yml').read(); print(json.dumps(d))" | \
  $K replace -f - >/dev/null
i=0
until $K exec deploy/prometheus -- cat /etc/prometheus/rules/rules.yml 2>/dev/null | grep -q "${DRILL}"; do
  i=$((i+1)); [ $i -gt 60 ] && fail "drill rule never propagated into the pod (>120s)"
  sleep 2
done
$K exec deploy/prometheus -- kill -HUP 1 2>/dev/null || $K rollout restart deploy/prometheus >/dev/null
ok "drill rule injected + propagated + reloaded (${DRILL})"

# 6. the alert must arrive at the webhook sink (via alertmanager).
i=0
until $K logs deploy/alert-sink --since=10m 2>/dev/null | grep -q "${DRILL}"; do
  i=$((i+1)); [ $i -gt 120 ] && fail "cronjob-failure drill alert never reached the sink (>240s)"
  sleep 2
done
ok "cronjob-failure alert delivered: KSM -> prometheus rule -> alertmanager -> sink"

cleanup
echo "cronjob alerting verification: a failing CronJob pages, and KSM + pswatcher targets are UP"
