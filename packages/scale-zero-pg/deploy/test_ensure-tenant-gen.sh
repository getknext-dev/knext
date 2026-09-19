#!/usr/bin/env bash
# test_ensure-tenant-gen.sh — off-cluster unit test for the read-before-attach
# generation logic (T1, issue #1095). Runs WITHOUT a cluster.
#
# The bug it pins: both attach paths (55-storage-init.yaml and
# provision-app.sh:ensure_tenant) used to POST a HARDCODED
# {"mode":"AttachedSingle","generation":1,...} to the pageserver's
# /v1/tenant/<T>/location_config. After ANY pswatcher failover the pageserver's
# generation for that tenant advances (->2, ->3...), so it REJECTS the lower
# generation ("Generation 00000001 is less than existing N") and the attach path
# wedges permanently.
#
# The fix (read-before-write, Option A): read the pageserver's OWN current
# generation via GET /v1/tenant/<T> ("generation": N) and re-assert THAT
# generation on the location_config PUT — never downgrade to a literal 1, and
# never invent a higher one (advancing the generation is pswatcher's job on
# failover). A fresh/unattached tenant (curl -sf fails => empty body) starts at 1.
#
# It does NOT re-implement the logic: it SOURCES the shipped provision-app.sh
# (source-guard skips CLI dispatch), stubs PS() to feed fixture GET responses and
# capture the generation the PUT actually emits, and asserts on that. So editing
# ensure_tenant / resolve_attach_generation in provision-app.sh changes this
# test's result — that is what makes it mutation-provable.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# shellcheck disable=SC1090
PROVISION_APP_SOURCED=1 . "$PROV"
set +e  # ensure_tenant inherits set -e; the harness inspects results directly.

# ---------------------------------------------------------------------------
# Part 1: resolve_attach_generation — the pure parser. Feed it a GET body and
# assert the generation it resolves.
check_resolve() {
  local body="$1" want="$2" label="$3" got
  got="$(resolve_attach_generation "$body")"
  [ "$got" = "$want" ] || fail "$label: resolve_attach_generation gave '$got', want '$want'"
  pass=$((pass + 1)); echo "ok - resolve $label -> $got"
}
check_resolve '' 1 "empty body (fresh/404 tenant)"
check_resolve '{"id":"abc","generation":1,"state":"Active"}' 1 "attached at gen 1"
check_resolve '{"id":"abc","generation":2,"state":"Active"}' 2 "attached at gen 2 (post-failover)"
check_resolve '{"generation": 7, "id":"abc"}' 7 "attached at gen 7 (spaced json)"
check_resolve '{"generation":12,"id":"abc"}' 12 "attached at gen 12 (multi-digit)"

# ---------------------------------------------------------------------------
# Part 2: ensure_tenant end-to-end with a stubbed pageserver. The stub returns
# the fixture body on the GET and records the generation on the PUT.
PUT_GEN=""; GET_BODY=""
PS() {
  case "$*" in
    *"-X PUT"*)
      # capture the generation from the -d payload
      for a in "$@"; do
        case "$a" in
          *'"generation"'*) PUT_GEN="$(printf '%s' "$a" | tr ',' '\n' | grep '"generation"' | head -1 | tr -dc '0-9')";;
        esac
      done
      return 0;;
    *)
      printf '%s' "$GET_BODY"; return 0;;
  esac
}
log() { :; }  # silence

run_ensure() {
  GET_BODY="$1"; PUT_GEN=""
  ensure_tenant >/dev/null 2>&1
}

# Fresh tenant: GET returns nothing (curl -sf would fail => empty) -> attach at 1.
run_ensure ''
[ "$PUT_GEN" = "1" ] || fail "fresh tenant: ensure_tenant attached at '$PUT_GEN', want 1"
pass=$((pass + 1)); echo "ok - ensure_tenant fresh tenant attaches at generation 1"

# Post-failover tenant: pageserver reports generation 2 -> attach at 2, NOT 1.
run_ensure '{"id":"apps","generation":2,"state":"AttachedSingle"}'
[ "$PUT_GEN" = "2" ] || fail "post-failover tenant: ensure_tenant attached at '$PUT_GEN', want 2 (the #1095 wedge — a literal 1 would be rejected)"
pass=$((pass + 1)); echo "ok - ensure_tenant post-failover attaches at the CURRENT generation 2"

# Further-advanced tenant: generation 5 -> attach at 5.
run_ensure '{"id":"apps","generation":5,"state":"AttachedSingle"}'
[ "$PUT_GEN" = "5" ] || fail "advanced tenant: ensure_tenant attached at '$PUT_GEN', want 5"
pass=$((pass + 1)); echo "ok - ensure_tenant attaches at generation 5"

echo "PASS ($pass checks) — read-before-attach never emits a literal generation:1"
