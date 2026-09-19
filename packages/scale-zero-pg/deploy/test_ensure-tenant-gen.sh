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
# The fix (read-before-write): attach at max(ledger, pageserver-current-view, 1),
# where the DURABLE `pageserver-generation` ConfigMap ledger (seeded/advanced by
# pswatcher) is the AUTHORITY. Reading the ledger survives a pageserver restart or a
# fresh PVC; reading the pageserver's own view does not (a fresh-PVC pageserver 404s
# the tenant while its object-store index is at the ledger generation, so attaching
# at the pageserver's empty view alone would silently pick 1 and hide the index —
# data loss). We never attach BELOW the ledger; we only READ it (advancing it is
# pswatcher's job on failover). A truly fresh tenant/plane (no ledger, no local
# attach) starts at 1.
#
# It does NOT re-implement the logic:
#   - Part 1/2 SOURCE the shipped provision-app.sh (source-guard skips CLI dispatch)
#     and exercise resolve_attach_generation / ensure_tenant against fixtures.
#   - Part 4 EXTRACTS the storage-init inline generation-decision lines out of
#     55-storage-init.yaml and runs THEM, so the init-container copy is covered too
#     (not kept in sync by grep alone).
# Editing the logic in either shipped file changes this test's result — that is what
# makes it mutation-provable.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
SI="$HERE/55-storage-init.yaml"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# shellcheck disable=SC1090
PROVISION_APP_SOURCED=1 . "$PROV"
set +e  # ensure_tenant inherits set -e; the harness inspects results directly.

# ---------------------------------------------------------------------------
# Part 1: resolve_attach_generation(pageserver_body, ledger) = max(psgen, ledger, 1).
check_resolve() {
  local body="$1" ledger="$2" want="$3" label="$4" got
  got="$(resolve_attach_generation "$body" "$ledger")"
  [ "$got" = "$want" ] || fail "$label: resolve_attach_generation('$body','$ledger') gave '$got', want '$want'"
  pass=$((pass + 1)); echo "ok - resolve $label -> $got"
}
# floor + fresh cases
check_resolve '' '' 1 "empty body + no ledger (fresh plane)"
check_resolve '{"id":"abc","generation":1,"state":"Active"}' '1' 1 "attached at gen 1, ledger 1"
# pageserver ahead of ledger -> pageserver wins
check_resolve '{"generation":5}' '3' 5 "pageserver ahead of ledger (5 vs 3)"
# ledger ahead of pageserver -> LEDGER wins (the silent-data-loss guard)
check_resolve '{"generation":2}' '3' 3 "LEDGER ahead of pageserver (3 vs 2)"
# THE hazard: fresh-PVC pageserver 404s (empty body) but ledger says 3 -> attach at 3, NOT 1
check_resolve '' '3' 3 "fresh-PVC pageserver (404) + ledger 3 -> 3, never 1 (silent-loss guard)"
# ledger present, pageserver fresh, higher ledger
check_resolve '' '12' 12 "ledger 12, pageserver fresh -> 12"
# spaced json still parses the generation field
check_resolve '{"generation": 7, "id":"abc"}' '' 7 "spaced json, no ledger -> 7"

# ---------------------------------------------------------------------------
# Part 3 (response-shape pin): the logic depends on the field name `generation` and
# the ledger being a bare integer. A RENAMED field must NOT be picked up (it would
# silently degrade every attach to the ledger/1 floor and the wedge would return
# green). Pin it here, off-cluster.
check_resolve '{"gen":9}' '' 1 "renamed field \"gen\" is NOT read as generation (shape pin)"
check_resolve '{"generationX":9}' '' 1 "\"generationX\" is NOT read as generation (shape pin)"
# The live pageserver DID emit exactly {"generation": N}; the canonical form resolves.
check_resolve '{"generation":4}' '' 4 "canonical {\"generation\":N} shape resolves (shape pin)"

# ---------------------------------------------------------------------------
# Part 2: ensure_tenant end-to-end with a stubbed pageserver + stubbed ledger. The
# PS stub returns the fixture body on the GET and records the generation on the PUT;
# ledger_generation is overridden to feed the fixture ledger value.
PUT_GEN=""; GET_BODY=""; LEDGER_VAL=""
ledger_generation() { printf '%s' "$LEDGER_VAL"; }
PS() {
  case "$*" in
    *"-X PUT"*)
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
  GET_BODY="$1"; LEDGER_VAL="$2"; PUT_GEN=""
  ensure_tenant >/dev/null 2>&1
}

# Fresh tenant, no ledger -> attach at 1.
run_ensure '' ''
[ "$PUT_GEN" = "1" ] || fail "fresh tenant: ensure_tenant attached at '$PUT_GEN', want 1"
pass=$((pass + 1)); echo "ok - ensure_tenant fresh tenant attaches at generation 1"

# Post-failover: pageserver reports 2, ledger 2 -> attach at 2, NOT 1.
run_ensure '{"id":"apps","generation":2}' '2'
[ "$PUT_GEN" = "2" ] || fail "post-failover: ensure_tenant attached at '$PUT_GEN', want 2 (a literal 1 would be rejected)"
pass=$((pass + 1)); echo "ok - ensure_tenant post-failover attaches at 2"

# THE silent-loss guard end-to-end: pageserver on a fresh PVC 404s (empty body) but
# the durable ledger says 3 -> ensure_tenant MUST attach at 3, never 1.
run_ensure '' '3'
[ "$PUT_GEN" = "3" ] || fail "fresh-PVC pageserver + ledger 3: ensure_tenant attached at '$PUT_GEN', want 3 (attaching at 1 would hide the gen-3 index — silent data loss)"
pass=$((pass + 1)); echo "ok - ensure_tenant honours the durable ledger over a fresh-PVC pageserver (3, not 1)"

# ---------------------------------------------------------------------------
# Part 4: the storage-init INLINE copy. Extract its generation-decision lines from
# 55-storage-init.yaml and run them with fixture LEDGER/PSGEN — so the init-container
# copy is proven equivalent, not merely grep-checked for a literal.
si_gen() {
  local LEDGER="$1" PSGEN="$2" GEN prog
  prog="$(grep -E 'GEN=1$|-gt "\$GEN" \] && GEN=' "$SI" | sed 's/^[[:space:]]*//')"
  # 3 lines expected: GEN=1, the LEDGER bump, the PSGEN bump.
  [ "$(printf '%s\n' "$prog" | grep -c .)" -eq 3 ] || { echo "EXTRACT_FAILED"; return 1; }
  eval "$prog"
  echo "$GEN"
}
check_si() {
  local ledger="$1" psgen="$2" want="$3" label="$4" got
  got="$(si_gen "$ledger" "$psgen")"
  [ "$got" = "$want" ] || fail "storage-init inline $label: got '$got', want '$want'"
  pass=$((pass + 1)); echo "ok - storage-init inline $label -> $got"
}
check_si '' '' 1 "fresh (no ledger, pageserver 404)"
check_si '3' '' 3 "fresh-PVC pageserver + ledger 3 -> 3 (silent-loss guard)"
check_si '2' '5' 5 "pageserver ahead (5 vs ledger 2)"
check_si '3' '2' 3 "ledger ahead (3 vs pageserver 2)"

echo "PASS ($pass checks) — read-before-attach honours the durable ledger; no attach path emits a literal generation:1 or attaches below the ledger"
