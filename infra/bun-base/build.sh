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
# Every fetch below is either checked against a value committed here (not against a digest served by
# the same origin) or is listed in unpinned-fetches.json — the SAME list README.md renders. That list
# is exhaustive for THIS script; it also names the fetches Bun's own build script makes at
# UPSTREAM_SHA that this script cannot pin. tests/bun-base-supply-chain.test.ts SCANS this file: a
# network fetch that is neither pinned nor listed fails CI. When an upstream rotates a pinned artifact
# out (apt.llvm.org and the Alpine CDN keep only the latest build) the build FAILS CLOSED and a
# maintainer bumps the pin — see README.md, "Toolchain pins".
LLVM_MAJOR=23
LLVM_PKG_VERSION='1:23.1.2~++20260919103626+4b1925210476-1~exp1~20260919223755.77'
# apt.llvm.org archive signer, written as `gpg --fingerprint` prints it; compared with spaces stripped.
# (Grouped, not one 40-hex token: see README "Secret-scan hygiene".)
LLVM_SIGNER_FPR='6084 F3CF 814B 57C1 CF12  EFD5 15CF 4D18 AF4F 7421'
ALPINE_RELEASE=3.23
APK_TOOLS_STATIC_VERSION=3.0.8-r0
BOOTSTRAP_BUN=1.4.2
RUSTUP_VERSION=1.29.1
# sha256 pins for downloaded files live in fetch-pins.sha256 (sha256sum format, one per file).
pin() { # pin <file-in-cwd> — verify it against its fetch-pins.sha256 line, exactly one line required
  local line
  line="$(grep -E "^[0-9a-f]{64}  $1\$" "$WS/fetch-pins.sha256")"
  [ "$(printf '%s\n' "$line" | grep -c .)" = 1 ] || { echo "fetch-pins.sha256: need exactly one line for $1" >&2; exit 1; }
  printf '%s\n' "$line" | sha256sum -c -
}
TARGETS="${BUN_BASE_TARGETS:-x64 aarch64}"

# No arithmetic, array, subscript or slice anywhere in this file (the guard bans all of them): step
# timing is a wall-clock stamp per phase, and Cloud Build's own step timing is the duration of record.
# Every variable is bound exactly once (the guard counts binding sites; see README "Toolchain
# pins"), so nothing a check compares can be rebound around it — give a new loop its own name.
lap() { echo "### LAP $1 at $(date -u +%T)"; }

PREFIX="$(bash "$WS/prefix.sh")"
UPSTREAM_SHA="${PREFIX%%-*}"
echo "prefix=$PREFIX"

# ── patch header lint (before any expensive work) ────────────────────────────
shopt -s nullglob
have_patches=no
for p in "$WS"/patches/*.patch; do
  have_patches=yes
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
[ "$fpr" = "${LLVM_SIGNER_FPR// /}" ] || { echo "apt.llvm.org key fingerprint $fpr != pinned $LLVM_SIGNER_FPR" >&2; exit 1; }
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
pin bun-linux-x64.zip
curl -fsSLO "$base/SHASUMS256.txt"
grep -qxF "$(grep -E '  bun-linux-x64\.zip$' "$WS/fetch-pins.sha256")" SHASUMS256.txt
unzip -q bun-linux-x64.zip && install -m755 bun-linux-x64/bun /usr/local/bin/bun
# rustup-init by version, checked against the pinned sha256 — never `curl sh.rustup.rs | sh`.
curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rustup-init \
  "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init"
(cd /tmp && pin rustup-init)
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
(cd /tmp && pin apk-tools-static.apk)
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
if [ "$have_patches" = yes ]; then
  # Fixed committer + author date keeps the patched HEAD (embedded as Bun's revision) reproducible.
  GIT_COMMITTER_NAME=knext-bun-base GIT_COMMITTER_EMAIL=bun-base@getknext.invalid \
    git am --committer-date-is-author-date "$WS"/patches/*.patch
fi
HEAD_SHA="$(git rev-parse HEAD)"
rustup toolchain install
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
bun install --frozen-lockfile
# Prebuilt WebKit/JSC (the largest binary input): Bun's build script would download it from a GitHub
# release with no integrity check. Its downloader consults BUN_BUILD_PREFETCH_DIR/by-url/<sha256(url)[:32]>
# first, so for each target we fetch the tarball ourselves, verify it against fetch-pins.sha256, seed
# that cache, build, and then prove from the build log that the seeded file is what got linked.
# The version is read from the source at UPSTREAM_SHA; the pin is keyed by its first 16 hex chars, so a
# WebKit bump upstream (or a bump of UPSTREAM_SHA) fails closed here until a maintainer re-pins.
wk="$(grep -oE 'WEBKIT_VERSION = "[0-9a-f]{40}"' scripts/build/deps/webkit.ts | grep -oE '[0-9a-f]{40}')"
[ "$(printf '%s\n' "$wk" | grep -c .)" = 1 ] || { echo "cannot read a single WEBKIT_VERSION from the source" >&2; exit 1; }
wkshort="$(printf '%s' "$wk" | cut -c1-16)"
export BUN_BUILD_PREFETCH_DIR=/tmp/bun-prefetch
mkdir -p "$BUN_BUILD_PREFETCH_DIR/by-url" /tmp/wk
lap source

# ── build (per target: fetch + pin + seed its WebKit, build, prove the pinned tarball was linked) ──
mkdir -p "$OUT"
for arch in $TARGETS; do
  case "$arch" in x64) wkarch=amd64 ;; aarch64) wkarch=arm64 ;; *) echo "unknown target $arch" >&2; exit 1 ;; esac
  wkurl="https://github.com/oven-sh/WebKit/releases/download/autobuild-$wk/bun-webkit-linux-$wkarch-musl-lto.tar.gz"
  wkfile="bun-webkit-linux-$wkarch-musl-lto-$wkshort.tar.gz"
  curl -fsSL "$wkurl" -o "/tmp/wk/$wkfile"
  (cd /tmp/wk && pin "$wkfile")
  wkkey="$(printf '%s' "$wkurl" | sha256sum | cut -c1-32)"
  cp "/tmp/wk/$wkfile" "$BUN_BUILD_PREFETCH_DIR/by-url/$wkkey"
  bd="build/release-linux-$arch-musl"
  bun scripts/build.ts --profile=release --os=linux --arch="$arch" --abi=musl --canary=off \
    --build-dir="$bd" 2>&1 | tee "/tmp/build-$arch.log" | tail -n 60
  test -x "$bd/bun"
  # Proof the pinned tarball — not a fresh network fetch — is what got linked.
  grep -qF "using prefetch cache: $BUN_BUILD_PREFETCH_DIR/by-url/$wkkey" "/tmp/build-$arch.log"
  install -m755 "$bd/bun" "$OUT/bun-linux-$arch-musl"
  file "$OUT/bun-linux-$arch-musl"
  lap "build-$arch"
done

# Sanity: the x64 binary runs under its own musl loader (no emulation needed on this host).
if [ -x "$OUT/bun-linux-x64-musl" ]; then
  LD=/opt/linux-sysroot-musl/lib/ld-musl-x86_64.so.1
  "$LD" --library-path /opt/linux-sysroot-musl/usr/lib:/opt/linux-sysroot-musl/lib \
    "$OUT/bun-linux-x64-musl" --revision | tee "$OUT/bun-linux-x64-musl.revision"
  headshort="$(printf '%s' "$HEAD_SHA" | cut -c1-9)"
  grep -qF "$headshort" "$OUT/bun-linux-x64-musl.revision"
fi

cat >"$OUT/manifest.json" <<JSON
{
  "purpose": "CI verification of upstream Bun fixes only; never shipped to users",
  "upstream": "https://github.com/oven-sh/bun",
  "upstream_sha": "$UPSTREAM_SHA",
  "patched_head": "$HEAD_SHA",
  "prefix": "$PREFIX",
  "patches": [$(for pf in "$WS"/patches/*.patch; do printf '"%s",' "$(basename "$pf")"; done | sed 's/,$//')],
  "targets": [$(for a in $TARGETS; do printf '"bun-linux-%s-musl",' "$a"; done | sed 's/,$//')],
  "profile": "release (ThinLTO), canary=off",
  "build_id": "${BUILD_ID:-local}"
}
JSON
echo "$PREFIX" >"$WS/.prefix"
lap done
