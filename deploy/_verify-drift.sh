#!/bin/sh
# Live-spec-vs-manifest drift check (issue #13: "grep-green, prod-red").
# Two guards, both against the LIVE cluster:
#   A. every running pod declares the ephemeral-storage request the manifests
#      promise — catches applied-but-not-rolled / never-applied field drift.
#   B. PRESENCE + READINESS (issues #27/#51): every Deployment/StatefulSet/CronJob
#      declared in a deploy/NN-*.yaml manifest EXISTS on the cluster (closes the
#      merged≠deployed class — the grep-green/prod-red recurrence) AND is HEALTHY,
#      not merely present. Existence-only was blind to a deployed-yet-0-ready /
#      CrashLoopBackOff workload (e.g. a crash-looping kube-state-metrics would pass
#      "exists" while blinding 5+ platform alerts — #48/#51). So we also assert
#      readyReplicas==spec.replicas for Deployments/StatefulSets (this correctly
#      accepts the scale-to-zero compute: 0 ready == 0 desired) and that CronJobs are
#      NOT suspended.
set -eu
cd "$(dirname "$0")"
NS=scale-zero-pg
K="kubectl --request-timeout=15s -n $NS"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# A. field drift: running pods must carry the ephemeral-storage request.
BAD=$($K get pods --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.containers[0].resources.requests.ephemeral-storage}{"\n"}{end}' | awk '$2=="" {print $1}' | grep -v '^pgclient\|^metric-\|^verify-\|^wmetric-\|^alertq-\|^alert-drill-' || true)
[ -z "$BAD" ] || fail "pods running WITHOUT ephemeral-storage request: $BAD"
ok "live pods match the manifest ephemeral-storage contract"

# B. presence: parse every numbered manifest for its workload kinds+names, then
# assert each exists live. python3 splits multi-doc YAML and reads metadata.name
# for the three long-running workload kinds (Jobs are one-shot; Secrets/CMs/SVCs
# are covered by check A's pods or are not "load-bearing machinery").
DECLARED=$(python3 - <<'PY'
import glob, re, sys
want = {"Deployment", "StatefulSet", "CronJob"}
out = []
for path in sorted(glob.glob("[0-9][0-9]-*.yaml")):
    with open(path) as fh:
        text = fh.read()
    for doc in re.split(r'(?m)^---\s*$', text):
        kind = None
        for line in doc.splitlines():
            m = re.match(r'^kind:\s*(\S+)', line)
            if m:
                kind = m.group(1)
                break
        if kind not in want:
            continue
        # first metadata.name at 2-space indent (the object's own name).
        name = None
        in_meta = False
        for line in doc.splitlines():
            if re.match(r'^metadata:\s*$', line):
                in_meta = True
                continue
            if in_meta:
                m = re.match(r'^  name:\s*(\S+)', line)
                if m:
                    name = m.group(1)
                    break
                if re.match(r'^\S', line):  # left metadata block
                    in_meta = False
        if name:
            out.append(f"{kind} {name} {path}")
print("\n".join(out))
PY
)
[ -n "$DECLARED" ] || fail "presence parser found no Deployment/StatefulSet/CronJob in deploy/ — parser broken?"

MISSING=""
echo "$DECLARED" | while IFS=' ' read -r kind name src; do
  [ -n "$kind" ] || continue
  if ! $K get "$kind" "$name" >/dev/null 2>&1; then
    echo "  MISSING: $kind/$name (declared in deploy/$src)"
    continue
  fi
  # readiness (issue #51): exists is not healthy.
  case "$kind" in
    Deployment|StatefulSet)
      spec=$($K get "$kind" "$name" -o jsonpath='{.spec.replicas}' 2>/dev/null); spec=${spec:-0}
      ready=$($K get "$kind" "$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null); ready=${ready:-0}
      if [ "$ready" != "$spec" ]; then
        echo "  NOTREADY: $kind/$name readyReplicas=$ready want=$spec (declared in deploy/$src)"
      fi
      ;;
    CronJob)
      susp=$($K get cronjob "$name" -o jsonpath='{.spec.suspend}' 2>/dev/null)
      if [ "$susp" = "true" ]; then
        echo "  SUSPENDED: CronJob/$name (declared in deploy/$src)"
      fi
      ;;
  esac
done > /tmp/drift-missing-$$.txt
MISSING=$(cat /tmp/drift-missing-$$.txt)
rm -f /tmp/drift-missing-$$.txt
if [ -n "$MISSING" ]; then
  echo "$MISSING" >&2
  fail "declared workloads are absent, not-ready, or suspended (merged≠deployed / deployed≠healthy) — see above"
fi
COUNT=$(echo "$DECLARED" | grep -c . || true)
ok "all $COUNT declared Deployments/StatefulSets/CronJobs exist live AND are ready/not-suspended (presence+readiness, issues #27/#51)"

echo "drift verification: live pods match the manifest contract AND every declared workload is deployed and healthy"
