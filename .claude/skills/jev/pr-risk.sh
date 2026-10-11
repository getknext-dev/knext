#!/usr/bin/env bash
# pr-risk.sh — composite PR risk score from ONE jev call (four `--score` questions, fan-out).
#
#   .claude/skills/jev/pr-risk.sh [base-ref]        # default origin/main; judges `git diff <base>...HEAD`
#
# Prints one line per axis (position 0..4 of a 5-level rubric), then
#   RISK <0.00-1.00> HIGH|normal
# Exit 0 = normal, 10 = HIGH (composite >= 0.6), 3 = jev unavailable (fail open: no opinion,
# not "safe" — say so in the report). A HIGH result means: reviewers at high effort + a
# knext-tester pass (see recipes.md, L3).
#
# WEIGHTS — one line, must sum to 1.0. Security dominates because it is the only axis where a
# miss is not recoverable; tests next because they are what makes the other three catchable.
W_SECURITY=${W_SECURITY:-0.40} W_COMPLEXITY=${W_COMPLEXITY:-0.20} W_DRIFT=${W_DRIFT:-0.15} W_TESTS=${W_TESTS:-0.25}
THRESHOLD=0.6
MAX_BYTES=80000 # jev's ceiling is ~107,500 chars; the tail of a bigger diff is NOT judged.

set -uo pipefail
BASE="${1:-origin/main}"
JEV="${JEV_BIN:-jev}"
command -v jq >/dev/null 2>&1 && command -v awk >/dev/null 2>&1 || { echo "RISK unavailable (needs jq and awk)"; exit 3; }

tmp=$(mktemp -d) || exit 3
trap 'rm -rf "$tmp"' EXIT
if [ -n "${PR_RISK_DIFF_FILE:-}" ]; then
  head -c "$MAX_BYTES" "$PR_RISK_DIFF_FILE" >"$tmp/diff.txt"
else
  git diff "$BASE"...HEAD 2>/dev/null | head -c "$MAX_BYTES" >"$tmp/diff.txt"
fi
if [ ! -s "$tmp/diff.txt" ]; then echo "RISK 0.00 normal (empty diff, jev not called)"; exit 0; fi

"$JEV" ask --field "diff=@$tmp/diff.txt" \
  --score security 'How much SECURITY risk does the change in `diff` add (auth, secrets, injection, unauthenticated mutating endpoints, supply chain, cluster-write surface)?' none low medium high critical \
  --score complexity 'How COMPLEX and hard to review is the change in `diff` (size, number of concerns, subtle control flow)?' trivial small moderate large very_complex \
  --score drift 'How far does the change in `diff` DEPART from the conventions of the code it touches (style, naming, layering, existing patterns)?' none slight some notable severe \
  --score tests 'How INADEQUATE are the tests in `diff` for the behaviour it changes?' thorough good partial thin absent \
  --json >"$tmp/out.json" 2>/dev/null || { echo "RISK unavailable (jev call failed)"; exit 3; }

s=$(jq -r '.answers.security.score // empty' "$tmp/out.json" 2>/dev/null)
c=$(jq -r '.answers.complexity.score // empty' "$tmp/out.json" 2>/dev/null)
d=$(jq -r '.answers.drift.score // empty' "$tmp/out.json" 2>/dev/null)
t=$(jq -r '.answers.tests.score // empty' "$tmp/out.json" 2>/dev/null)
for v in "$s" "$c" "$d" "$t"; do
  case "$v" in '' | *[!0-9.]* | *.*.*) echo "RISK unavailable (unparseable scores)"; exit 3 ;; esac
done

# Arithmetic stays in code, not in the model. Positions are 0..4, so /4 normalises.
awk -v s="$s" -v c="$c" -v d="$d" -v t="$t" \
  -v ws="$W_SECURITY" -v wc="$W_COMPLEXITY" -v wd="$W_DRIFT" -v wt="$W_TESTS" -v th="$THRESHOLD" '
BEGIN {
  printf "security   %.2f/4\ncomplexity %.2f/4\ndrift      %.2f/4\ntests      %.2f/4\n", s, c, d, t
  r = (ws * s + wc * c + wd * d + wt * t) / 4
  r = int(r * 10000 + 0.5) / 10000          # round first: 0.4+0.2 must compare as exactly 0.6
  high = (r >= th)
  printf "RISK %.2f %s\n", r, (high ? "HIGH" : "normal")
  exit (high ? 10 : 0)
}'
