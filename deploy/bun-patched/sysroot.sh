#!/usr/bin/env bash
# Cloud Build step 1 (ubuntu:20.04, digest-pinned in cloudbuild.yaml): the glibc 2.31 + gcc-13
# libstdc++ sysroot Bun's own release lanes link against (oven-sh/bun scripts/bootstrap.sh
# install_linux_glibc_sysroot at bun-v1.4.2). Building against it keeps the patched toolchain's
# glibc symbol versions at <= 2.31, so it runs on the same hosts stock Bun 1.4.2 does — not only on
# whatever glibc the build host has.
#
# Bun's recipe copies an ubuntu:20.04 rootfs with skopeo; this step IS an ubuntu:20.04 container, so
# its own filesystem is that rootfs. aarch64 comes from the same focal release through dpkg
# multiarch (ports.ubuntu.com). gcc-13 is the mirrored focal build Bun's recipe uses
# (oven-sh/WebKit release gcc-13-focal-debs), checked against fetch-pins.sha256.
#
# Usage: sysroot.sh <x64|aarch64>   → /workspace/sysroot-<target>.tar
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
WS=/workspace
TARGET="$1"
case "$TARGET" in
  x64) DEBARCH=amd64; TRIPLE=x86_64-linux-gnu; SUFFIX='' ;;
  aarch64) DEBARCH=arm64; TRIPLE=aarch64-linux-gnu; SUFFIX=':arm64' ;;
  *) echo "sysroot.sh: unknown target '$TARGET' (want x64 or aarch64)" >&2; exit 2 ;;
esac
pin() { # pin <file-in-cwd>: exactly one fetch-pins.sha256 line, and it must match
  local line
  line="$(grep -E "^[0-9a-f]{64}  $1\$" "$WS/fetch-pins.sha256")"
  [ "$(printf '%s\n' "$line" | grep -c .)" = 1 ] || { echo "fetch-pins.sha256: need exactly one line for $1" >&2; exit 1; }
  printf '%s\n' "$line" | sha256sum -c -
}

if [ "$DEBARCH" = arm64 ]; then
  # archive.ubuntu.com carries amd64 only; arm64 focal lives on ports.ubuntu.com.
  sed -i 's/^deb http/deb [arch=amd64] http/' /etc/apt/sources.list
  for suite in focal focal-updates focal-security; do
    echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports $suite main" >>/etc/apt/sources.list
  done
  dpkg --add-architecture arm64
fi
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null
apt-get install -y -qq --no-install-recommends "libc6-dev$SUFFIX" "linux-libc-dev$SUFFIX" \
  "libcrypt-dev$SUFFIX" "libgcc-s1$SUFFIX" >/dev/null
dpkg-query -W -f='${Package}:${Architecture} ${Version}\n' libc6 "libc6$SUFFIX" linux-libc-dev"$SUFFIX" | sort -u

SR=/tmp/sysroot
mkdir -p "$SR"
# usr/include + usr/lib + lib + lib64 is what clang/lld read through --sysroot; symlinks are kept
# as symlinks (build.sh re-roots the absolute ones once the tree is at its final path).
tar -C / -cf - usr/include usr/lib lib $( [ -e /lib64 ] && echo lib64 ) | tar -C "$SR" -xf -

cd /tmp
curl -fsSLo "gcc-13-focal-$DEBARCH.tar.gz" \
  "https://github.com/oven-sh/WebKit/releases/download/gcc-13-focal-debs/gcc-13-focal-$DEBARCH.tar.gz"
pin "gcc-13-focal-$DEBARCH.tar.gz"
mkdir -p /tmp/gcc13
tar -xzf "gcc-13-focal-$DEBARCH.tar.gz" -C /tmp/gcc13
# ubuntu:20.04 is merged-/usr (`lib -> usr/lib`). `dpkg-deb -x` would replace that symlink with a
# real directory holding only the debs' files — and libc.so's linker script names
# /lib/<triple>/libc.so.6 — so extract through tar with --keep-directory-symlink.
find /tmp/gcc13 -name '*.deb' | sort | while read -r deb; do
  dpkg-deb --fsys-tarfile "$deb" | tar -x --keep-directory-symlink -C "$SR"
done
test -d "$SR/usr/include/c++/13" || { echo "sysroot: missing usr/include/c++/13 after the gcc-13 overlay" >&2; exit 1; }
test -L "$SR/lib" || { echo "sysroot: lib is no longer the merged-/usr symlink" >&2; exit 1; }
for f in "usr/lib/$TRIPLE/libc.so" "lib/$TRIPLE/libc.so.6" "usr/lib/$TRIPLE/libc_nonshared.a"; do
  test -e "$SR/$f" || { echo "sysroot: missing $f" >&2; exit 1; }
done
tar -C "$SR" -cf "$WS/sysroot-$TARGET.tar" .
ls -la "$WS/sysroot-$TARGET.tar"
