#!/usr/bin/env bash
# pr-risk.sh — composite PR risk score from ONE jev call (four `--score` questions, fan-out).
#
#   .claude/skills/jev/pr-risk.sh [base-ref] [pr-number]
#       base-ref   default origin/main; the change judged is `<base>...HEAD`
#       pr-number  optional; adds the PR title and body (via `gh pr view N --json title,body`)
#
# WHAT IS SENT: NEVER DIFF CONTENT. Only the `git diff --stat` output, the changed file paths with
# their status (`--name-status`), the numstat line counts, and, when a PR number is given, the PR
# title and body. No hunk, no added or removed line, no file body leaves the machine. Why: this
# goes to a third party, and a secret-shape denylist over code is not complete: random AWS secret
# keys, Slack webhook URLs, Stripe `sk_live_` keys, hex HMAC secrets and `AIza...` keys all slip
# past any list narrow enough not to blind the injection screen. Removing the content removes the
# problem rather than racing it. The cost is accuracy: the score is a judgement from SHAPE (which
# areas, how many files and lines, whether tests moved), not from what the code does.
#
# Backstop: the exact text about to be sent (stat, paths, title, body) still passes the
# literal-secret check from jev-hook-lib.sh. With no content it rarely fires (a token in a file
# NAME, or pasted into a PR body); when it does the call is skipped.
#
# Prints one line per axis (position 0..4 of a 5-level rubric), then
#   RISK <0.00-1.00> HIGH|normal
# Exit 0 = normal, 10 = HIGH (composite >= 0.6), 3 = unavailable (jev down, unparseable scores,
# the base ref does not resolve or shares no history with HEAD, a git call failed, or the secret
# check fired or could not run: no opinion, NOT "safe" — say so in the report). A git error is
# never read as an empty diff; only a genuinely empty `base...HEAD` prints "RISK 0.00 normal". A HIGH result means: reviewers at high effort + a knext-tester pass (see recipes.md, L3).
#
# WEIGHTS — one line, must sum to 1.0. Security dominates because it is the only axis where a
# miss is not recoverable; tests next because they are what makes the other three catchable.
W_SECURITY=${W_SECURITY:-0.40} W_COMPLEXITY=${W_COMPLEXITY:-0.20} W_DRIFT=${W_DRIFT:-0.15} W_TESTS=${W_TESTS:-0.25}
THRESHOLD=0.6
MAX_BYTES=80000      # jev's ceiling is ~107,500 chars; anything past this is NOT judged.
MAX_BODY_BYTES=20000 # a PR body is capped before it is added.

set -uo pipefail
BASE="${1:-origin/main}"
PR="${2:-}"
JEV="${JEV_BIN:-jev}"
GH="${GH_BIN:-gh}"
command -v jq >/dev/null 2>&1 && command -v awk >/dev/null 2>&1 || { echo "RISK unavailable (needs jq and awk)"; exit 3; }

tmp=$(mktemp -d) || exit 3
trap 'rm -rf "$tmp"' EXIT

# A git ERROR IS NEVER AN EMPTY DIFF. Scoring a broken run as "RISK 0.00 normal" would be the
# worst possible failure of a risk tool, so the base must resolve to a commit that shares history
# with HEAD before anything else, and every git call below is checked on its own exit status.
git rev-parse --verify -q "$BASE^{commit}" >/dev/null 2>&1 && git merge-base "$BASE" HEAD >/dev/null 2>&1 ||
  { echo "RISK unavailable (base ref '$BASE' does not resolve to a commit with a merge base)"; exit 3; }

# --no-ext-diff / --no-color: nothing from a configured diff driver or a pager. None of the three
# invocations prints a hunk.
diff_part() { # <git diff output option> <outfile>
  git diff --no-ext-diff --no-color -M "$1" "$BASE"...HEAD >"$2" 2>/dev/null ||
    { echo "RISK unavailable (git diff failed)"; exit 3; }
}
diff_part --name-status "$tmp/names"
diff_part --stat=200 "$tmp/stat"
diff_part --numstat "$tmp/numstat"
if ! grep -q '^[A-Z][0-9]*[[:space:]]' "$tmp/names"; then
  echo "RISK 0.00 normal (empty diff, jev not called)"; exit 0
fi
{
  echo "CHANGED FILES (status, path):"
  cat "$tmp/names"
  echo
  echo "DIFFSTAT:"
  cat "$tmp/stat"
  echo
  echo "NUMSTAT (added, removed, path):"
  cat "$tmp/numstat"
} >"$tmp/change.full"

if [ -n "$PR" ]; then
  # Optional context. A failing gh is not fatal: the stat is still scored.
  if "$GH" pr view "$PR" --json title,body >"$tmp/pr.json" 2>/dev/null; then
    {
      echo
      echo "PR TITLE:"
      jq -r '.title // ""' "$tmp/pr.json" 2>/dev/null
      echo
      echo "PR BODY:"
      jq -r '.body // ""' "$tmp/pr.json" 2>/dev/null | head -c "$MAX_BODY_BYTES"
    } >>"$tmp/change.full" || true
  fi
fi
head -c "$MAX_BYTES" "$tmp/change.full" >"$tmp/change.txt"

# Backstop: nothing literally secret leaves the machine, checked on the exact bytes to be sent. On
# a hit (or if the check cannot run) the call is skipped and the result is "unavailable".
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../../hooks/jev-hook-lib.sh"
# shellcheck source=../../hooks/jev-hook-lib.sh
. "$LIB" 2>/dev/null || { echo "RISK unavailable (secret check unavailable)"; exit 3; }
if jev_has_literal_secret <"$tmp/change.txt"; then echo "RISK unavailable (input carries a literal secret)"; exit 3; fi

"$JEV" ask --field "change=@$tmp/change.txt" \
  --score security 'You are shown ONLY the changed file PATHS with their status, the diffstat, the line counts and the PR title/body; no code. From that alone, how much SECURITY risk does `change` likely add? Weigh WHICH AREAS it touches: auth, secrets handling, CI workflows, RBAC or CRDs, supply chain (lockfiles, Dockerfiles, dependency manifests), network exposure, cluster-write surface.' none low medium high critical \
  --score complexity 'From the number of files, the lines added and removed, and how many different areas the paths span, how COMPLEX and hard to review is `change`?' trivial small moderate large very_complex \
  --score drift 'From the paths and statuses alone, how far does the SHAPE of `change` depart from a conventional change here (files in unexpected places, unrelated areas mixed together, generated or vendored files, large renames)?' none slight some notable severe \
  --score tests 'From the paths and line counts alone, how INADEQUATE is the test coverage in `change`: do test files appear among the changed paths in proportion to the source files and lines changed?' thorough good partial thin absent \
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
