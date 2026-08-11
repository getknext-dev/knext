#!/usr/bin/env bash
# node-pressure-probe.sh — read kernel pressure/memory/CPU state from EACH node, so a
# node-local slowdown can be attributed instead of guessed at.
#
# WHY THIS EXISTS. `docs/benchmarks/slow-mode-attribution.md` establishes that the
# ~10-11 s cold-start slow mode occurs only on one node and is spent entirely in the
# readiness gate, with the kubelet's probe to queue-proxy TIMING OUT rather than
# 503-ing. What that measurement could NOT establish is the layer below: why a just-
# started process on that node fails to answer for ~9 s. The two candidate mechanisms
# — CPU starvation and memory/IO stall — are distinguishable, but only from inside the
# node, and this cluster has no node-exporter or cAdvisor (its Prometheus scrapes
# kube-state-metrics only), so the data does not exist anywhere else.
#
# PSI (/proc/pressure/*, kernel >= 4.20; these nodes run 5.15) is the metric that
# separates them. `some avg10` is the share of the last 10 s in which at least one task
# was stalled on that resource. A CPU-starved node shows cpu pressure; a node thrashing
# page cache shows io and memory pressure while CPU looks idle — which is exactly the
# shape `kubectl top` reports here (4% CPU, 81-84% memory).
#
# IT RUNS ON BOTH NODES, ALWAYS. A reading from the suspect node alone is unfalsifiable:
# without the healthy node beside it there is no way to tell an anomaly from this
# cluster's normal. The control is the point.
#
# CLUSTER FOOTPRINT. One Job per node, `restartPolicy: Never`, reaped by the cluster via
# `ttlSecondsAfterFinished` — this script issues NO delete, matching image-label-cluster.sh.
# It mounts /proc read-only and reads it; it writes nothing to the node and mutates no
# workload. It does not touch any NextApp, ksvc or benchmark service, so it cannot
# perturb a measurement in flight (though running it DURING a benchmark would add load —
# don't).
#
# Usage:
#   ./node-pressure-probe.sh [context] [namespace]

set -uo pipefail

CTX="${1:-${BENCH_CONTEXT:-context-ckmva7v7zvq}}"
NS="${2:-${BENCH_NAMESPACE:-default}}"
KUBECTL="${KUBECTL_BIN:-kubectl}"
# busybox is already resident on these nodes; using it avoids a registry pull inside a
# probe whose whole purpose is to observe the node in its normal state.
PROBE_IMAGE="${PROBE_IMAGE:-busybox:1.36}"
STAMP="$(date -u +%Y%m%d%H%M%S)"

nodes="$("$KUBECTL" --context "$CTX" get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"
if [ -z "$nodes" ]; then
  echo "FATAL: no nodes returned — refusing to report a pass from an empty set" >&2
  exit 1
fi

echo "== node-pressure-probe: context=$CTX namespace=$NS =="
echo "nodes: $(echo "$nodes" | tr '\n' ' ')"
echo

jobs=""
for n in $nodes; do
  safe="$(echo "$n" | tr -c 'a-z0-9-' '-' | sed 's/^-*//;s/-*$//')"
  job="nodeprobe-${safe}-${STAMP}"
  jobs="$jobs $job"
  "$KUBECTL" --context "$CTX" apply -f - >/dev/null 2>&1 <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job}
  namespace: ${NS}
  labels: { app: node-pressure-probe }
spec:
  ttlSecondsAfterFinished: 300
  backoffLimit: 0
  template:
    metadata:
      labels: { app: node-pressure-probe }
    spec:
      restartPolicy: Never
      nodeName: ${n}
      tolerations:
        - operator: Exists
      automountServiceAccountToken: false
      containers:
        - name: probe
          image: ${PROBE_IMAGE}
          securityContext:
            runAsNonRoot: false
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: proc, mountPath: /hostproc, readOnly: true }
          command: ["/bin/sh","-c"]
          args:
            - |
              echo "NODE=${n}"
              echo "--- /proc/pressure (some avg10 avg60 avg300 = % of time >=1 task stalled) ---"
              for f in cpu io memory; do
                if [ -r /hostproc/pressure/\$f ]; then
                  echo "\$f: \$(cat /hostproc/pressure/\$f | tr '\n' ' ')"
                else
                  echo "\$f: UNREADABLE"
                fi
              done
              echo "--- meminfo (KiB) ---"
              grep -E '^(MemTotal|MemFree|MemAvailable|Cached|Buffers|Dirty|Writeback|SReclaimable):' /hostproc/meminfo
              echo "--- vmstat: reclaim + paging ---"
              grep -E '^(pgscan_kswapd|pgscan_direct|pgsteal_kswapd|pgsteal_direct|pgmajfault|pswpin|pswpout|allocstall_normal) ' /hostproc/vmstat
              echo "--- conntrack (a full/large table slows programming for each new pod) ---"
              for f in nf_conntrack_count nf_conntrack_max; do
                [ -r /hostproc/sys/net/netfilter/\$f ] && echo "\$f: \$(cat /hostproc/sys/net/netfilter/\$f)" || echo "\$f: UNREADABLE"
              done
              echo "--- sockets in use ---"
              [ -r /hostproc/net/sockstat ] && cat /hostproc/net/sockstat || echo "sockstat: UNREADABLE"
              echo "--- loadavg / procs ---"
              cat /hostproc/loadavg
              echo "--- cpu: total steal/iowait since boot (jiffies) ---"
              head -1 /hostproc/stat
      volumes:
        - name: proc
          hostPath: { path: /proc, type: Directory }
EOF
done

echo "waiting for probes to finish..."
for j in $jobs; do
  "$KUBECTL" --context "$CTX" -n "$NS" wait --for=condition=complete --timeout=120s "job/$j" >/dev/null 2>&1 \
    || echo "WARN: $j did not report complete within 120s (output below may be partial)"
done

echo
for j in $jobs; do
  echo "=================================================================="
  "$KUBECTL" --context "$CTX" -n "$NS" logs "job/$j" 2>&1 || echo "no logs for $j"
done
echo "=================================================================="
echo "Jobs are reaped by the cluster (ttlSecondsAfterFinished=300); nothing to delete."
