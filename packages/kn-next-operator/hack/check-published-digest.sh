#!/usr/bin/env bash
# hack/check-published-digest.sh — PUBLISHED-CONTEXT guard (issue #117).
#
# WHY THIS IS SEPARATE FROM check-no-latest.sh
# --------------------------------------------
# check-no-latest.sh runs on EVERY PR and is intentionally lenient about the
# all-zeros bootstrap placeholder digest
#   ghcr.io/getknext-dev/kn-next-operator:v0.1.0@sha256:0000…0000
# because that placeholder is DELIBERATELY committed before the operator image is
# first published (issue #76). It only rejects `:latest` / bare (non-digest) tags.
#
# This guard is the complement: it runs ONLY in a PUBLISHED / RELEASE context
# (the supply-chain workflow, AFTER the real digest has been pinned into the
# bundle). In that context the all-zeros placeholder must NOT survive — if it does,
# the digest re-pin failed and we are about to ship a bundle that references an
# image that does not exist. So here the placeholder is a HARD failure, alongside
# `:latest`.
#
# Usage:
#   bash hack/check-published-digest.sh [path-to-bundle ...]
#     Default path: packages/kn-next-operator/dist/install.yaml (resolved relative
#     to this script). Pass one or more explicit paths to check other files.
#
# Exit codes:
#   0 — bundle references a real, digest-pinned image (no :latest, no all-zeros)
#   1 — a :latest tag or an all-zeros placeholder digest was found

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# The all-zeros bootstrap placeholder digest (64 zero hex chars).
PLACEHOLDER="sha256:0000000000000000000000000000000000000000000000000000000000000000"

# Files to check: explicit args, else the default rendered bundle.
if [[ "$#" -gt 0 ]]; then
    FILES=("$@")
else
    FILES=("$PKG_ROOT/dist/install.yaml")
fi

VIOLATIONS=0

for file in "${FILES[@]}"; do
    if [[ ! -f "$file" ]]; then
        echo "FAIL: file not found (a published bundle must exist): $file" >&2
        VIOLATIONS=$((VIOLATIONS + 1))
        continue
    fi

    # 1) the all-zeros placeholder digest must be gone post-publish.
    if grep -qF "$PLACEHOLDER" "$file"; then
        echo "FAIL: all-zeros placeholder digest still present in $file:"
        grep -nF "$PLACEHOLDER" "$file" | sed 's/^/  /'
        echo "      The digest re-pin step failed — this bundle references an"
        echo "      operator image that does not exist. Do NOT publish it."
        VIOLATIONS=$((VIOLATIONS + 1))
    fi

    # 2) no :latest image reference (closes the controller:latest placeholder).
    matching=$(grep -nE '^\s*image:\s*[^#]*:latest(\s|$)' "$file" || true)
    if [[ -n "$matching" ]]; then
        echo "FAIL: :latest image reference found in $file:"
        echo "$matching" | sed 's/^/  /'
        VIOLATIONS=$((VIOLATIONS + 1))
    fi
done

if [[ "$VIOLATIONS" -gt 0 ]]; then
    echo ""
    echo "ERROR: $VIOLATIONS published-bundle violation(s)."
    echo "       A published bundle must pin a real (@sha256:<non-zero>) digest."
    exit 1
fi

echo "Published bundle is digest-pinned to a real image (no :latest, no placeholder)."
