#!/usr/bin/env bash
# test_seed-ledger.sh — off-cluster unit test for the CREATE-IF-ABSENT ledger seed
# (deploy/seed-ledger.sh, #1095). Runs WITHOUT a cluster.
#
# The property under test: seed-ledger.sh writes generation=1 ONLY when the key is
# absent, NEVER overwrites/lowers a live value (that would re-introduce the silent
# floor-to-1 this issue closes), and REFUSES a non-numeric value rather than guessing.
# It sources the shipped script (SEED_LEDGER_SOURCED guard) and stubs kube() to record
# whether a patch was issued.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED="$HERE/seed-ledger.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# shellcheck disable=SC1090
SEED_LEDGER_SOURCED=1 . "$SEED"
set +e

# --- Part 1: the pure decision function ------------------------------------
check_action() {
  local cur="$1" want="$2" got
  got="$(ledger_seed_action "$cur")"
  [ "$got" = "$want" ] || fail "ledger_seed_action('$cur') = '$got', want '$want'"
  pass=$((pass + 1)); echo "ok - ledger_seed_action('$cur') -> $got"
}
check_action ''    seed    # absent -> seed genesis 1
check_action '1'   keep    # live 1 -> keep
check_action '5'   keep    # live 5 -> keep (NEVER lower to 1)
check_action '12'  keep    # multi-digit live -> keep
check_action 'abc' refuse  # non-numeric -> refuse
check_action 'v12' refuse  # coercible-looking but non-numeric -> refuse

# --- Part 2: seed_ledger end-to-end with a stubbed kube() -------------------
# Records the last patch payload (empty = no patch issued).
PATCHED=""; CM_EXISTS=1; CUR_VAL=""
kube() {
  case "$*" in
    "get configmap pageserver-generation")           [ "$CM_EXISTS" = 1 ] && return 0 || return 1 ;;
    "get configmap pageserver-generation -o"*)       printf '%s' "$CUR_VAL"; return 0 ;;
    "patch configmap"*)                              PATCHED="$*"; return 0 ;;
    *)                                               return 0 ;;
  esac
}

# seed_ledger uses `return` (not exit), so run it inline — no subshell, so the PATCHED
# global written by the kube() stub survives. Sets globals RC + PATCHED.
RC=""
run_seed() { CM_EXISTS="$1"; CUR_VAL="$2"; PATCHED=""; seed_ledger >/dev/null 2>&1; RC=$?; }

# absent key -> patches generation=1
run_seed 1 ''
[ "$RC" = 0 ] || fail "absent key: seed_ledger rc=$RC, want 0"
case "$PATCHED" in *'"generation":"1"'*) ;; *) fail "absent key: expected a patch to generation=1, got PATCHED='$PATCHED'";; esac
pass=$((pass + 1)); echo "ok - seed_ledger seeds generation=1 when the key is absent"

# live value 5 -> NO patch (never lower/overwrite)
run_seed 1 '5'
[ "$RC" = 0 ] || fail "live value: seed_ledger rc=$RC, want 0"
[ -z "$PATCHED" ] || fail "live value 5: seed_ledger issued a patch ('$PATCHED') — it must NEVER overwrite/lower a live value"
pass=$((pass + 1)); echo "ok - seed_ledger leaves a live value (5) untouched (no patch)"

# non-numeric -> refuse (non-zero), no patch
run_seed 1 'garbage'
[ "$RC" != 0 ] || fail "non-numeric: seed_ledger rc=$RC, want non-zero (refuse)"
[ -z "$PATCHED" ] || fail "non-numeric: seed_ledger patched ('$PATCHED') — it must refuse, not guess"
pass=$((pass + 1)); echo "ok - seed_ledger REFUSES a non-numeric ledger value (no patch)"

# CM missing entirely -> fail loudly, no patch
run_seed 0 ''
[ "$RC" != 0 ] || fail "missing CM: seed_ledger rc=$RC, want non-zero"
[ -z "$PATCHED" ] || fail "missing CM: seed_ledger patched ('$PATCHED') — should surface the missing CM instead"
pass=$((pass + 1)); echo "ok - seed_ledger fails loudly when the ConfigMap does not exist"

echo "PASS ($pass checks) — create-if-absent seed never overwrites or lowers a live ledger value"
