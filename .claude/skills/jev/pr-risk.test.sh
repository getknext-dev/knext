#!/usr/bin/env bash
# Offline test for pr-risk.sh: stubbed jev, fixture scores, exit codes and the arithmetic.
#
#   bash .claude/skills/jev/pr-risk.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RISK="$HERE/pr-risk.sh"
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FAKE="$TMP/fake-jev"; export FAKE_OUT="$TMP/out.json" FAKE_ARGS="$TMP/args.log" FAKE_SIZE="$TMP/size.log"
cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$FAKE_ARGS"
for a in "$@"; do case "$a" in *=@*) wc -c <"${a#*=@}" | tr -d ' ' >"$FAKE_SIZE";; esac; done
[ "${FAKE_MODE:-ok}" = fail ] && { echo "no key" >&2; exit 1; }
cat "$FAKE_OUT"
EOF
chmod +x "$FAKE"
DIFF="$TMP/d.diff"; printf 'diff --git a/x b/x\n+hello\n' >"$DIFF"
fails=0
fixture() { # sec cx drift tests (positions 0..4)
  jq -n --argjson a "$1" --argjson b "$2" --argjson c "$3" --argjson d "$4" \
    '{answers:{security:{score:$a},complexity:{score:$b},drift:{score:$c},tests:{score:$d}}}' >"$FAKE_OUT"
}
run() { PR_RISK_DIFF_FILE="${PR_RISK_DIFF_FILE:-$DIFF}" JEV_BIN="$FAKE" bash "$RISK" 2>&1; }
check() { # label want-substring
  if printf '%s' "$OUT" | grep -qF -- "$2"; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s: want [%s] got [%s]\n' "$1" "$2" "$OUT"; fails=1; fi
}

fixture 4 4 4 4; OUT=$(run); rc=$?
check "all-max scores give composite 1.00 HIGH" "RISK 1.00 HIGH"
[ "$rc" -eq 10 ] && echo "ok    HIGH exits 10" || { echo "FAIL  HIGH must exit 10, got $rc"; fails=1; }
fixture 0 0 0 0; OUT=$(run); rc=$?
check "all-zero scores give 0.00 normal" "RISK 0.00 normal"
[ "$rc" -eq 0 ] && echo "ok    normal exits 0" || { echo "FAIL  normal must exit 0, got $rc"; fails=1; }
# weights 0.40/0.20/0.15/0.25: security alone at max = 0.40, tests alone = 0.25
fixture 4 0 0 0; OUT=$(run); check "security weight is 0.40" "RISK 0.40 normal"
fixture 0 0 0 4; OUT=$(run); check "tests weight is 0.25" "RISK 0.25 normal"
fixture 4 0 0 4; OUT=$(run); check "0.40+0.25 = 0.65 is HIGH (>= 0.6)" "RISK 0.65 HIGH"
fixture 4 0 1 0; OUT=$(run); check "below 0.6 stays normal (0.40+0.0375)" "RISK 0.44 normal"
fixture 4 4 0 0; OUT=$(run); check "0.40+0.20 = exactly 0.60 is HIGH" "RISK 0.60 HIGH"
# Float-noise case: these weights sum to 0.6 nominally but 0.5999999999999999 in IEEE, so an
# unrounded compare says "normal" while the printed score reads 0.60. Weights are env-overridable.
fixture 4 4 4 4; OUT=$(W_SECURITY=0.03 W_COMPLEXITY=0.29 W_DRIFT=0.04 W_TESTS=0.24 run); check "float noise at the boundary still reads HIGH" "RISK 0.60 HIGH"
fixture 1 2 3 4; OUT=$(run); check "per-axis lines are printed" "drift      3.00/4"
export FAKE_MODE=fail; OUT=$(run); rc=$?
check "jev failure reports unavailable" "RISK unavailable"
[ "$rc" -eq 3 ] && echo "ok    unavailable exits 3" || { echo "FAIL  unavailable must exit 3, got $rc"; fails=1; }
export FAKE_MODE=ok
echo '{"answers":{}}' >"$FAKE_OUT"; OUT=$(run); rc=$?
[ "$rc" -eq 3 ] && check "missing scores report unavailable" "RISK unavailable" || { echo "FAIL  missing scores must exit 3, got $rc"; fails=1; }
head -c 300000 /dev/zero | tr '\0' 'x' >"$TMP/big.diff"; fixture 0 0 0 0
OUT=$(PR_RISK_DIFF_FILE="$TMP/big.diff" run)
sz=$(cat "$FAKE_SIZE")
[ "$sz" -le 80000 ] && echo "ok    diff truncated to <= 80000 bytes ($sz of 300000)" || { echo "FAIL  diff not truncated: $sz"; fails=1; }
: >"$TMP/empty.diff"; : >"$FAKE_ARGS"
OUT=$(PR_RISK_DIFF_FILE="$TMP/empty.diff" run); rc=$?
[ "$rc" -eq 0 ] && check "empty diff is zero risk, no call" "RISK 0.00 normal" && [ ! -s "$FAKE_ARGS" ] && echo "ok    empty diff makes no jev call" || { echo "FAIL  empty diff (rc=$rc out=$OUT)"; fails=1; }
[ "$fails" -eq 0 ] && echo ALL PASS || echo FAILURES
exit "$fails"
