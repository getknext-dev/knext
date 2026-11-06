#!/usr/bin/env bash
# Waits until a node's NEW kubelet has reported, not merely until the node reads Ready.
#
#   wait-kubelet-heartbeat.sh read <context> <node>
#   wait-kubelet-heartbeat.sh wait <context> <node> <heartbeat-before-restart> [timeout-seconds=120]
#
# <context> is a kubeconfig context, always passed to kubectl as `--context`, so the current-context
# of whoever runs this is never relied on. It is required: an empty or missing one is refused.
#
# Why this exists: `kubectl wait` on the Ready condition is satisfied at once after a kubelet restart,
# because the API still holds the OLD kubelet's Ready=True until the node-lifecycle controller
# flips it (measured on kind: 53.6 s, the 40 s grace period plus the monitor interval). It would pass
# for a kubelet that is crash-looping. The new kubelet's first status post moves the Ready condition's
# lastHeartbeatTime (measured on kind: 0.45-0.83 s after a restart), so `wait` waits for that to change
# while Ready is True. Read the heartbeat with `read` IMMEDIATELY before the restart whose effect is
# waited for, and re-read it before every later restart: a heartbeat read before an earlier swap is
# stale by then, because the swapped kubelet has already posted newer ones, and `wait` would pass at once.
#
# lastHeartbeatTime has one-second resolution, so a restart that posts within the same second as the
# previous heartbeat would read as "no change"; the previous heartbeat is minutes old in practice.
# Runs kubectl from the workstation.
#
# Exit codes: 0 success; 1 timeout with kubectl answering (no new heartbeat, or not Ready); 2 usage,
# or kubectl failing (bad context, unreachable API, unknown node): reported as such, never as a timeout.
set -euo pipefail

usage() {
  echo "usage: wait-kubelet-heartbeat.sh read <context> <node>" >&2
  echo "       wait-kubelet-heartbeat.sh wait <context> <node> <heartbeat-before-restart> [timeout-seconds]" >&2
  exit 2
}

MODE="${1:-}"
CTX="${2:-}"
NODE="${3:-}"
case "$MODE" in read | wait) ;; *) usage ;; esac
if [ -z "$CTX" ]; then
  echo "refusing to run without a kubectl context: pass one explicitly (the current-context is never relied on)" >&2
  usage
fi
[ -n "$NODE" ] || usage

ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

# cond <field>: prints the Ready condition's field; returns kubectl's exit status, error text in ERR_FILE
cond() {
  kubectl --context "$CTX" get node "$NODE" \
    -o jsonpath="{.status.conditions[?(@.type==\"Ready\")].$1}" 2>"$ERR_FILE"
}

fail_kubectl() {
  echo "kubectl --context $CTX get node $NODE failed: $(tr '\n' ' ' <"$ERR_FILE")" >&2
  exit 2
}

if [ "$MODE" = read ]; then
  hb="$(cond lastHeartbeatTime)" || fail_kubectl
  if [ -z "$hb" ]; then
    echo "node $NODE has no Ready condition heartbeat" >&2
    exit 2
  fi
  echo "$hb"
  exit 0
fi

BEFORE="${4:-}"
[ -n "$BEFORE" ] || usage
TIMEOUT="${5:-120}"
INTERVAL="${WAIT_KUBELET_HEARTBEAT_INTERVAL:-1}"

# The first lookup must work: a wrong context or node is an error, not a wait.
hb="$(cond lastHeartbeatTime)" || fail_kubectl
st="$(cond status)" || fail_kubectl
last_err=""
end=$((SECONDS + TIMEOUT))
while :; do
  if [ -n "$hb" ] && [ "$hb" != "$BEFORE" ] && [ "$st" = "True" ]; then
    echo "node $NODE: Ready=True with a new heartbeat $hb (was $BEFORE)"
    exit 0
  fi
  if [ "$SECONDS" -ge "$end" ]; then
    if [ -n "$last_err" ]; then
      echo "node $NODE: no new kubelet heartbeat after ${TIMEOUT}s and kubectl was failing at the end: $last_err" >&2
      exit 2
    fi
    echo "node $NODE: no new kubelet heartbeat after ${TIMEOUT}s (heartbeat $hb, was $BEFORE, Ready=$st)" >&2
    exit 1
  fi
  sleep "$INTERVAL"
  last_err=""
  if hb2="$(cond lastHeartbeatTime)" && st2="$(cond status)"; then
    hb="$hb2"
    st="$st2"
  else
    last_err="$(tr '\n' ' ' <"$ERR_FILE")"
  fi
done
