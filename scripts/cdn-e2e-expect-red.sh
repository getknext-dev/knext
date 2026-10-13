#!/usr/bin/env bash
# An EXPECTED-RED leg for the CDN cache-tier kind e2e: run an assertion command
# that must fail, and prove it failed at the intended checks.
#
#   scripts/cdn-e2e-expect-red.sh <label> <spec-file> -- <command...>
#
# <spec-file> holds one expectation per line, `<check-id>|<message substring>`
# (blank lines and `#` comments ignored). The leg passes only if:
#   1. the command exits NON-ZERO (a run that passes cannot see red), and
#   2. for every expectation, the output carries `FAIL [<check-id>] ` followed
#      by the message substring, and that check did not fail on its
#      `precondition:` (that would be red for the wrong reason).
#
# Safe under GitHub's `bash -e`: the command's exit code is read through an
# if/else, never by letting a bare failing command end the step first.
set -uo pipefail

label="${1:?usage: cdn-e2e-expect-red.sh <label> <spec-file> -- <command...>}"
spec="${2:?missing spec file}"
shift 2
[ "${1:-}" = "--" ] || { echo "::error::cdn-e2e-expect-red: missing -- before the command"; exit 2; }
shift
[ "$#" -gt 0 ] || { echo "::error::cdn-e2e-expect-red: no command"; exit 2; }
[ -r "$spec" ] || { echo "::error::cdn-e2e-expect-red: cannot read $spec"; exit 2; }

log="$(mktemp "${TMPDIR:-/tmp}/cdn-red-XXXXXX")"
trap 'rm -f "$log"' EXIT

if "$@" >"$log" 2>&1; then rc=0; else rc=$?; fi
cat "$log"

if [ "$rc" -eq 0 ]; then
  echo "::error::[$label] the assertions PASSED — this leg exists to prove they can see red"
  exit 1
fi

missing=0
expected=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  id="${line%%|*}"
  msg="${line#*|}"
  if [ -z "$id" ] || [ "$id" = "$line" ] || [ -z "$msg" ]; then
    echo "::error::[$label] malformed expectation: $line"
    exit 2
  fi
  expected=$((expected + 1))
  if grep -F "FAIL [$id] precondition:" "$log" >/dev/null; then
    echo "::error::[$label] [$id] went red on its PRECONDITION, not on the defence under test"
    missing=$((missing + 1))
  elif ! grep -F "FAIL [$id] " "$log" | grep -F -- "$msg" >/dev/null; then
    echo "::error::[$label] [$id] did not fail with: $msg"
    missing=$((missing + 1))
  fi
done <"$spec"

[ "$expected" -gt 0 ] || { echo "::error::[$label] the spec file has no expectations"; exit 2; }
if [ "$missing" -ne 0 ]; then
  echo "::error::[$label] $missing of $expected expected red check(s) did not go red as intended (rc=$rc)"
  exit 1
fi
echo "[$label] proved: exit $rc, all $expected expected check(s) red at their intended assertion"
