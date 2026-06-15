#!/usr/bin/env bash
# PostToolUse / Edit|Write — ADVISORY only (exit 0, never blocks).
# Reminds that the operator is the single source of truth for cluster state (ADR-0001).
# Promote to a PreToolUse exit-2 block AFTER control-plane consolidation is done.
set -uo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
[ -z "$path" ] && exit 0

case "$path" in
  *cli/deploy.ts|*generators/knative-manifest*|*generators/infrastructure*|*/generators/*manifest*)
    echo "ADR-0001 advisory: the Go operator is the single source of truth for cluster state. The CLI should build/publish and emit a NextApp CR — not generate or apply raw Knative/infra manifests. (non-blocking reminder)" >&2
    ;;
esac
exit 0
