#!/usr/bin/env bash
# Mutation proof for the webhook-down / skew diagnosis guards (#314, sprint 2 S11).
#
# A guard that stays green when the behaviour it protects is removed is
# decoration. This script deletes each protected behaviour in turn and requires
# the corresponding test to go RED, then restores the file and requires it to be
# byte-identical again.
#
# It never uses `perl`: a silently-failed substitution yields a green run that
# proves nothing. Every mutation asserts its anchor occurs EXACTLY ONCE and
# aborts otherwise, and the substitution is verified to have changed the file.
#
# The e2e's own mutation proof (webhook is restored, the identical frozen apply
# must then succeed) is IN BAND — see test/e2e/webhook_down_freeze_test.go step
# 5. This script covers the cheap always-run lane: the diagnosis function and
# the admission-surface premises.
#
# Usage:  packages/kn-next-operator/hack/mutation-prove-webhook-down.sh

set -euo pipefail

cd "$(dirname "$0")/.."

DIAGNOSE="test/utils/diagnose.go"
WEBHOOK_MANIFEST="config/webhook/manifests.yaml"

pass=0
fail=0

checksum() { shasum -a 256 "$1" | awk '{print $1}'; }

# mutate <file> <anchor> <replacement>
# Asserts the anchor occurs exactly once, then replaces that one occurrence.
mutate() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, anchor, replacement = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path, encoding="utf-8").read()
n = src.count(anchor)
if n != 1:
    sys.exit(f"ABORT: anchor occurs {n} times in {path} (expected exactly 1): {anchor!r}")
out = src.replace(anchor, replacement, 1)
if out == src:
    sys.exit(f"ABORT: substitution changed nothing in {path}")
open(path, "w", encoding="utf-8").write(out)
PY
}

# prove <label> <file> <anchor> <replacement> <test-cmd...>
# The test command MUST fail while the mutation is in place.
prove() {
  local label="$1" file="$2" anchor="$3" replacement="$4"
  shift 4

  local before after backup
  before="$(checksum "$file")"
  backup="$(mktemp)"
  cp "$file" "$backup"

  echo "── mutation: ${label}"
  mutate "$file" "$anchor" "$replacement"

  if "$@" >/dev/null 2>&1; then
    echo "   ✗ DECORATION: the test stayed GREEN with the behaviour removed"
    fail=$((fail + 1))
  else
    echo "   ✓ went RED as required"
    pass=$((pass + 1))
  fi

  cp "$backup" "$file"
  rm -f "$backup"
  after="$(checksum "$file")"
  if [ "$before" != "$after" ]; then
    echo "   ✗ FATAL: ${file} was not restored byte-identically" >&2
    exit 1
  fi
}

echo "Baseline: the guards must be GREEN before anything is mutated."
go test ./test/utils/ -run TestDiagnose >/dev/null
go test ./internal/webhook/v1alpha1/ -run 'TestWebhookIs|TestNoDefaultingWebhook' >/dev/null
echo "   ✓ baseline green"
echo

# 1. Remove the SKEW branch. Every skew-shaped message then diagnoses as
#    something else — which is precisely the misdiagnosis this task exists to
#    prevent (a webhook outage read as skew, or vice versa).
prove "diagnosis: delete the schema-skew branch" \
  "$DIAGNOSE" \
  "	case schemaSkewRe.MatchString(msg):" \
  "	case false: // MUTATED" \
  go test ./test/utils/ -run TestDiagnose

# 2. Remove the WEBHOOK-DOWN branch. A real outage then reports as something
#    else, and the e2e's freeze diagnosis would be meaningless.
prove "diagnosis: delete the webhook-unreachable branch" \
  "$DIAGNOSE" \
  "	case webhookUnreachableRe.MatchString(msg):" \
  "	case false: // MUTATED" \
  go test ./test/utils/ -run TestDiagnose

# 3. Flip the webhook to fail-OPEN. That deletes the deploy freeze itself: with
#    failurePolicy: Ignore the apiserver admits unvalidated writes whenever the
#    operator is down, so the e2e's premise is gone. The unit guard must catch
#    it without a cluster.
prove "admission surface: flip failurePolicy to Ignore (fail-open)" \
  "$WEBHOOK_MANIFEST" \
  "  failurePolicy: Fail" \
  "  failurePolicy: Ignore" \
  go test ./internal/webhook/v1alpha1/ -run TestWebhookIsFailClosed

# 4. Add the anti-item shortcut: a namespaceSelector narrowing the admission
#    surface. It must be caught in the unit lane, not discovered in review.
prove "admission surface: add the forbidden namespaceSelector" \
  "$WEBHOOK_MANIFEST" \
  "  failurePolicy: Fail" \
  "  failurePolicy: Fail
  namespaceSelector:
    matchLabels:
      test-convenience: \"true\"" \
  go test ./internal/webhook/v1alpha1/ -run TestWebhookIsNotSelectorScoped

# 5. CLUSTER MUTATION (opt-in: needs the kind cluster the e2e runs on).
#    Never take the webhook down at all, and require the deploy-freeze suite to
#    go RED. Be precise about what this proves: with the operator left at one
#    replica the "PROVES it is down" spec fails FIRST, so it establishes that the
#    is-it-down gate is real and cannot be satisfied by a healthy cluster — the
#    freeze specs are then skipped, not red. Their own state-dependence is proved
#    IN BAND instead, by step 5 of the suite: the webhook is restored and the
#    IDENTICAL apply that just froze is required to succeed. Together the two
#    cover "passes with and without the webhook". Run with:
#      KIND_CLUSTER=<cluster> hack/mutation-prove-webhook-down.sh --with-cluster
if [ "${1:-}" = "--with-cluster" ]; then
  echo
  prove "e2e: never take the webhook down (scale to 1 instead of 0)" \
    "test/e2e/webhook_down_freeze_test.go" \
    '"-n", freezeOperatorNamespace, "--replicas=0")' \
    '"-n", freezeOperatorNamespace, "--replicas=1")' \
    make test-e2e-webhook-down
fi

echo
echo "mutations proved: ${pass}  decoration found: ${fail}"
[ "$fail" -eq 0 ] || exit 1
