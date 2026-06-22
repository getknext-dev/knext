#!/usr/bin/env bash
#
# scripts/load-test.sh — k6 load-test runbook entrypoint (#30, salvaged from PR #10).
#
# This is a MANUAL / NIGHTLY operability tool, NOT a PR gate. It generates a k6
# ConfigMap + Job (packages/kn-next/src/generators/loadtest-job.ts) and applies it
# against a running Knative ksvc URL. The `scale-to-zero` scenario exercises a cold
# start and ties to apps/file-manager/docs/coldstart-bench-kind.md.
#
# Runbook: apps/file-manager/docs/loadtest-runbook.md
#
# Usage:
#   scripts/load-test.sh --url <ksvc-url> [--type smoke|load|spike|scale-to-zero] [--namespace <ns>]
#
# Env:
#   TYPE        default scenario (overridden by --type), default "smoke"
#   NAMESPACE   default namespace (overridden by --namespace), default "default"
#
set -euo pipefail

URL=""
TYPE="${TYPE:-smoke}"
NAMESPACE="${NAMESPACE:-default}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url|-u)        URL="$2"; shift 2 ;;
    --type|-t)       TYPE="$2"; shift 2 ;;
    --namespace|-n)  NAMESPACE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$URL" ]]; then
  echo "Error: --url <ksvc URL> is required (the Knative service URL)." >&2
  echo "Tip: kubectl get ksvc -n $NAMESPACE -o jsonpath='{.items[0].status.url}'" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Delegate to the kn-next loadtest CLI (Node-bundled at dist/cli/loadtest.js, or
# run from source via the package script during development).
echo "[load-test] target=$URL type=$TYPE namespace=$NAMESPACE"
node "${REPO_ROOT}/packages/kn-next/dist/cli/loadtest.js" \
  --url "$URL" --type "$TYPE" --namespace "$NAMESPACE"
