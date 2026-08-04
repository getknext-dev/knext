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
# The human-readable tag MAY (and should) be kept as a FULL-LINE comment ABOVE
# the FROM (Docker rejects trailing/inline comments on a FROM line), e.g.
#     # node:22-alpine
#     FROM node:22-alpine@sha256:<digest> AS builder
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

# Default set: SCAN for Dockerfiles, do not enumerate them.
#
# This used to be a hard-coded pair (file-manager + operator). An enumerated list
# is how the second file gets missed: `packages/kn-next/templates/app/Dockerfile.hbs`
# — the Dockerfile shipped to EVERY app created by `kn-next create` — was invisible
# to this guard purely because nobody added it to the list. Scanning makes a new
# Dockerfile covered the moment it exists, which is the whole point of a guard.
#
# `Dockerfile*` also catches the `.hbs` templates and variants like `Dockerfile.oke`.
if [[ "${#FILES[@]}" -eq 0 ]]; then
    while IFS= read -r found; do
        FILES+=("$found")
    done < <(
        find "$REPO_ROOT" \
            \( -name node_modules -o -name .git -o -name dist -o -name .next \
               -o -name .turbo -o -name .claude \) -prune -o \
            -type f -name 'Dockerfile*' -print | sort
    )
    if [[ "${#FILES[@]}" -eq 0 ]]; then
        echo "ERROR: scan found no Dockerfiles — refusing to pass vacuously." >&2
        exit 1
    fi
fi

# PRE-EXISTING unpinned Dockerfiles, recorded rather than silently un-scanned.
#
# Switching from an enumerated list to a scan surfaced four floating base tags
# that predate this guard's default set. They are REPORTED on every run and
# tracked for pinning; they do not fail the build yet, because pinning
# golang/distroless digests is a separate change with its own verification.
# A file NOT on this list and NOT pinned still FAILS — the scan fails closed.
KNOWN_UNPINNED=(
    "apps/docs/Dockerfile"
    "apps/docs/Dockerfile.oke"
    "packages/scale-zero-pg/gateway/Dockerfile"
    "packages/scale-zero-pg/demo/app/Dockerfile"
)

is_known_unpinned() {
    local rel="${1#"$REPO_ROOT"/}"
    local known
    for known in "${KNOWN_UNPINNED[@]}"; do
        [[ "$rel" == "$known" ]] && return 0
    done
    return 1
}

VIOLATIONS=0
EXEMPTED=0
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
        elif is_known_unpinned "$file"; then
            # Reported ALWAYS (even with --quiet): a tracked exception that
            # nobody sees is just an un-scanned file with extra steps.
            echo "KNOWN-UNPINNED: $file:$lineno  $image (pre-existing; tracked for pinning)"
            EXEMPTED=$((EXEMPTED + 1))
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

if [[ "$EXEMPTED" -gt 0 ]]; then
    # Do NOT claim everything is pinned when it is not — an inaccurate green is
    # how a tracked exception turns into a forgotten one.
    echo "Scanned ${#FILES[@]} Dockerfile(s): all pinned EXCEPT $EXEMPTED known-unpinned FROM line(s) listed above."
else
    echo "All Dockerfile base images are digest-pinned (scanned ${#FILES[@]} file(s))."
fi
