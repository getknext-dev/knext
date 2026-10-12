#!/usr/bin/env bash
# Offline test for pr-risk.sh: stubbed jev and gh, a throwaway git repo, exit codes, arithmetic,
# and the property that matters most: NO DIFF CONTENT is ever sent.
#
#   bash .claude/skills/jev/pr-risk.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RISK="$HERE/pr-risk.sh"
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FAKE="$TMP/fake-jev"; FAKE_GH="$TMP/fake-gh"
export FAKE_OUT="$TMP/out.json" FAKE_ARGS="$TMP/args.log" FAKE_SIZE="$TMP/size.log" FAKE_SEEN="$TMP/seen.txt"
export FAKE_GH_LOG="$TMP/gh.log" FAKE_GH_JSON="$TMP/gh.json"
cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$FAKE_ARGS"
for a in "$@"; do case "$a" in *=@*) wc -c <"${a#*=@}" | tr -d ' ' >"$FAKE_SIZE"; cat "${a#*=@}" >"$FAKE_SEEN";; esac; done
[ "${FAKE_MODE:-ok}" = fail ] && { echo "no key" >&2; exit 1; }
cat "$FAKE_OUT"
EOF
cat >"$FAKE_GH" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_GH_LOG"
[ "${FAKE_GH_MODE:-ok}" = fail ] && exit 1
cat "$FAKE_GH_JSON"
EOF
chmod +x "$FAKE" "$FAKE_GH"
fails=0
fixture() { # sec cx drift tests (positions 0..4)
  jq -n --argjson a "$1" --argjson b "$2" --argjson c "$3" --argjson d "$4" \
    '{answers:{security:{score:$a},complexity:{score:$b},drift:{score:$c},tests:{score:$d}}}' >"$FAKE_OUT"
}
ok() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fails=1; }
check() { # label want-substring
  if printf '%s' "$OUT" | grep -qF -- "$2"; then ok "$1"; else bad "$1: want [$2] got [$OUT]"; fi
}
called() { [ -s "$FAKE_ARGS" ]; }

# A throwaway repo: `main` has one file, branch `feat` changes some. Run the script from inside it.
REPO="$TMP/repo"
MARKER="ZZ_UNIQUE_BODY_MARKER_7f3a91c2" # appears ONLY inside a changed file's body, never in a path or name
L36=abcdefghijklmnopqrstuvwxyzabcdefghij # letters only: the prefix rule is the only thing that can catch it
git_in() { git -C "$REPO" -c user.email=t@t -c user.name=t -c commit.gpgsign=false "$@"; }
new_repo() {
  rm -rf "$REPO"; mkdir -p "$REPO"
  git_in init -q -b main
  echo base >"$REPO/base.txt"; git_in add -A; git_in commit -q -m base
  git_in checkout -q -b feat
}
commit_all() { git_in add -A; git_in commit -q -m change; }
change_small() { # a source file whose BODY carries the marker, plus a test file
  mkdir -p "$REPO/src" "$REPO/tests"
  printf 'export const secretish = "%s";\n// %s\n' "$MARKER" "$MARKER" >"$REPO/src/auth.ts"
  printf 'test("x", () => {}); // %s\n' "$MARKER" >"$REPO/tests/auth.test.ts"
  commit_all
}
run() { # [pr-number]  — runs pr-risk.sh from inside the repo against main
  ( cd "$REPO" && JEV_BIN="$FAKE" GH_BIN="$FAKE_GH" bash "$RISK" main "$@" 2>&1 )
}
reset_stub() { : >"$FAKE_ARGS"; : >"$FAKE_SEEN"; : >"$FAKE_GH_LOG"; export FAKE_MODE=ok FAKE_GH_MODE=ok; }
printf '{"title":"Add auth","body":"Adds the auth module."}' >"$FAKE_GH_JSON"

new_repo; change_small

echo "== scoring: weights, threshold, exit codes =="
reset_stub
fixture 4 4 4 4; OUT=$(run); rc=$?
check "all-max scores give composite 1.00 HIGH" "RISK 1.00 HIGH"
[ "$rc" -eq 10 ] && ok "HIGH exits 10" || bad "HIGH must exit 10, got $rc"
fixture 0 0 0 0; OUT=$(run); rc=$?
check "all-zero scores give 0.00 normal" "RISK 0.00 normal"
[ "$rc" -eq 0 ] && ok "normal exits 0" || bad "normal must exit 0, got $rc"
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
[ "$rc" -eq 3 ] && ok "unavailable exits 3" || bad "unavailable must exit 3, got $rc"
export FAKE_MODE=ok
echo '{"answers":{}}' >"$FAKE_OUT"; OUT=$(run); rc=$?
[ "$rc" -eq 3 ] && check "missing scores report unavailable" "RISK unavailable" || bad "missing scores must exit 3, got $rc"

echo "== NO diff content is ever sent: only stat, paths, counts and the PR title/body =="
reset_stub; fixture 0 0 0 0
OUT=$(run); rc=$?
if called && [ "$rc" -eq 0 ]; then ok "the call was made"; else bad "the call was not made (rc=$rc out=$OUT)"; fi
if grep -qF -- "$MARKER" "$FAKE_SEEN"; then bad "DIFF CONTENT LEAKED: the marker from a file body reached jev"; else ok "the marker that only appears inside file bodies never reached jev"; fi
if grep -qF -- "$MARKER" "$FAKE_ARGS"; then bad "DIFF CONTENT LEAKED via the arguments"; else ok "nor via the jev arguments"; fi
grep -qF "src/auth.ts" "$FAKE_SEEN" && grep -qF "tests/auth.test.ts" "$FAKE_SEEN" && ok "the changed PATHS are sent" || bad "paths missing from what was sent: [$(cat "$FAKE_SEEN")]"
grep -qE '^[0-9]+[[:space:]]+[0-9]+[[:space:]]+src/auth.ts' "$FAKE_SEEN" && ok "the numstat counts are sent" || bad "numstat counts missing"
grep -qE '^(A|M)[[:space:]]+src/auth.ts' "$FAKE_SEEN" && ok "the name-status lines are sent" || bad "name-status missing"
grep -q ' | ' "$FAKE_SEEN" && ok "the diffstat is sent" || bad "diffstat missing"
if grep -qE '^(\+|-)[^+-]|^@@|^diff --git|^index [0-9a-f]+' "$FAKE_SEEN"; then bad "a diff hunk or header was sent"; else ok "no hunk, +/- line or diff header was sent"; fi
# The questions must be about what IS sent.
if grep -q -i "paths\|stat" "$FAKE_ARGS"; then ok "the questions are worded for paths and stats"; else bad "questions not reworded"; fi

echo "== PR title and body: only when a PR number is given =="
reset_stub; fixture 0 0 0 0
OUT=$(run 7); rc=$?
grep -qF "view 7" "$FAKE_GH_LOG" && grep -qF -- "--json title,body" "$FAKE_GH_LOG" && ok "gh pr view 7 --json title,body was asked for" || bad "gh not called as expected: [$(cat "$FAKE_GH_LOG")]"
grep -qF "Add auth" "$FAKE_SEEN" && grep -qF "Adds the auth module." "$FAKE_SEEN" && ok "the PR title and body are sent" || bad "PR text missing from what was sent"
reset_stub; fixture 0 0 0 0
OUT=$(run); rc=$?
[ ! -s "$FAKE_GH_LOG" ] && ok "no PR number: gh is never called" || bad "gh was called without a PR number"
grep -qF "Add auth" "$FAKE_SEEN" && bad "PR text sent without a PR number" || ok "no PR number: no PR text"
reset_stub; fixture 0 0 0 0; export FAKE_GH_MODE=fail
OUT=$(run 7); rc=$?
[ "$rc" -eq 0 ] && called && ok "gh failing is not fatal: the stat is still scored" || bad "gh failure broke the run (rc=$rc out=$OUT)"
reset_stub; fixture 0 0 0 0
printf '{"title":"t","body":"%s"}' "$(printf 'x%.0s' $(seq 1 30000))" >"$FAKE_GH_JSON"
OUT=$(run 7); rc=$?
sz=$(wc -c <"$FAKE_SEEN" | tr -d ' ')
[ "$sz" -le 21000 ] && ok "a 30 KB PR body is capped at 20 KB (sent $sz bytes in all)" || bad "PR body not capped: $sz"
printf '{"title":"Add auth","body":"Adds the auth module."}' >"$FAKE_GH_JSON"

echo "== a literal secret in what WOULD be sent is never sent =="
# The check is a backstop now (no content is sent), on the exact bytes: title, body and paths.
reset_stub; fixture 4 4 4 4
printf '{"title":"t","body":"deploy with ghp_%s"}' "$L36" >"$FAKE_GH_JSON"
OUT=$(run 7); rc=$?
check "a secret in the PR body is not sent" "RISK unavailable (input carries a literal secret)"
[ "$rc" -eq 3 ] && ok "exits 3 (same as unavailable)" || bad "must exit 3, got $rc"
called && bad "the stub was called for a secret PR body" || ok "the stub was never called"
printf '{"title":"Add auth","body":"Adds the auth module."}' >"$FAKE_GH_JSON"
new_repo; mkdir -p "$REPO/src"; echo x >"$REPO/src/ghp_$L36.txt"; commit_all
reset_stub; fixture 4 4 4 4
OUT=$(run); rc=$?
[ "$rc" -eq 3 ] && ! called && ok "a token in a changed PATH is not sent" || bad "path token (rc=$rc called=$(called && echo y || echo n))"

echo "== empty diff, truncation, SIGPIPE, missing lib =="
new_repo # no changes on feat
reset_stub; fixture 0 0 0 0
OUT=$(run); rc=$?
[ "$rc" -eq 0 ] && check "empty diff is zero risk, no call" "RISK 0.00 normal" && ! called && ok "empty diff makes no jev call" || bad "empty diff (rc=$rc out=$OUT)"
# many files with long names: the stat/numstat/name-status text is far bigger than 80000 bytes
new_repo; mkdir -p "$REPO/pkg"
i=0; while [ "$i" -lt 1500 ]; do : >"$REPO/pkg/a_file_with_a_rather_long_name_to_make_the_stat_big_$(printf '%05d' "$i").txt"; i=$((i + 1)); done
commit_all
reset_stub; fixture 0 0 0 0
OUT=$(run); rc=$?
sz=$(cat "$FAKE_SIZE" 2>/dev/null || echo 0)
[ "$sz" -gt 0 ] && [ "$sz" -le 80000 ] && ok "the input is truncated to <= 80000 bytes ($sz sent)" || bad "input not truncated: $sz (rc=$rc out=$OUT)"
# SIGPIPE under pipefail, made DETERMINISTIC: whether a real `grep -q` closes the pipe before
# `printf` has finished writing is a race (lost on Linux, won on macOS). This shim judges only the
# first KiB of stdin and then exits, so an 80 KB writer MUST die of SIGPIPE on every platform. A
# pipeline-shaped check (`printf | grep -q`) would then report "no secret" and the text be SENT.
mkdir -p "$REPO/aaa"; echo x >"$REPO/aaa/ghp_$L36.txt"; commit_all # sorts first, so it is early in the text
mkdir -p "$TMP/shim"
REAL_GREP=$(command -v grep)
# Only a grep that READS STDIN is throttled; one given a file operand (pr-risk.sh's own greps) runs
# as usual, otherwise `dd` would block forever on the inherited stdin.
printf '#!/usr/bin/env bash\nfor a; do last=$a; done\nif [ -f "$last" ]; then exec "%s" "$@"; fi\ndd bs=1 count=1024 2>/dev/null | "%s" "$@"\n' "$REAL_GREP" "$REAL_GREP" >"$TMP/shim/grep"; chmod +x "$TMP/shim/grep"
reset_stub; fixture 0 0 0 0
OUT=$(PATH="$TMP/shim:$PATH" run); rc=$?
[ "$rc" -eq 3 ] && ! called && ok "an early-exiting reader (SIGPIPE to the writer) still blocks the call" || bad "SIGPIPE case (rc=$rc out=$OUT)"
# If the secret check cannot be loaded (the lib is not where it should be), NOTHING is sent.
new_repo; change_small
mkdir -p "$TMP/solo"; cp "$RISK" "$TMP/solo/pr-risk.sh"
reset_stub; fixture 0 0 0 0
OUT=$( cd "$REPO" && JEV_BIN="$FAKE" GH_BIN="$FAKE_GH" bash "$TMP/solo/pr-risk.sh" main 2>&1 ); rc=$?
[ "$rc" -eq 3 ] && ! called && echo "$OUT" | grep -qF "secret check unavailable" && ok "a missing secret-check lib stops the call (nothing sent)" || bad "missing lib (rc=$rc out=$OUT)"

[ "$fails" -eq 0 ] && echo ALL PASS || echo FAILURES
exit "$fails"
