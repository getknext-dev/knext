#!/usr/bin/env bash
# Builds the ceiling-test kubelet: upstream v1.34.10 with one constant changed (kubelet-patch.diff).
# Offline and local. Makes no cluster call, pushes nothing, and writes no binary into the repo.
#
#   scripts/bench-cold-start-phases/ceiling/build.sh [outdir]
#
# Output (default: $TMPDIR/kubelet-ceiling-build):
#   kubelet-v1.34.10-relist100ms-linux-amd64   the patched binary
#   kubelet-v1.34.10-stock-linux-amd64         the same toolchain and flags, unpatched (control build)
#   SHA256SUMS                                 checksums of both, plus the source commit and toolchain
#
# The tag is pinned to a commit and the patch must apply to exactly that source. The
# toolchain is the one .go-version names for the v1.34 line. GO_TOOLCHAIN=go1.x.y overrides it, and
# the build then checks that `go version` reports exactly that toolchain; a different toolchain gives
# a different checksum, so the checksums in RUNBOOK.md only hold for the default.
# KUBELET_CEILING_GOARCH (default amd64) selects the target architecture, for a rehearsal on an
# arm64 kind node; the amd64 file names and checksums are unchanged. A non-amd64 build REQUIRES an explicit
# outdir, so it can never overwrite the amd64 SHA256SUMS in the default one.
# CGO is off, so the binary is not byte-identical to an upstream release build (see RUNBOOK.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="v1.34.10"
COMMIT="bd6c4ad159ac77a879838b8f14f23a49bf97de5f"
REPO="https://github.com/kubernetes/kubernetes.git"
GO_TOOLCHAIN="${GO_TOOLCHAIN:-go1.25.12}"
ARCH="${KUBELET_CEILING_GOARCH:-amd64}"
case "$ARCH" in amd64|arm64) ;; *) echo "KUBELET_CEILING_GOARCH must be amd64 or arm64, got $ARCH" >&2; exit 1 ;; esac
if [ "$ARCH" != amd64 ] && [ "$#" -eq 0 ]; then
  echo "KUBELET_CEILING_GOARCH=$ARCH needs an explicit output directory: the default one holds the amd64 SHA256SUMS" >&2
  exit 1
fi
OUT="${1:-${TMPDIR:-/tmp}/kubelet-ceiling-build}"
WORK="${KUBELET_CEILING_WORK:-$OUT/src}"

mkdir -p "$OUT"
if [ ! -d "$WORK/.git" ]; then
  git clone --depth 1 --branch "$TAG" "$REPO" "$WORK"
fi

GOT="$(git -C "$WORK" rev-parse 'HEAD^{commit}')"
[ "$GOT" = "$COMMIT" ] || { echo "source is $GOT, expected $COMMIT for $TAG" >&2; exit 1; }
git -C "$WORK" reset --hard -q "$COMMIT"
git -C "$WORK" clean -fdq

# Control build first, from the untouched tree.
GOTC="$(GOTOOLCHAIN="$GO_TOOLCHAIN" go version)"
echo "toolchain: $GOTC"
case "$GOTC" in
  *" $GO_TOOLCHAIN "*) ;;
  *) echo "toolchain is not $GO_TOOLCHAIN ($GOTC); set GO_TOOLCHAIN deliberately" >&2; exit 1 ;;
esac

COMMIT_DATE="$(git -C "$WORK" log -1 --format=%cI "$COMMIT")"
ldflags() {
  printf '%s ' \
    "-X k8s.io/component-base/version.gitMajor=1" \
    "-X k8s.io/component-base/version.gitMinor=34" \
    "-X k8s.io/component-base/version.gitVersion=$TAG" \
    "-X k8s.io/component-base/version.gitCommit=$COMMIT" \
    "-X k8s.io/component-base/version.gitTreeState=$1" \
    "-X k8s.io/component-base/version.buildDate=$COMMIT_DATE"
}

build() { # $1 output path, $2 tree state label
  (
    cd "$WORK"
    GOTOOLCHAIN="$GO_TOOLCHAIN" GOOS=linux GOARCH="$ARCH" CGO_ENABLED=0 \
      go build -trimpath -buildvcs=false -ldflags "$(ldflags "$2")" -o "$1" ./cmd/kubelet
  )
}

build "$OUT/kubelet-v1.34.10-stock-linux-$ARCH" clean

# Apply the one-line patch, then build the patched binary.
git -C "$WORK" apply --check "$HERE/kubelet-patch.diff"
git -C "$WORK" apply "$HERE/kubelet-patch.diff"
git -C "$WORK" --no-pager diff --stat
build "$OUT/kubelet-v1.34.10-relist100ms-linux-$ARCH" modified

(
  cd "$OUT"
  {
    echo "# source: $REPO $TAG = $COMMIT"
    echo "# toolchain: $GOTC (GOOS=linux GOARCH=$ARCH CGO_ENABLED=0 -trimpath -buildvcs=false)"
    shasum -a 256 "kubelet-v1.34.10-stock-linux-$ARCH" "kubelet-v1.34.10-relist100ms-linux-$ARCH"
  } | tee SHA256SUMS
)
