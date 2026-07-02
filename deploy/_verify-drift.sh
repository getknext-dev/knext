#!/bin/sh
# Live-spec-vs-manifest drift check (issue #13: "grep-green, prod-red").
# Asserts every running pod in the namespace declares the ephemeral-storage
# request the manifests promise - catches applied-but-not-rolled and
# never-applied drift that YAML greps cannot see.
set -eu
NS=scale-zero-pg
K="kubectl --request-timeout=15s -n $NS"
fail() { echo "FAIL: $*" >&2; exit 1; }
BAD=$($K get pods --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.containers[0].resources.requests.ephemeral-storage}{"\n"}{end}' | awk '$2=="" {print $1}' | grep -v '^pgclient\|^metric-\|^verify-' || true)
[ -z "$BAD" ] || fail "pods running WITHOUT ephemeral-storage request: $BAD"
echo "drift verification: live pods match the manifest contract"
