#!/usr/bin/env bash
# hack/check-no-latest.sh — CI guard that FAILS if any operator deployment
# manifest or Makefile IMG default still references a ":latest" image tag.
#
# This enforces the digest-pinning requirement from ADR-0001 / A1-placeholder:
# the operator's own controller image must be pinned by digest, not by :latest.
#
# Usage:
#   bash hack/check-no-latest.sh          # from packages/kn-next-operator/
#   bash hack/check-no-latest.sh --quiet  # suppress passing-file output
#
# Exit codes:
#   0 — no :latest violations found
#   1 — one or more violations found (fails CI)

set -uo pipefail

QUIET=false
[[ "${1:-}" == "--quiet" ]] && QUIET=true

# Files to inspect — relative to the script's package root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FILES_TO_CHECK=(
    "$PKG_ROOT/config/manager/manager.yaml"
    "$PKG_ROOT/Makefile"
)

VIOLATIONS=0

for file in "${FILES_TO_CHECK[@]}"; do
    if [[ ! -f "$file" ]]; then
        echo "WARN: file not found, skipping: $file" >&2
        continue
    fi

    # Match lines that contain an image reference ending in :latest.
    # The pattern catches:
    #   image: controller:latest
    #   IMG ?= controller:latest
    # but NOT lines that are comments or that already have @sha256:.
    matching=$(grep -nE '^\s*(image:|IMG\s*\??=)\s*[^#]*:latest' "$file" || true)

    if [[ -n "$matching" ]]; then
        echo "FAIL: :latest image reference found in $file:"
        echo "$matching" | sed 's/^/  /'
        VIOLATIONS=$((VIOLATIONS + 1))
    else
        $QUIET || echo "OK:   $file"
    fi
done

if [[ "$VIOLATIONS" -gt 0 ]]; then
    echo ""
    echo "ERROR: $VIOLATIONS file(s) contain :latest image references."
    echo "       Replace with a digest-pinned ref (e.g. image: controller@sha256:<hash>)."
    exit 1
fi

echo "All operator manifests are :latest-free."
