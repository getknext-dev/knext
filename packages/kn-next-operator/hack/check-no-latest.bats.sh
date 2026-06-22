#!/usr/bin/env bash
# hack/check-no-latest.bats.sh — lightweight TDD harness for issue #76.
#
# Verifies the two load-bearing invariants of the installable-bundle work:
#   1. The committed manager manifests reference the getknext-dev owner and are
#      digest-pinned (no :latest, no stale ahmedelbanna80 owner).
#   2. The release-time digest-substitution sed (mirrored from
#      operator-supply-chain.yml) rewrites a placeholder digest into a real one
#      while keeping the combined `newTag: <tag>@sha256:<hash>` form that
#      check-no-latest.sh accepts.
#
# Usage: bash hack/check-no-latest.bats.sh   (from packages/kn-next-operator/)
# Exit 0 = all pass, 1 = a failure.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FAILS=0

assert() { # <desc> <cmd...>
  local desc="$1"; shift
  if "$@"; then echo "PASS: $desc"; else echo "FAIL: $desc"; FAILS=$((FAILS+1)); fi
}

# 1a. Owner is getknext-dev, not the stale ahmedelbanna80, in manager.yaml + kustomization.
assert "manager.yaml uses getknext-dev owner" \
  grep -q 'ghcr.io/getknext-dev/kn-next-operator' "$PKG_ROOT/config/manager/manager.yaml"
assert "kustomization.yaml uses getknext-dev owner" \
  grep -q 'ghcr.io/getknext-dev/kn-next-operator' "$PKG_ROOT/config/manager/kustomization.yaml"
assert "no stale ahmedelbanna80 owner remains in manager.yaml" \
  bash -c "! grep -q 'ahmedelbanna80' '$PKG_ROOT/config/manager/manager.yaml'"
assert "no stale ahmedelbanna80 owner remains in kustomization.yaml" \
  bash -c "! grep -q 'ahmedelbanna80' '$PKG_ROOT/config/manager/kustomization.yaml'"

# 1b. The existing :latest / digest-pin guard passes.
assert "check-no-latest.sh passes" \
  bash "$PKG_ROOT/hack/check-no-latest.sh" --quiet

# 2. The release-time digest substitution produces a valid combined digest ref.
# The workflow runs GNU sed on ubuntu; here we use perl so the same regex is
# verified portably (BSD sed on macOS rejects the \1 backreference form).
TMP="$(mktemp)"
printf '  newTag: v0.1.0@sha256:%064d\n' 0 > "$TMP"
REAL="sha256:abc1230000000000000000000000000000000000000000000000000000000def"
perl -i -pe "s|(newTag: v[0-9]+\.[0-9]+\.[0-9]+\@sha256:)[0-9a-f]{64}|\${1}${REAL#sha256:}|" "$TMP"
assert "sed substitutes the real digest into the combined newTag" \
  grep -q "newTag: v0.1.0@sha256:abc1230000000000000000000000000000000000000000000000000000000def" "$TMP"
# The substituted line must still be a single @sha256: combined ref (guard-safe):
# no bare newTag, exactly one @sha256:.
assert "substituted ref keeps the combined @sha256: form" \
  bash -c "grep -q '@sha256:' '$TMP' && [ \"\$(grep -c '@sha256:' '$TMP')\" = '1' ]"
rm -f "$TMP"

if [[ "$FAILS" -gt 0 ]]; then
  echo ""; echo "ERROR: $FAILS check(s) failed."; exit 1
fi
echo ""; echo "All #76 install-bundle invariants hold."
