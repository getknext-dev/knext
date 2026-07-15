#!/usr/bin/env sh
# _cleanup.sh — restore the namespace to the normal resting state after the
# warm-standby experiment: compute-warm deleted, warm-client deleted, and the
# production deploy/compute left at 0. Idempotent.
set -eu
NS="${NS:-scale-zero-pg}"
K="kubectl -n $NS"

echo "[cleanup] scaling compute-warm to 0 and deleting experiment objects ..."
$K scale deploy/compute-warm --replicas=0 >/dev/null 2>&1 || true
# wait for the warm pod to fully drain before removing (single-writer hygiene)
d=0; while [ "$($K get pods -l app=compute-warm --no-headers 2>/dev/null | grep -c . || true)" != "0" ]; do
  d=$((d+1)); [ "$d" -gt 60 ] && break; sleep 0.5
done
$K delete -f "$(cd "$(dirname "$0")" && pwd)/20-compute-warm.yaml" --ignore-not-found >/dev/null 2>&1 || true
$K delete -f "$(cd "$(dirname "$0")" && pwd)/10-compute-warm-files.yaml" --ignore-not-found >/dev/null 2>&1 || true
$K delete -f "$(cd "$(dirname "$0")" && pwd)/30-warm-client.yaml" --ignore-not-found >/dev/null 2>&1 || true

echo "[cleanup] ensuring production compute is at 0 ..."
$K scale deploy/compute --replicas=0 >/dev/null 2>&1 || true

echo "[cleanup] done. Remaining warm objects:"
$K get deploy,pods -l app=compute-warm --no-headers 2>/dev/null || true
$K get pod warm-client --no-headers 2>/dev/null || true
echo "[cleanup] production compute replicas: $($K get deploy compute -o jsonpath='{.spec.replicas}' 2>/dev/null)"
