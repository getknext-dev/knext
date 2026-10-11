#!/usr/bin/env bash
# Assertions for the spec.networking.publicHosts kind e2e: a NextApp deployed
# with `networking.publicHosts` gets KNEXT_PUBLIC_ORIGINS rendered by the
# operator, the running pod carries it, and a route handler that redirects with
# `new URL('/x', request.url)` answers the PUBLIC host through Kourier instead
# of `http://0.0.0.0:PORT`.
#
# Shared by .github/workflows/public-hosts-kind-e2e.yml and a local run against
# any kind cluster that already has the operator, Knative and Kourier:
#
#   scripts/public-hosts-e2e-assert.sh <namespace> <nextapp-name> <host> [<host> ...]
#
# The hosts are the ones in the config's `networking.publicHosts`, in order; the
# FIRST is the fallback origin the redirect must carry when no request header
# names an allowlisted host.
#
# Fail-closed throughout: every check exits non-zero with an ::error:: line, and
# an empty / unreadable value is a failure, never a pass.
set -euo pipefail

NS="${1:?usage: public-hosts-e2e-assert.sh <namespace> <nextapp-name> <host> [<host> ...]}"
APP="${2:?missing nextapp name}"
shift 2
[ "$#" -ge 1 ] || { echo "::error::need at least one public host" >&2; exit 2; }
HOSTS=("$@")
FIRST="${HOSTS[0]}"
SECOND="${HOSTS[1]:-}"

# Local port for the Kourier port-forward (override when 8080 is taken).
PF_PORT="${PF_PORT:-8080}"

fail() { echo "::error::$*" >&2; exit 1; }

want_env=""
for h in "${HOSTS[@]}"; do
  want_env="${want_env:+${want_env},}https://${h}"
done

# 1. The CR carries the field the CLI sent.
cr_hosts="$(kubectl -n "$NS" get nextapp "$APP" -o jsonpath='{range .spec.networking.publicHosts[*]}{@}{"\n"}{end}')"
[ -n "$cr_hosts" ] || fail "nextapp/$APP has no spec.networking.publicHosts"
got_cr="$(printf '%s' "$cr_hosts" | paste -sd, -)"
want_cr="$(IFS=,; echo "${HOSTS[*]}")"
[ "$got_cr" = "$want_cr" ] || fail "spec.networking.publicHosts is '$got_cr', want '$want_cr'"
echo "ok: CR spec.networking.publicHosts = $got_cr"

# 2. The operator rendered KNEXT_PUBLIC_ORIGINS on the Knative Service, exactly
#    once, in list order.
env_json="$(kubectl -n "$NS" get ksvc "$APP" -o jsonpath='{.spec.template.spec.containers[0].env}')"
[ -n "$env_json" ] || fail "ksvc/$APP has no container env"
count="$(printf '%s' "$env_json" | jq '[.[] | select(.name=="KNEXT_PUBLIC_ORIGINS")] | length')"
[ "$count" = "1" ] || fail "ksvc/$APP has $count KNEXT_PUBLIC_ORIGINS entries, want exactly 1"
got_env="$(printf '%s' "$env_json" | jq -r '.[] | select(.name=="KNEXT_PUBLIC_ORIGINS") | .value')"
[ "$got_env" = "$want_env" ] || fail "ksvc KNEXT_PUBLIC_ORIGINS is '$got_env', want '$want_env'"
echo "ok: ksvc KNEXT_PUBLIC_ORIGINS = $got_env"

# 3. Reach the app through the cluster's Kourier gateway.
kubectl -n kourier-system port-forward svc/kourier-internal "${PF_PORT}:80" >/tmp/pf-kourier-public-hosts.log 2>&1 &
PF_PID=$!
trap 'kill "$PF_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/${PF_PORT}) 2>/dev/null; then break; fi
  sleep 1
done
ksvc_host="$(kubectl -n "$NS" get nextapp "$APP" -o jsonpath='{.status.url}' | sed -E 's#^https?://##')"
[ -n "$ksvc_host" ] || fail "nextapp/$APP status.url is empty"

# Headers of GET /go, one `Location:` per response, after waking the app.
location() { # [extra curl args...]
  curl -s -o /dev/null -D - --max-time 60 -H "Host: ${ksvc_host}" "$@" "http://127.0.0.1:${PF_PORT}/go" \
    | tr -d '\r' | awk 'tolower($1)=="location:" {print $2}'
}

# The wake request can race the pod's readiness behind Kourier; retry briefly.
loc=""
for _ in $(seq 1 20); do
  loc="$(location || true)"
  [ -n "$loc" ] && break
  sleep 3
done
[ -n "$loc" ] || fail "GET /go through Kourier returned no Location header"

# 4. The pod that served it carries the variable.
pod="$(kubectl -n "$NS" get pods -l "serving.knative.dev/service=${APP}" -o jsonpath='{.items[0].metadata.name}')"
[ -n "$pod" ] || fail "no pod for ksvc/$APP after the request"
pod_env="$(kubectl -n "$NS" get pod "$pod" -o jsonpath='{.spec.containers[?(@.name=="user-container")].env}')"
pod_val="$(printf '%s' "$pod_env" | jq -r '.[] | select(.name=="KNEXT_PUBLIC_ORIGINS") | .value')"
[ "$pod_val" = "$want_env" ] || fail "pod $pod KNEXT_PUBLIC_ORIGINS is '$pod_val', want '$want_env'"
echo "ok: pod $pod KNEXT_PUBLIC_ORIGINS = $pod_val"

# 5. The redirect answers the public host over https, never the bind address.
#    The scheme comes from the `https://<host>` entry the operator renders; no
#    request header changes it. Kourier's plain-HTTP listener sets
#    `X-Forwarded-Proto: http`, so these checks also prove the header is ignored.
echo "GET /go (no forwarding headers) -> Location: $loc"
case "$loc" in *0.0.0.0*) fail "Location still carries the bind address: $loc" ;; esac
[ "$loc" = "https://${FIRST}/article/one?from=go" ] \
  || fail "Location is '$loc', want https://${FIRST}/article/one?from=go (the first publicHosts entry, over https)"
echo "ok: /go -> $loc"

# A client cannot downgrade the scheme with its own X-Forwarded-Proto.
loc_proto="$(location -H 'X-Forwarded-Proto: http')"
echo "GET /go (X-Forwarded-Proto: http) -> Location: $loc_proto"
[ "$loc_proto" = "https://${FIRST}/article/one?from=go" ] \
  || fail "X-Forwarded-Proto: http gave '$loc_proto', want https://${FIRST}/article/one?from=go"
echo "ok: X-Forwarded-Proto cannot downgrade the scheme"

# An allowlisted X-Forwarded-Host selects that entry (when there is a second).
if [ -n "$SECOND" ]; then
  loc2="$(location -H "X-Forwarded-Host: ${SECOND}")"
  echo "GET /go (X-Forwarded-Host: ${SECOND}) -> Location: $loc2"
  [ "$loc2" = "https://${SECOND}/article/one?from=go" ] \
    || fail "allowlisted X-Forwarded-Host gave '$loc2', want https://${SECOND}/article/one?from=go"
  echo "ok: allowlisted X-Forwarded-Host picks its own entry"
fi

# A forged host is only ever a key into the list: it falls back to the first.
loc3="$(location -H 'X-Forwarded-Host: evil.example.net')"
echo "GET /go (X-Forwarded-Host: evil.example.net) -> Location: $loc3"
[ "$loc3" = "https://${FIRST}/article/one?from=go" ] \
  || fail "forged X-Forwarded-Host gave '$loc3', want the fallback https://${FIRST}/article/one?from=go"
echo "ok: a forged X-Forwarded-Host never reaches Location"

# 6. The preload announced its allowlist at boot.
logs="$(kubectl -n "$NS" logs "$pod" -c user-container --tail=-1 2>&1 || true)"
want_log="PUBLIC_ORIGINS:${want_env} (env)"
printf '%s\n' "$logs" | grep -qF "$want_log" \
  || { printf '%s\n' "$logs" | tail -n 30 >&2; fail "pod log has no '${want_log}' line"; }
echo "ok: ${want_log}"

echo "public-hosts e2e: all assertions passed"
