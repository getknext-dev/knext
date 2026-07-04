#!/usr/bin/env bash
# test_provision-app.sh — unit test for provision-app.sh app-name validation
# (issue #79) and reserved-name rejection (issue #74). Runs WITHOUT a cluster:
# validate_app_name is the first thing create/destroy do, before any kubectl/PS
# call, so an invalid name fails fast and we never touch a real context.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# expect_reject <subcommand> <name> <label>: the name must be refused by
# validation (non-zero exit AND an invalid/reserved/required message), NOT by a
# downstream kubectl error.
expect_reject() {
  local sub="$1" name="$2" label="$3" out
  out="$(KCTX=none NS=none "$PROV" "$sub" "$name" 2>&1)" && \
    fail "$label: '$name' was accepted, expected rejection"
  case "$out" in
    *invalid\ app\ name*|*is\ reserved*|*app\ name\ required*) ;;
    *) fail "$label: '$name' rejected but not by name validation. Got: $out" ;;
  esac
  pass=$((pass + 1))
  echo "ok - rejected $label: '$name'"
}

# Invalid charset / RFC1123 violations.
for n in "Bad" "a.b" "a/b" "-x" "x-" "UPPER" "a_b" "sp ace" ""; do
  expect_reject create "$n" charset
done

# Reserved system names (route to the shared template / warm / RO computes).
for n in tmpl warm ro; do
  expect_reject create "$n" reserved
done

# destroy validates too (a bad name must not reach kubectl delete).
expect_reject destroy "Bad.Name" charset

# rotate-cred (issue #93b) validates the name FIRST too — a bad/reserved/empty name
# must never reach the Secret write.
expect_reject rotate-cred "Bad" charset
expect_reject rotate-cred "a_b" charset
expect_reject rotate-cred "tmpl" reserved
expect_reject rotate-cred "" required

# A well-formed, non-reserved name must PASS validation. It then proceeds to a
# cluster call and fails there (no cluster) — but NOT with a validation message.
out="$(KCTX=none NS=none "$PROV" create "good-app1" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] || fail "expected create to fail without a cluster"
case "$out" in
  *invalid\ app\ name*|*is\ reserved*) fail "valid name 'good-app1' was wrongly rejected by validation: $out" ;;
  *) echo "ok - accepted valid name 'good-app1' (failed later at cluster call, as expected)" ;;
esac
pass=$((pass + 1))

echo "provision-app.sh validation: $pass cases — PASSED"
