#!/usr/bin/env bash
# test_verify-drift.sh — cluster-free unit test for _verify-drift.sh §0 (the target-
# cluster identity guard, issue #157) and the PR #180 code-review BLOCKING fix: the
# fast-reject must evaluate the EFFECTIVE (explicit --context / DRIFT_CONTEXT, else
# ambient) context — the SAME source the fingerprint check honors — NOT the raw
# ambient current-context.
#
# Why this matters: `kubectl config current-context` IGNORES --context (it always
# reports the raw AMBIENT context). On a machine whose ambient self-reset to orbstack,
# CI passing `--context <oke>` (the documented #157 remedy) would still hit the
# `orbstack)` fast-reject and false-RED exit 1. This test pins that regression.
#
# Runs WITHOUT a cluster: a fake `kubectl` on PATH models the real flag semantics —
#   * `config current-context` -> prints $FAKE_AMBIENT, ignoring --context (as real does)
#   * `get crd <oke-crd>` / `get node <ip>` -> succeeds IFF the EFFECTIVE context
#     (--context value, else $FAKE_AMBIENT) equals $FAKE_OKE_CTX (models --context
#     overriding ambient; absent --context => ambient)
#   * anything else -> exit 1 (so the script stops in section A/B after §0; we only
#     assert on §0 output markers).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DRIFT="$HERE/_verify-drift.sh"
OKE_CTX="context-ckmva7v7zvq"
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- build the fake kubectl on a shim PATH -------------------------------------
SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT
cat > "$SHIM/kubectl" <<'FAKE'
#!/bin/sh
# fake kubectl: honors --context flag semantics for the §0 identity guard.
ctx=""; prev=""
for a in "$@"; do
  [ "$prev" = "--context" ] && ctx="$a"
  prev="$a"
done
case "$*" in
  *"config current-context"*)
    # real kubectl IGNORES --context here — it reports the raw ambient context.
    echo "${FAKE_AMBIENT:-orbstack}"; exit 0;;
  *"get crd nodeoperationrules.oci.oraclecloud.com"*|*" get node "*)
    eff="${ctx:-${FAKE_AMBIENT:-orbstack}}"   # --context overrides ambient; absent => ambient
    [ "$eff" = "${FAKE_OKE_CTX:-context-ckmva7v7zvq}" ] && exit 0 || exit 1;;
esac
exit 1   # any real cluster op fails -> script stops after §0
FAKE
chmod +x "$SHIM/kubectl"
export PATH="$SHIM:$PATH"
export FAKE_OKE_CTX="$OKE_CTX"

run() { # run the drift script, capture stdout+stderr, never abort the test on its exit
  ( "$@" ) 2>&1 || true
}
has()   { case "$2" in *"$1"*) return 0;; *) return 1;; esac; }
hasnt() { case "$2" in *"$1"*) return 1;; *) return 0;; esac; }

# --- CASE 1: ambient=orbstack, NO --context -> fast-reject SHOULD fire ----------
out="$(FAKE_AMBIENT=orbstack run sh "$DRIFT")"
has "is a LOCAL/dev cluster" "$out" || fail "case1: ambient orbstack + no --context did NOT fast-reject"
echo "ok - case1: ambient orbstack (no --context) fast-rejected as LOCAL/dev"; pass=$((pass+1))

# --- CASE 2 (the BLOCKING regression): ambient=orbstack, --context=OKE ----------
# The explicit context reaches OKE, so §0 must NOT fast-reject on the ambient orbstack;
# it must PROCEED to the fingerprint check and pass.
out="$(FAKE_AMBIENT=orbstack run sh "$DRIFT" --context "$OKE_CTX")"
hasnt "is a LOCAL/dev cluster" "$out" \
  || fail "case2 (REGRESSION): --context=$OKE_CTX still hit the ambient-orbstack fast-reject (false-RED)"
has "OKE fingerprint present" "$out" \
  || fail "case2: with --context=$OKE_CTX, §0 did not reach/pass the OKE fingerprint check. Got: $out"
echo "ok - case2: --context=$OKE_CTX over ambient orbstack proceeds past fast-reject to OKE fingerprint (issue #157 fix)"; pass=$((pass+1))

# --- CASE 2b: same via DRIFT_CONTEXT env (CI form) ------------------------------
out="$(FAKE_AMBIENT=orbstack DRIFT_CONTEXT="$OKE_CTX" run sh "$DRIFT")"
hasnt "is a LOCAL/dev cluster" "$out" \
  || fail "case2b (REGRESSION): DRIFT_CONTEXT=$OKE_CTX still hit the ambient-orbstack fast-reject"
has "OKE fingerprint present" "$out" || fail "case2b: DRIFT_CONTEXT did not reach the fingerprint pass"
echo "ok - case2b: DRIFT_CONTEXT=$OKE_CTX (env) proceeds past fast-reject to OKE fingerprint"; pass=$((pass+1))

# --- CASE 3: EXPLICIT --context orbstack over an OKE ambient -> MUST reject ------
# The fast-reject must evaluate the EXPLICIT context: asking for orbstack is rejected
# even though ambient is OKE (proves both paths read the same effective source).
out="$(FAKE_AMBIENT="$OKE_CTX" run sh "$DRIFT" --context orbstack)"
has "is a LOCAL/dev cluster" "$out" \
  || fail "case3: explicit --context orbstack was NOT fast-rejected (effective context not honored)"
echo "ok - case3: explicit --context orbstack fast-rejected even under an OKE ambient"; pass=$((pass+1))

# --- CASE 4: interactive OKE ambient, no --context -> fingerprint passes ---------
out="$(FAKE_AMBIENT="$OKE_CTX" run sh "$DRIFT")"
hasnt "is a LOCAL/dev cluster" "$out" || fail "case4: OKE ambient wrongly fast-rejected"
has "OKE fingerprint present" "$out" || fail "case4: OKE ambient did not pass the fingerprint check"
echo "ok - case4: interactive OKE ambient (no --context) passes §0"; pass=$((pass+1))

echo "PASS - _verify-drift §0 identity guard: $pass assertions (issue #157, PR #180 fix)"
