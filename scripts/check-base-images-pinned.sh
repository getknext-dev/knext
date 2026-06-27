#!/usr/bin/env bash
# scripts/check-base-images-pinned.sh — CI guard that FAILS if any Dockerfile
# `FROM` line references a base image by a FLOATING tag instead of an immutable
# `@sha256:` digest.
#
# Why: security.md ("Supply chain") requires "Pin images by digest; reject
# :latest." The operator's controller image is already digest-pinned and guarded
# by hack/check-no-latest.sh, but the *base* images that actually determine the
# runtime CVE surface (node:22-alpine, golang:1.25, gcr.io/distroless/static)
# were floating by tag. A floating base tag means an unreviewed upstream push can
# silently change the CVE surface of an image we sign — defeating the supply-chain
# guarantees. This guard closes that gap, analogous to hadolint DL3006/DL3007.
#
# A `FROM` line is COMPLIANT iff its image reference contains `@sha256:`.
# The human-readable tag MAY (and should) be kept as a comment, e.g.
#     FROM node:22-alpine@sha256:<digest> AS builder  # node:22-alpine
# Build-stage aliases (`FROM builder`, `FROM <stage> AS ...`) and the special
# `FROM scratch` are exempt — they do not pull an external base image.
#
# Usage:
#   bash scripts/check-base-images-pinned.sh           # scan the default Dockerfiles
#   bash scripts/check-base-images-pinned.sh a/Dockerfile b/Dockerfile
#   bash scripts/check-base-images-pinned.sh --quiet   # suppress passing output
#
# Exit codes:
#   0 — every external FROM is digest-pinned
#   1 — one or more floating (non-digest) FROM lines found

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

QUIET=false
FILES=()
for arg in "$@"; do
    case "$arg" in
        --quiet) QUIET=true ;;
        *) FILES+=("$arg") ;;
    esac
done

# Default set: every Dockerfile whose base images we ship/sign.
if [[ "${#FILES[@]}" -eq 0 ]]; then
    FILES=(
        "$REPO_ROOT/apps/file-manager/Dockerfile"
        "$REPO_ROOT/packages/kn-next-operator/Dockerfile"
    )
fi

VIOLATIONS=0
# Track stage aliases declared via `AS <name>` so `FROM <alias>` is not flagged.
declare -A STAGES=()

for file in "${FILES[@]}"; do
    if [[ ! -f "$file" ]]; then
        echo "WARN: file not found, skipping: $file" >&2
        continue
    fi

    STAGES=()
    file_violations=0
    lineno=0
    while IFS= read -r line; do
        lineno=$((lineno + 1))
        # Strip a leading "# ..." comment-only line fast.
        case "$line" in
            \#*) continue ;;
        esac
        # Only inspect FROM directives (case-insensitive, allow leading spaces).
        if [[ ! "$line" =~ ^[[:space:]]*[Ff][Rr][Oo][Mm][[:space:]]+ ]]; then
            continue
        fi

        # Tokenize: FROM <image> [AS <stage>]
        read -r _from image rest <<<"$line"
        # Record any stage alias for later `FROM <alias>` exemption.
        if [[ "$rest" =~ [Aa][Ss][[:space:]]+([A-Za-z0-9_.-]+) ]]; then
            STAGES["${BASH_REMATCH[1]}"]=1
        fi

        # Exemptions: scratch, build-stage aliases.
        if [[ "$image" == "scratch" ]]; then
            $QUIET || echo "OK:   $file:$lineno  FROM scratch (no external base)"
            continue
        fi
        if [[ -n "${STAGES[$image]:-}" ]]; then
            $QUIET || echo "OK:   $file:$lineno  FROM $image (stage alias)"
            continue
        fi

        # External base image — MUST be digest-pinned.
        if [[ "$image" == *"@sha256:"* ]]; then
            $QUIET || echo "OK:   $file:$lineno  $image (digest-pinned)"
        else
            echo "FAIL: $file:$lineno  floating base image (no @sha256: digest): $image"
            file_violations=$((file_violations + 1))
        fi
    done <"$file"

    VIOLATIONS=$((VIOLATIONS + file_violations))
done

if [[ "$VIOLATIONS" -gt 0 ]]; then
    echo ""
    echo "ERROR: $VIOLATIONS Dockerfile FROM line(s) use a floating base tag."
    echo "       Pin every base image by digest, e.g.:"
    echo "         FROM node:22-alpine@sha256:<digest> AS builder  # node:22-alpine"
    echo "       Resolve a digest with: docker buildx imagetools inspect <image>"
    exit 1
fi

echo "All Dockerfile base images are digest-pinned."
