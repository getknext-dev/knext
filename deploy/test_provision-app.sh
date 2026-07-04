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

# --- issue #91: deprovision semantics --------------------------------------
# A bad flag must be refused by flag parsing (not swallowed).
out="$(KCTX=none NS=none "$PROV" destroy good --bogus-flag 2>&1)" && \
  fail "destroy accepted an unknown flag"
case "$out" in *unknown\ flag*) echo "ok - destroy rejects unknown flag";; *) fail "destroy: unknown flag not reported. Got: $out";; esac
pass=$((pass + 1))

# --keep-timeline is a recognised flag: it must PARSE (then fail later at the
# cluster call under KCTX=none), NOT trip 'unknown flag'.
out="$(KCTX=none NS=none "$PROV" destroy good --keep-timeline 2>&1)"; rc=$?
[ "$rc" -ne 0 ] || fail "destroy --keep-timeline should fail without a cluster"
case "$out" in
  *unknown\ flag*) fail "--keep-timeline wrongly rejected as unknown: $out" ;;
  *invalid\ app\ name*|*is\ reserved*) fail "valid destroy name wrongly rejected: $out" ;;
  *) echo "ok - destroy accepts --keep-timeline (parsed; failed later at cluster call)" ;;
esac
pass=$((pass + 1))

# --delete-timeline is accepted as a deprecated no-op (default is now delete).
out="$(KCTX=none NS=none "$PROV" destroy good --delete-timeline 2>&1)"; rc=$?
[ "$rc" -ne 0 ] || fail "destroy --delete-timeline should fail without a cluster"
case "$out" in
  *unknown\ flag*) fail "--delete-timeline wrongly rejected as unknown: $out" ;;
  *) echo "ok - destroy still accepts legacy --delete-timeline (no-op)" ;;
esac
pass=$((pass + 1))

# reclaim-orphans is a real subcommand: it must NOT hit the usage/unknown-command
# die. It is deliberately tolerant (idempotent, best-effort drain), so with no
# cluster it finds nothing and reports its start line rather than a usage error.
out="$(KCTX=none NS=none "$PROV" reclaim-orphans 2>&1)"
case "$out" in
  *usage:\ provision-app.sh*) fail "reclaim-orphans not recognised as a subcommand: $out" ;;
  *reclaiming\ orphan*) echo "ok - reclaim-orphans is a recognised subcommand" ;;
  *) fail "reclaim-orphans did not run its reclaim path. Got: $out" ;;
esac
pass=$((pass + 1))

# A well-formed, non-reserved name must PASS validation. It then proceeds to a
# cluster call and fails there (no cluster) — but NOT with a validation message.
out="$(KCTX=none NS=none "$PROV" create "good-app1" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] || fail "expected create to fail without a cluster"
case "$out" in
  *invalid\ app\ name*|*is\ reserved*) fail "valid name 'good-app1' was wrongly rejected by validation: $out" ;;
  *) echo "ok - accepted valid name 'good-app1' (failed later at cluster call, as expected)" ;;
esac
pass=$((pass + 1))

# --- issue #89: per-app quota rendering (no cluster) ------------------------
# `render <app>` prints the substituted per-app manifest without touching the
# cluster. It is the testable seam for the tenant-quota knobs: CPU request+limit,
# memory request+limit, and Postgres max_connections. A CPU *limit* MUST now be
# rendered (it was absent before #89 — the noisy-neighbour hole).
render() { KCTX=none NS=none "$PROV" render "$@" 2>&1; }

# default render: all five quota knobs present at their defaults.
out="$(render good-app)" || fail "render good-app failed: $out"
case "$out" in *'PG_MAX_CONNECTIONS: "100"'*) ;; *) fail "default render missing PG_MAX_CONNECTIONS=100: $out";; esac
case "$out" in *'cpu: 250m'*)  ;; *) fail "default render missing cpu request 250m: $out";; esac
case "$out" in *'cpu: 1000m'*) ;; *) fail "default render missing cpu LIMIT 1000m (noisy-neighbour bound, #89): $out";; esac
case "$out" in *'memory: 256Mi'*) ;; *) fail "default render missing mem request 256Mi: $out";; esac
case "$out" in *'memory: 1Gi'*)   ;; *) fail "default render missing mem limit 1Gi: $out";; esac
# The template must carry NO unsubstituted placeholders after render.
case "$out" in *'__'*) fail "render left an unsubstituted __PLACEHOLDER__: $out";; esac
echo "ok - render defaults: cpu req+LIMIT, mem req+limit, max_connections=100"
pass=$((pass + 1))

# a CPU limit AND a CPU request must both appear (the limit is the new bound).
n_cpu="$(printf '%s\n' "$out" | grep -c 'cpu:')"
[ "$n_cpu" -ge 2 ] || fail "expected both a cpu request and a cpu limit, found $n_cpu 'cpu:' lines"
echo "ok - both cpu request and cpu limit rendered (limit bounds a CPU burn)"
pass=$((pass + 1))

# per-app override: --max-conns bounds one tenant's server-side backends.
out="$(render good-app --max-conns 25)" || fail "render --max-conns failed: $out"
case "$out" in *'PG_MAX_CONNECTIONS: "25"'*) ;; *) fail "--max-conns 25 not rendered: $out";; esac
echo "ok - --max-conns 25 overrides the per-app connection cap"
pass=$((pass + 1))

# per-app override: CPU/mem limits are tunable per tenant.
out="$(render good-app --cpu-limit 500m --mem-limit 512Mi --cpu-request 100m --mem-request 128Mi)" \
  || fail "render cpu/mem override failed: $out"
for want in 'cpu: 500m' 'memory: 512Mi' 'cpu: 100m' 'memory: 128Mi'; do
  case "$out" in *"$want"*) ;; *) fail "override render missing '$want': $out";; esac
done
echo "ok - per-app cpu/mem request+limit overrides render"
pass=$((pass + 1))

# render validates the app name too (a bad name never renders an object).
out="$(render Bad 2>&1)" && fail "render accepted an invalid name"
case "$out" in *invalid\ app\ name*) echo "ok - render rejects an invalid app name"; pass=$((pass + 1));; *) fail "render: bad name not rejected by validation: $out";; esac

# an unknown flag to render is refused (a typo never silently no-ops).
out="$(render good-app --bogus 2>&1)" && fail "render accepted an unknown flag"
case "$out" in *unknown\ flag*) echo "ok - render rejects an unknown flag"; pass=$((pass + 1));; *) fail "render: unknown flag not reported: $out";; esac

echo "provision-app.sh validation: $pass cases — PASSED"
