#!/usr/bin/env bash
# _verify-pswatcher-capability.sh — D9 RUNNING-BINARY capability drill.
#
# WHY THIS EXISTS. Every pswatcher lockstep guard in _validate.sh pins the manifest to a
# SOURCE constant (PSW_MAX_FREEZE_MS↔DefaultMaxFreezeDuration, PSW_APPS_TENANT_ID↔83,
# PSW_PRIMARY_CONTAINER↔53). Those checks stay GREEN on a manifest that runs a STALE
# image which ignores the env — at one sprint close 58-pswatcher.yaml still pinned a
# pre-capability image and every source check passed. The only way to catch that is to
# ask the DEPLOYED binary what it can do, not the source tree. This drill scrapes
# pswatcher_build_info off the live pod and asserts the running binary advertises the
# routed-set (#1098) and freeze (#1099) capabilities. A stale image — built before those
# feature entries existed in metrics.go — cannot emit them, so it REDS here.
#
# This is the manifest↔running-binary link; _validate.sh's source locksteps are the
# manifest↔source half. Both are needed: source can be right while the image is stale.
#
# Usage:
#   deploy/_verify-pswatcher-capability.sh run
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg),
#      PSW_METRICS_PORT (default 9091), REQUIRE_FEATURES (default "routed-set freeze").
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
PSW_METRICS_PORT="${PSW_METRICS_PORT:-9091}"
REQUIRE_FEATURES="${REQUIRE_FEATURES:-routed-set freeze}"
K="kubectl --context=$KCTX -n $NS"

FAILS=0
ok()   { printf '  ok   - %s\n' "$1"; }
bad()  { printf '  FAIL - %s\n' "$1"; FAILS=$((FAILS+1)); }
info() { printf '  ..   - %s\n' "$1"; }

# psw_metrics — scrape pswatcher /metrics through a standby-pod curl (the metrics Service
# is ClusterIP-only, never LB-fronted — same trick as the failover-freeze drill).
psw_metrics() {
  _ip="$($K get pod -l app=pswatcher -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || echo '')"
  [ -z "$_ip" ] && { echo ''; return; }
  $K exec sts/pageserver-standby -- curl -s --max-time 10 "http://$_ip:${PSW_METRICS_PORT}/metrics" 2>/dev/null || echo ''
}

# build_info_features METRICS — the value of the features="..." label on the
# pswatcher_build_info sample, or empty if the gauge is absent (a stale binary).
build_info_features() {
  printf '%s\n' "$1" | sed -n 's/^pswatcher_build_info{.*features="\([^"]*\)".*} .*/\1/p' | head -1
}
build_info_version() {
  printf '%s\n' "$1" | sed -n 's/^pswatcher_build_info{.*version="\([^"]*\)".*} .*/\1/p' | head -1
}

run() {
  echo "=== D9 pswatcher running-binary capability drill — ns=$NS ctx=$KCTX ==="
  $K get deploy pswatcher >/dev/null 2>&1 || { bad "pswatcher not deployed in $NS"; exit 1; }

  M="$(psw_metrics)"
  [ -z "$M" ] && { bad "could not scrape pswatcher /metrics"; exit 1; }

  # (1) The gauge must exist at all. Its ABSENCE is the stale-image signal: a
  # pre-capability binary has no pswatcher_build_info line.
  if ! printf '%s\n' "$M" | grep -q '^pswatcher_build_info{'; then
    bad "pswatcher_build_info gauge ABSENT — the deployed binary predates the D9 capability signal (STALE IMAGE). Re-pin 58-pswatcher.yaml to a build that carries it."
    echo "=== D9 capability drill: $FAILS failure(s) ==="; exit 1
  fi
  ver="$(build_info_version "$M")"
  ok "pswatcher_build_info present (version=${ver:-<unset>})"

  # (2) The running binary must advertise every required capability.
  feats="$(build_info_features "$M")"
  info "deployed features: ${feats:-<none>}"
  for want in $REQUIRE_FEATURES; do
    # comma-delimited exact-token match (never a substring of another feature).
    if printf '%s' ",$feats," | grep -q ",$want,"; then
      ok "running binary advertises capability '$want'"
    else
      bad "running binary does NOT advertise '$want' (features=${feats:-<none>}) — the deployed image lacks this capability (stale/wrong build)"
    fi
  done

  echo "=== D9 capability drill: $FAILS failure(s) ==="
  [ "$FAILS" -eq 0 ] || exit 1
}

case "${1:-run}" in
  run) run ;;
  *) echo "usage: $0 run" >&2; exit 2 ;;
esac
