#!/usr/bin/env bash
# PostToolUse / Edit|Write — advisory (exit 0 always). Service-Worker / caching config that caches
# auth endpoints or mutation routes is a correctness AND security bug (stale auth, replayed/served
# mutations). The pwa-zones caching matrix makes those routes network-only. Warn — don't block —
# because cache config is nuanced and the author may have already excluded them.
set -uo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
content=$(printf '%s' "$input" | jq -r '.tool_input.new_string // .tool_input.content // ""' 2>/dev/null || echo "")
[ -z "$content" ] && exit 0

# Only look at files that plausibly configure a Service Worker / runtime cache.
is_sw=0
case "$path" in
  *sw.*|*service-worker*|*serwist*|*workbox*) is_sw=1 ;;
esac
if [ "$is_sw" -eq 0 ] && printf '%s' "$content" | grep -qiE 'runtimeCaching|registerRoute|CacheFirst|StaleWhileRevalidate|precache|workbox|serwist'; then
  is_sw=1
fi
[ "$is_sw" -eq 0 ] && exit 0

# Does a caching rule mention an auth or mutation surface?
if printf '%s' "$content" | grep -qiE '/(login|logout|auth|session|token|signin|sign-in|oauth)|method[^a-z]*[:=][^a-z]*["'"'"']?(POST|PUT|PATCH|DELETE)|mutation'; then
  echo "ADVISORY (guard-sw-cache-policy / pwa-zones): this Service-Worker/caching config references
auth or mutation routes. Per the pwa-zones caching matrix, auth endpoints and ALL mutations must be
NETWORK-ONLY — never cached (stale-auth + replayed-mutation hazard). Confirm these routes are
excluded from cache strategies (cache-first / SWR / precache). See .claude/rules/scs-zones.md +
security.md." >&2
fi
exit 0
