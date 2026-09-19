#!/usr/bin/env bash
# test_ensure-tenant-gen.sh — off-cluster unit test for the read-before-attach
# generation logic (T1, issue #1095). Runs WITHOUT a cluster.
#
# The bug it pins: both attach paths (55-storage-init.yaml and
# provision-app.sh:ensure_tenant) used to POST a HARDCODED generation:1 to the
# pageserver's /v1/tenant/<T>/location_config. After a pswatcher failover the tenant's
# generation advances (->2, ->3...), so a literal 1 is REJECTED and the path wedges.
#
# The fix (read-before-write): attach at max(ledger, pageserver-current-view, 1), where
# the durable `pageserver-generation` ConfigMap ledger (seeded to 1 by deploy/57,
# advanced by pswatcher) is the AUTHORITY, and — crucially — FAIL CLOSED: an unreadable
# ledger (kubectl/RBAC error, missing CM, empty/non-numeric key, or an unmounted
# /ledger in the init container) REFUSES the attach rather than silently flooring to 1.
# Flooring below a possible object-store index is the silent-data-loss failure; a loud
# refusal is recoverable via the runbook.
#
# It does NOT re-implement the logic:
#   - Part 1/2/3 SOURCE the shipped provision-app.sh (source-guard skips CLI dispatch)
#     and exercise resolve_attach_generation / ledger_generation / ensure_tenant.
#   - Part 4 EXTRACTS the storage-init inline generation-decision lines out of
#     55-storage-init.yaml and runs THEM, so the init-container copy is covered too.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
SI="$HERE/55-storage-init.yaml"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# shellcheck disable=SC1090
PROVISION_APP_SOURCED=1 . "$PROV"
set +e  # provision-app.sh sets -e; the harness inspects non-zero results directly.

# ---------------------------------------------------------------------------
# Part 1: resolve_attach_generation(pageserver_body, ledger) = max(psgen, ledger, 1).
check_resolve() {
  local body="$1" ledger="$2" want="$3" label="$4" got
  got="$(resolve_attach_generation "$body" "$ledger")"
  [ "$got" = "$want" ] || fail "$label: resolve_attach_generation('$body','$ledger') gave '$got', want '$want'"
  pass=$((pass + 1)); echo "ok - resolve $label -> $got"
}
check_resolve '{"id":"abc","generation":1}' '1' 1 "attached at gen 1, ledger 1"
check_resolve '{"generation":5}' '3' 5 "pageserver ahead of ledger (5 vs 3)"
check_resolve '{"generation":2}' '3' 3 "LEDGER ahead of pageserver (3 vs 2)"
# THE hazard: fresh-PVC pageserver 404s (empty body) but ledger says 3 -> attach at 3.
check_resolve '' '3' 3 "fresh-PVC pageserver (404) + ledger 3 -> 3, never 1 (silent-loss guard)"
check_resolve '' '12' 12 "ledger 12, pageserver fresh -> 12"
# response-shape pin: a RENAMED pageserver field must NOT be read as generation.
check_resolve '{"gen":9}' '1' 1 "renamed field \"gen\" is NOT read as generation (shape pin)"
check_resolve '{"generation":4}' '1' 4 "canonical {\"generation\":N} shape resolves (shape pin)"

# ---------------------------------------------------------------------------
# Part 3: ledger_generation FAIL-CLOSED. Stub K() to simulate kubectl outcomes.
# rc 0 + number = usable; rc 3 = REFUSE (error / missing CM / empty / non-numeric).
_K_OUT=""; _K_RC=0
K() { printf '%s' "$_K_OUT"; return "$_K_RC"; }
check_ledger() {
  local out="$1" krc="$2" want_echo="$3" want_rc="$4" label="$5" got grc
  _K_OUT="$out"; _K_RC="$krc"
  got="$(ledger_generation)"; grc=$?
  [ "$grc" = "$want_rc" ] || fail "ledger $label: rc=$grc, want $want_rc"
  [ "$got" = "$want_echo" ] || fail "ledger $label: echo='$got', want '$want_echo'"
  pass=$((pass + 1)); echo "ok - ledger $label -> echo='$got' rc=$grc"
}
check_ledger '5'  0 '5' 0 "present numeric -> use 5"
check_ledger '1'  0 '1' 0 "present numeric -> use 1"
check_ledger ''   0 ''  3 "CM present but key EMPTY -> REFUSE (rc 3)"
check_ledger 'abc' 0 '' 3 "non-numeric key -> REFUSE (rc 3)"
check_ledger ''   1 ''  3 "kubectl error / CM NotFound -> REFUSE (rc 3)"

# ---------------------------------------------------------------------------
# Part 2: ensure_tenant end-to-end. PS stub records the PUT generation; the ledger is
# fed via the K() stub above (ensure_tenant -> ledger_generation -> K).
PUT_GEN_FILE="$(mktemp)"; GET_BODY=""
trap 'rm -f "$PUT_GEN_FILE"' EXIT
PS() {
  case "$*" in
    *"-X PUT"*)
      for a in "$@"; do
        case "$a" in
          *'"generation"'*) printf '%s' "$a" | tr ',' '\n' | grep '"generation"' | head -1 | tr -dc '0-9' > "$PUT_GEN_FILE";;
        esac
      done
      return 0;;
    *) printf '%s' "$GET_BODY"; return 0;;
  esac
}
log() { :; }

# ensure_tenant may `die` (exit) on refusal, so run it in a subshell; the PUT generation
# is captured through a file so it survives. Sets globals RC + PUT_GEN (NOT called in a
# command-substitution, which would discard the assignments).
RC=""; PUT_GEN=""
run_ensure() { _K_OUT="$1"; _K_RC="$2"; GET_BODY="$3"; : > "$PUT_GEN_FILE"; ( ensure_tenant ) >/dev/null 2>&1; RC=$?; PUT_GEN="$(cat "$PUT_GEN_FILE")"; }

# ledger 2, pageserver 2 -> attach at 2 (post-failover; a literal 1 would be rejected).
run_ensure '2' 0 '{"generation":2}'
[ "$RC" = 0 ] && [ "$PUT_GEN" = 2 ] || fail "post-failover: rc=$RC gen='$PUT_GEN', want rc0 gen2"
pass=$((pass + 1)); echo "ok - ensure_tenant post-failover attaches at 2"

# ledger 3, fresh-PVC pageserver (404) -> attach at 3, NEVER 1 (silent-loss guard).
run_ensure '3' 0 ''
[ "$RC" = 0 ] && [ "$PUT_GEN" = 3 ] || fail "fresh-PVC+ledger3: rc=$RC gen='$PUT_GEN', want rc0 gen3"
pass=$((pass + 1)); echo "ok - ensure_tenant honours the durable ledger over a fresh-PVC pageserver (3, not 1)"

# FAIL CLOSED: unreadable ledger (kubectl error) -> ensure_tenant REFUSES, no PUT at 1.
run_ensure '' 1 ''
[ "$RC" != 0 ] || fail "unreadable ledger (kubectl error): ensure_tenant returned rc=$RC, expected REFUSAL (non-zero)"
[ "$PUT_GEN" = '' ] || fail "unreadable ledger: ensure_tenant PUT at generation '$PUT_GEN' — it must REFUSE, never floor to 1"
pass=$((pass + 1)); echo "ok - ensure_tenant REFUSES on an unreadable ledger (no silent floor-to-1)"

# FAIL CLOSED: CM present but key empty -> REFUSE.
run_ensure '' 0 '{"generation":7}'
[ "$RC" != 0 ] || fail "empty ledger key: ensure_tenant returned rc=$RC, expected REFUSAL"
pass=$((pass + 1)); echo "ok - ensure_tenant REFUSES on an empty ledger key even when the pageserver has a view"

# ---------------------------------------------------------------------------
# Part 4: the storage-init INLINE copy. Extract its generation-decision lines from
# 55-storage-init.yaml and run them with fixture LEDGER/PSGEN (LEDGER is numeric — the
# init container fail-closes before this point if the ledger is unreadable).
si_gen() {
  local LEDGER="$1" PSGEN="$2" GEN prog
  prog="$(grep -E 'GEN="\$LEDGER"$|-gt "\$GEN" \] && GEN="\$PSGEN"' "$SI" | sed 's/^[[:space:]]*//')"
  [ "$(printf '%s\n' "$prog" | grep -c .)" -eq 2 ] || { echo "EXTRACT_FAILED"; return 1; }
  eval "$prog"
  echo "$GEN"
}
check_si() {
  local ledger="$1" psgen="$2" want="$3" label="$4" got
  got="$(si_gen "$ledger" "$psgen")"
  [ "$got" = "$want" ] || fail "storage-init inline $label: got '$got', want '$want'"
  pass=$((pass + 1)); echo "ok - storage-init inline $label -> $got"
}
check_si '3' '' 3 "fresh-PVC pageserver + ledger 3 -> 3 (silent-loss guard)"
check_si '2' '5' 5 "pageserver ahead (5 vs ledger 2)"
check_si '3' '2' 3 "ledger ahead (3 vs pageserver 2)"
check_si '1' '' 1 "genesis ledger 1, pageserver fresh -> 1"

# ---------------------------------------------------------------------------
# Part 5 (finding 3): the storage-init /ledger FAIL-CLOSED block is BEHAVIORAL, not a
# text grep. Extract the T1-LEDGER-READ block from 55-storage-init.yaml and run it
# against fixture files with LEDGER_WAIT_TRIES=0 (fail fast, no 120s wait), asserting a
# non-zero exit on missing/empty/non-numeric and a correct LEDGER on a numeric value.
LEDGER_BLOCK="$(awk '/# T1-LEDGER-READ-BEGIN/{f=1;next} /# T1-LEDGER-READ-END/{f=0} f' "$SI" | sed 's/^[[:space:]]*//')"
[ -n "$LEDGER_BLOCK" ] || fail "could not extract the T1-LEDGER-READ block from $SI (markers moved?)"
FX="$(mktemp -d)"; trap 'rm -f "$PUT_GEN_FILE"; rm -rf "$FX"' EXIT
si_ledger_read() { # $1 = ledger file path (may not exist); echoes LEDGER on success
  TENANT_ID=test LEDGER_FILE="$1" LEDGER_WAIT_TRIES=0 sh -c "$LEDGER_BLOCK"'; printf "%s" "$LEDGER"'
}
# numeric value -> exit 0, LEDGER echoed
printf '5' > "$FX/num"
out="$(si_ledger_read "$FX/num")"; rc=$?
[ "$rc" = 0 ] && [ "$out" = 5 ] || fail "storage-init ledger-read numeric: rc=$rc out='$out', want rc0 out5"
pass=$((pass + 1)); echo "ok - storage-init /ledger read: numeric 5 -> accepted"
# missing file -> REFUSE (non-zero), no LEDGER
out="$(si_ledger_read "$FX/does-not-exist" 2>/dev/null)"; rc=$?
[ "$rc" != 0 ] || fail "storage-init ledger-read missing file: rc=$rc, expected REFUSAL (non-zero)"
pass=$((pass + 1)); echo "ok - storage-init /ledger read: missing file -> REFUSES (no floor-to-1)"
# empty file -> REFUSE
printf '' > "$FX/empty"
out="$(si_ledger_read "$FX/empty" 2>/dev/null)"; rc=$?
[ "$rc" != 0 ] || fail "storage-init ledger-read empty file: rc=$rc, expected REFUSAL"
pass=$((pass + 1)); echo "ok - storage-init /ledger read: empty file -> REFUSES"
# non-numeric (finding 4: must refuse, not coerce 'v12'->12) -> REFUSE
printf 'v12' > "$FX/nonnum"
out="$(si_ledger_read "$FX/nonnum" 2>/dev/null)"; rc=$?
[ "$rc" != 0 ] || fail "storage-init ledger-read 'v12': rc=$rc, expected REFUSAL — must NOT coerce to 12 (finding 4)"
pass=$((pass + 1)); echo "ok - storage-init /ledger read: non-numeric 'v12' -> REFUSES (no coercion, finding 4)"

echo "PASS ($pass checks) — read-before-attach honours the durable ledger and FAILS CLOSED on an unreadable one; never a literal generation:1 and never a silent floor below the ledger"
