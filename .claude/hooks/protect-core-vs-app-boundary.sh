#!/usr/bin/env bash
# PostToolUse / Edit|Write — advisory (exit 0 always). SEQUENCING guard, not a permanent verdict.
# knext's END GOAL is to own zone generation + MFE isolation + the PWA layer (full-stack SCS goal).
# But until the framework absorbs them — i.e. during the adapter-migration + Tier-A correctness
# phase — Service-Worker / SWI / BroadcastChannel / Module-Federation RUNTIME code belongs in the
# app-level pwa-zones template, not core packages. Warn (don't block) if it lands in core early.
set -uo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
content=$(printf '%s' "$input" | jq -r '.tool_input.new_string // .tool_input.content // ""' 2>/dev/null || echo "")
[ -z "$path" ] && exit 0

# Is this a core package (not the app template)?
case "$path" in
  *packages/kn-next/*|*packages/cli/*|*packages/kn-next-operator/*) : ;;
  *) exit 0 ;;
esac

# Does the content carry micro-frontend / PWA-stitch runtime machinery?
if printf '%s' "$content" | grep -qiE 'serviceWorker|service-worker|navigator\.serviceWorker|serwist|workbox|BroadcastChannel|Service Worker Includes|\bSWI\b|module[- ]?federation|ModuleFederation|navigation\.intercept|NavigateEvent'; then
  echo "ADVISORY (protect-core-vs-app-boundary / scs-zones): this file is in a knext CORE package but
contains Service-Worker / SWI / BroadcastChannel / Module-Federation runtime code. This is knext's
END GOAL (the framework will generate/own zone isolation + PWA) — but it's a SEQUENCING guard: until
the adapter migration + Tier-A correctness land, keep this runtime code in the app-level pwa-zones
template, not core (packages/kn-next, packages/cli, the operator). If you're intentionally promoting
it into the framework now, that's a phase decision — confirm it's the right time. See
.claude/rules/scs-zones.md + the pwa-zones skill." >&2
fi
exit 0
