#!/usr/bin/env bash
# Runs inside Cloud Build (ubuntu:24.04 step, see cloudbuild.yaml). Builds a RELEASE Bun from
# UPSTREAM_SHA + patches/*.patch for linux-x64-musl and linux-aarch64-musl, cross-compiled from the
# x64 host with Alpine-derived musl sysroots — the same shape oven-sh/bun's CI uses (all Linux
# targets cross-compiled from one host via --os/--arch/--abi + a sysroot).
#
# CI-verification only: the binaries this produces are never shipped to users (see README.md).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive HOME=/root LC_ALL=C
WS=/workspace
SRC=$WS/bun
OUT=$WS/out
# Toolchain pins. LLVM/Alpine track oven-sh/bun's scripts/build/ci-images/spec.ts at UPSTREAM_SHA;
# rust comes from the repo's own rust-toolchain.toml.
#
# Every fetch below is checked against a value committed here, not against a digest served by the
# same origin. When an upstream rotates a pinned artifact out (apt.llvm.org and the Alpine CDN keep
# only the latest build), the build FAILS CLOSED and a maintainer bumps the pin — see README.md,
# "Toolchain pins". What remains unpinned is listed there too.
LLVM_MAJOR=23
LLVM_PKG_VERSION='1:23.1.2~++20260919103626+4b1925210476-1~exp1~20260919223755.77'
LLVM_KEY_FPR=6084F3CF814B57C1CF12EFD515CF4D18AF4F7421 # apt.llvm.org archive signing key
ALPINE_RELEASE=3.23
APK_TOOLS_STATIC_VERSION=3.0.8-r0
APK_TOOLS_STATIC_SHA256=2edccd3267ce540f8d2371a0f394e84b40d8348ecc28425309e6d07079ed1259
BOOTSTRAP_BUN=1.4.2
BOOTSTRAP_BUN_ZIP_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
RUSTUP_VERSION=1.29.1
RUSTUP_INIT_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
TARGETS="${BUN_BASE_TARGETS:-x64 aarch64}"

T0=$(date +%s)
lap() { echo "### LAP $1 t=$(($(date +%s) - T0))s"; }

PREFIX="$(bash "$WS/prefix.sh")"
UPSTREAM_SHA="${PREFIX%%-*}"
echo "prefix=$PREFIX"

# ── patch header lint (before any expensive work) ────────────────────────────
shopt -s nullglob
PATCHES=("$WS"/patches/*.patch)
for p in "${PATCHES[@]}"; do
  name="$(basename "$p")"
  [[ "$name" =~ ^[0-9]{3}-[a-z0-9-]+\.patch$ ]] || { echo "patch $name: bad filename (want <nnn>-<upstream-issue>-<slug>.patch)" >&2; exit 1; }
  grep -Eq 'oven-sh/bun#[0-9]+' "$p" || { echo "patch $name: header must name the upstream issue/PR (oven-sh/bun#N)" >&2; exit 1; }
  grep -Eq 'knext-shim: [A-Za-z0-9._-]+' "$p" || { echo "patch $name: header must name the F1 registry id it retires (knext-shim: <id>)" >&2; exit 1; }
done

# ── toolchain ────────────────────────────────────────────────────────────────
apt-get update -qq
apt-get install -y -qq curl wget ca-certificates lsb-release gnupg cmake git golang libtool ninja-build \
  pkg-config ruby-full xz-utils nasm unzip python3 build-essential libicu-dev perl zstd file >/dev/null
# apt.llvm.org key: accepted only if it is exactly one primary key with the pinned fingerprint, and
# scoped (signed-by) to the LLVM source alone rather than trusted for every apt source.
wget -qO /tmp/llvm.asc https://apt.llvm.org/llvm-snapshot.gpg.key
gpg --show-keys --with-colons /tmp/llvm.asc >/tmp/llvm.colons
[ "$(grep -c '^pub:' /tmp/llvm.colons)" = 1 ] || { echo "apt.llvm.org key: expected exactly one primary key" >&2; exit 1; }
fpr="$(awk -F: '/^fpr:/ && !n++ {print $10}' /tmp/llvm.colons)"
[ "$fpr" = "$LLVM_KEY_FPR" ] || { echo "apt.llvm.org key fingerprint $fpr != pinned $LLVM_KEY_FPR" >&2; exit 1; }
mkdir -p /etc/apt/keyrings && gpg --dearmor </tmp/llvm.asc >/etc/apt/keyrings/apt.llvm.org.gpg
echo "deb [signed-by=/etc/apt/keyrings/apt.llvm.org.gpg] http://apt.llvm.org/$(lsb_release -cs)/ llvm-toolchain-$(lsb_release -cs)-$LLVM_MAJOR main" \
  >/etc/apt/sources.list.d/llvm.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends clang-$LLVM_MAJOR="$LLVM_PKG_VERSION" \
  lld-$LLVM_MAJOR="$LLVM_PKG_VERSION" llvm-$LLVM_MAJOR="$LLVM_PKG_VERSION" \
  libclang-rt-$LLVM_MAJOR-dev="$LLVM_PKG_VERSION" libclang-common-$LLVM_MAJOR-dev="$LLVM_PKG_VERSION" >/dev/null \
  || { echo "LLVM $LLVM_PKG_VERSION is no longer on apt.llvm.org — bump LLVM_PKG_VERSION (README: Toolchain pins)" >&2; exit 1; }
for t in clang clang++ ld.lld llvm-ar llvm-ranlib llvm-strip llvm-objcopy; do
  ln -sf /usr/bin/$t-$LLVM_MAJOR /usr/local/bin/$t
done
# Bootstrap bun: the release zip, checked against the sha256 pinned above (and, as a second opinion,
# the release's own SHASUMS256.txt).
cd /tmp
base="https://github.com/oven-sh/bun/releases/download/bun-v$BOOTSTRAP_BUN"
curl -fsSLO "$base/bun-linux-x64.zip"
echo "$BOOTSTRAP_BUN_ZIP_SHA256  bun-linux-x64.zip" | sha256sum -c -
curl -fsSLO "$base/SHASUMS256.txt"
grep -qxF "$BOOTSTRAP_BUN_ZIP_SHA256  bun-linux-x64.zip" SHASUMS256.txt
unzip -q bun-linux-x64.zip && install -m755 bun-linux-x64/bun /usr/local/bin/bun
# rustup-init by version, checked against the pinned sha256 — never `curl sh.rustup.rs | sh`.
curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rustup-init \
  "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init"
echo "$RUSTUP_INIT_SHA256  /tmp/rustup-init" | sha256sum -c -
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --profile minimal --default-toolchain none --no-modify-path
export PATH=$HOME/.cargo/bin:$PATH
lap toolchain

# ── musl sysroots (spec.ts muslSysroot: apk.static into a fresh root, both arches) ──
repo="https://dl-cdn.alpinelinux.org/alpine/v$ALPINE_RELEASE/main"
# apk.static itself is pinned by sha256 (it is what would verify everything else, so it cannot verify
# itself). The Alpine CDN keeps only the latest -rN, so a bump there fails this closed.
# An .apk is concatenated gzip members (signature, control, data): -i reads past the first end-of-archive.
mkdir -p /tmp/apk
curl -fsSL "$repo/x86_64/apk-tools-static-$APK_TOOLS_STATIC_VERSION.apk" -o /tmp/apk-tools-static.apk \
  || { echo "apk-tools-static-$APK_TOOLS_STATIC_VERSION is gone from the CDN — bump the pin (README: Toolchain pins)" >&2; exit 1; }
echo "$APK_TOOLS_STATIC_SHA256  /tmp/apk-tools-static.apk" | sha256sum -c -
tar -xzi -f /tmp/apk-tools-static.apk -C /tmp/apk sbin/apk.static
test -x /tmp/apk/sbin/apk.static
# Alpine's signing keys are checked in (keys/<arch>/, copied from the digest-pinned alpine:3.23
# image's /usr/share/apk/keys/<arch>); their fingerprints are in keys/SHA256SUMS. apk verifies the
# index and every package against them — no --allow-untrusted.
(cd "$WS/keys" && sha256sum -c --strict SHA256SUMS)
for pair in x64:x86_64:/opt/linux-sysroot-musl aarch64:aarch64:/opt/linux-sysroot-musl-arm64; do
  IFS=: read -r _ apkarch root <<<"$pair"
  mkdir -p "$root"
  /tmp/apk/sbin/apk.static --arch "$apkarch" --root "$root" --repository "$repo" \
    --keys-dir "$WS/keys/$apkarch" --no-cache --initdb add musl-dev libc-dev linux-headers g++ libstdc++-dev >/dev/null
  rm -f "$root/var/log/apk.log"
done
lap sysroots

# ── source at the pin, patches applied ───────────────────────────────────────
git init -q "$SRC"
cd "$SRC"
git remote add origin https://github.com/oven-sh/bun.git
git fetch -q --depth 1 origin "$UPSTREAM_SHA"
git checkout -q FETCH_HEAD
test "$(git rev-parse HEAD)" = "$UPSTREAM_SHA"
if [ ${#PATCHES[@]} -gt 0 ]; then
  # Fixed committer + author date keeps the patched HEAD (embedded as Bun's revision) reproducible.
  GIT_COMMITTER_NAME=knext-bun-base GIT_COMMITTER_EMAIL=bun-base@knext.invalid \
    git am --committer-date-is-author-date "${PATCHES[@]}"
fi
HEAD_SHA="$(git rev-parse HEAD)"
rustup toolchain install
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
bun install --frozen-lockfile
lap source

# ── build ────────────────────────────────────────────────────────────────────
mkdir -p "$OUT"
for arch in $TARGETS; do
  bd="build/release-linux-$arch-musl"
  bun scripts/build.ts --profile=release --os=linux --arch="$arch" --abi=musl --canary=off \
    --build-dir="$bd" 2>&1 | tail -n 60
  test -x "$bd/bun"
  install -m755 "$bd/bun" "$OUT/bun-linux-$arch-musl"
  file "$OUT/bun-linux-$arch-musl"
  lap "build-$arch"
done

# Sanity: the x64 binary runs under its own musl loader (no emulation needed on this host).
if [ -x "$OUT/bun-linux-x64-musl" ]; then
  LD=/opt/linux-sysroot-musl/lib/ld-musl-x86_64.so.1
  "$LD" --library-path /opt/linux-sysroot-musl/usr/lib:/opt/linux-sysroot-musl/lib \
    "$OUT/bun-linux-x64-musl" --revision | tee "$OUT/bun-linux-x64-musl.revision"
  grep -q "${HEAD_SHA:0:9}" "$OUT/bun-linux-x64-musl.revision"
fi

cat >"$OUT/manifest.json" <<JSON
{
  "purpose": "CI verification of upstream Bun fixes only; never shipped to users",
  "upstream": "https://github.com/oven-sh/bun",
  "upstream_sha": "$UPSTREAM_SHA",
  "patched_head": "$HEAD_SHA",
  "prefix": "$PREFIX",
  "patches": [$(for p in "${PATCHES[@]}"; do printf '"%s",' "$(basename "$p")"; done | sed 's/,$//')],
  "targets": [$(for a in $TARGETS; do printf '"bun-linux-%s-musl",' "$a"; done | sed 's/,$//')],
  "profile": "release (ThinLTO), canary=off",
  "build_id": "${BUILD_ID:-local}"
}
JSON
echo "$PREFIX" >"$WS/.prefix"
lap done
