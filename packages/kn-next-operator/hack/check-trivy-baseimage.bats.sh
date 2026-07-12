#!/usr/bin/env bash
# hack/check-trivy-baseimage.bats.sh — TDD harness for the Trivy HIGH/CRITICAL
# triage (refs #117).
#
# WHY THIS TEST EXISTS
# --------------------
# operator-supply-chain.yml builds the operator image and runs
#   trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1
# On main that step is gated to FAIL the run, and every publishing step (cosign
# sign/verify, build-installer + digest-repin, Release-asset upload) is gated
# `if: ref==main` AFTER Trivy — so a single HIGH/CRITICAL finding blocks the
# whole bundle publish and leaves dist/install.yaml pinned to the all-zeros
# placeholder digest (ImagePullBackOff on a clean cluster).
#
# The scanned image is `gcr.io/distroless/static:nonroot` + a CGO-disabled Go
# `manager` binary. With `--ignore-unfixed` the distroless base contributes no
# fixable findings; the only fixable HIGH/CRITICAL surface is the **Go stdlib
# version baked into the binary**, which Trivy reads from the binary build-info.
# That version is whatever the BUILDER stage `FROM golang:<tag>` resolves to.
#
# A floating `golang:1.25` tag is therefore the root cause: it is not pinned to
# a patched point release, so a stale-cached or unpatched 1.25.x leaks a fixable
# Go CVE into the binary and trips the gate. The remediation (and the invariant
# this test enforces) is: the builder MUST be pinned to a specific, patched Go
# point release (golang:1.25.N, N >= MIN_PATCH) — never a floating minor tag.
#
# This is the deterministic, offline-checkable proxy for "Trivy goes green":
# the effective end-to-end test is the CI Trivy scan itself (see
# `make trivy-scan` / operator-supply-chain.yml), which needs the ~98MB Trivy DB
# and a Docker daemon and so cannot run in every sandbox.
#
# Usage: bash hack/check-trivy-baseimage.bats.sh   (from packages/kn-next-operator/)
# Exit 0 = all pass, 1 = a failure.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE="$PKG_ROOT/Dockerfile"
FAILS=0

# Minimum patched Go point release the builder must use. Bump this when a newer
# Go stdlib CVE lands; it is the single knob that keeps the binary patched.
# 12: CVE-2026-39822 (os.Root symlink following, HIGH) fixed in 1.25.12.
MIN_PATCH=12

assert() { # <desc> <cmd...>
  local desc="$1"; shift
  if "$@"; then echo "PASS: $desc"; else echo "FAIL: $desc"; FAILS=$((FAILS+1)); fi
}

# 1. The builder stage must pin a SPECIFIC Go point release, not a floating
#    minor tag. `FROM golang:1.25` (no third component) is rejected.
BUILDER_LINE="$(grep -E '^[[:space:]]*FROM[[:space:]]+golang:' "$DOCKERFILE" | head -1)"
assert "Dockerfile has a golang builder FROM line" \
  bash -c "[ -n \"$BUILDER_LINE\" ]"

GO_TAG="$(printf '%s\n' "$BUILDER_LINE" | sed -E 's/.*golang:([0-9A-Za-z._-]+).*/\1/')"
assert "builder Go tag is a pinned point release golang:X.Y.Z (not floating golang:X.Y)" \
  bash -c "printf '%s' '$GO_TAG' | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+'"

# 2. The pinned point release must be >= MIN_PATCH on the 1.25 line (or any newer
#    minor), so the Go-stdlib CVEs Trivy flags are fixed in the binary.
GO_MAJOR="$(printf '%s' "$GO_TAG" | cut -d. -f1)"
GO_MINOR="$(printf '%s' "$GO_TAG" | cut -d. -f2)"
GO_PATCH="$(printf '%s' "$GO_TAG" | cut -d. -f3 | grep -oE '^[0-9]+' || echo 0)"
assert "builder Go is patched (>= 1.25.$MIN_PATCH, or a newer minor)" \
  bash -c "[ '$GO_MAJOR' -gt 1 ] || { [ '$GO_MAJOR' -eq 1 ] && { [ '$GO_MINOR' -gt 25 ] || { [ '$GO_MINOR' -eq 25 ] && [ '$GO_PATCH' -ge $MIN_PATCH ]; }; }; }"

# 3. No floating `golang:1.25` (bare minor) anywhere in the Dockerfile — guards
#    against a second builder stage regressing the pin.
assert "no floating bare-minor golang:X.Y tag remains in the Dockerfile" \
  bash -c "! grep -Eq 'golang:[0-9]+\.[0-9]+([[:space:]]+AS|[[:space:]]*\$)' '$DOCKERFILE'"

# 4. The runtime base stays distroless (no fat base sneaking in HIGH/CRITICALs).
assert "runtime base is gcr.io/distroless/static" \
  grep -qE '^[[:space:]]*FROM[[:space:]]+gcr\.io/distroless/static' "$DOCKERFILE"

if [[ "$FAILS" -gt 0 ]]; then
  echo ""; echo "ERROR: $FAILS check(s) failed."; exit 1
fi
echo ""; echo "Operator image base-image pin is Trivy-clean-by-construction (refs #117)."
