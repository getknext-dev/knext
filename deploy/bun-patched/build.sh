#!/usr/bin/env bash
# Cloud Build step 2 (ubuntu:24.04, digest-pinned in cloudbuild.yaml): a RELEASE Bun built from
# the tag in UPSTREAM plus patches/*.patch, for ONE linux-gnu target, linked against the glibc 2.31
# sysroot step 1 produced. Derived from infra/bun-base/build.sh (same pins and the same
# prefetch-cache proof for the prebuilt WebKit); the differences are the source (a release tag,
# not a main commit), LLVM 21 (what bun-v1.4.2's scripts/build/tools.ts requires) and glibc
# instead of musl.
#
# This binary is the opt-in `compile.bun: 'knext-patched'` toolchain: knext runs it for the
# `bun build --compile` step only. RETIREMENT: delete this directory once a stock Bun release
# ships oven-sh/bun#44059 (the `bun-patched-toolchain` retirement probe reds on that release).
#
# Usage (from cloudbuild.yaml): build.sh <x64|aarch64>
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive HOME=/root LC_ALL=C
WS=/workspace
SRC=$WS/bun
OUT=$WS/out
TARGET="$1"
case "$TARGET" in
  x64) WKARCH=amd64; SYSROOT=/opt/linux-sysroot-glibc; TRIPLE=x86_64-linux-gnu; XBINUTILS=binutils-aarch64-linux-gnu ;;
  aarch64) WKARCH=arm64; SYSROOT=/opt/linux-sysroot-glibc-arm64; TRIPLE=aarch64-linux-gnu; XBINUTILS=binutils-x86-64-linux-gnu ;;
  *) echo "build.sh: unknown target '$TARGET' (want x64 or aarch64)" >&2; exit 2 ;;
esac
LLVM_MAJOR=21
# apt.llvm.org archive signer, grouped the way `gpg --fingerprint` prints it (see
# infra/bun-base/README.md "Secret-scan hygiene"); compared with spaces stripped.
LLVM_SIGNER_FPR='6084 F3CF 814B 57C1 CF12  EFD5 15CF 4D18 AF4F 7421'
BOOTSTRAP_BUN=1.4.2
RUSTUP_VERSION=1.29.1
pin() { # pin <file-in-cwd>: exactly one fetch-pins.sha256 line, and it must match
  local line
  line="$(grep -E "^[0-9a-f]{64}  $1\$" "$WS/fetch-pins.sha256")"
  [ "$(printf '%s\n' "$line" | grep -c .)" = 1 ] || { echo "fetch-pins.sha256: need exactly one line for $1" >&2; exit 1; }
  printf '%s\n' "$line" | sha256sum -c -
}
lap() { echo "### LAP $1 at $(date -u +%T)"; }

read -r UPSTREAM_TAG UPSTREAM_SHA < <(awk '!/^#/ && NF { print $1, $2; exit }' "$WS/UPSTREAM")
[[ "$UPSTREAM_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "UPSTREAM: expected '<tag> <40-hex>'" >&2; exit 1; }
echo "upstream=$UPSTREAM_TAG@$UPSTREAM_SHA target=$TARGET"

# ── patch header lint (before any paid build minutes) ────────────────────────
shopt -s nullglob
for p in "$WS"/patches/*.patch; do
  name="$(basename "$p")"
  [[ "$name" =~ ^[0-9]{3}-[a-z0-9-]+\.patch$ ]] || { echo "patch $name: bad filename" >&2; exit 1; }
  grep -Eq '^Upstream: oven-sh/bun#[0-9]+$' "$p" || { echo "patch $name: needs an 'Upstream: oven-sh/bun#N' line" >&2; exit 1; }
  grep -Eq '^knext-shim: [A-Za-z0-9._-]+$' "$p" || { echo "patch $name: needs a 'knext-shim: <id>' line" >&2; exit 1; }
done
(cd "$WS/patches" && sha256sum -c --strict SHA256SUMS)

# ── toolchain ────────────────────────────────────────────────────────────────
apt-get update -qq
apt-get install -y -qq curl wget ca-certificates lsb-release gnupg cmake git golang libtool ninja-build \
  pkg-config ruby-full xz-utils nasm unzip python3 build-essential libicu-dev perl zstd file \
  "$XBINUTILS" >/dev/null
wget -qO /tmp/llvm.asc https://apt.llvm.org/llvm-snapshot.gpg.key
gpg --show-keys --with-colons /tmp/llvm.asc >/tmp/llvm.colons
[ "$(grep -c '^pub:' /tmp/llvm.colons)" = 1 ] || { echo "apt.llvm.org key: expected exactly one primary key" >&2; exit 1; }
fpr="$(awk -F: '/^fpr:/ && !n++ {print $10}' /tmp/llvm.colons)"
[ "$fpr" = "${LLVM_SIGNER_FPR// /}" ] || { echo "apt.llvm.org key fingerprint $fpr != pinned $LLVM_SIGNER_FPR" >&2; exit 1; }
mkdir -p /etc/apt/keyrings && gpg --dearmor </tmp/llvm.asc >/etc/apt/keyrings/apt.llvm.org.gpg
echo "deb [signed-by=/etc/apt/keyrings/apt.llvm.org.gpg] http://apt.llvm.org/$(lsb_release -cs)/ llvm-toolchain-$(lsb_release -cs)-$LLVM_MAJOR main" \
  >/etc/apt/sources.list.d/llvm.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends clang-$LLVM_MAJOR lld-$LLVM_MAJOR llvm-$LLVM_MAJOR \
  libclang-rt-$LLVM_MAJOR-dev libclang-common-$LLVM_MAJOR-dev >/dev/null
LLVM_PKG="$(dpkg-query -W -f='${Version}' clang-$LLVM_MAJOR)"
echo "llvm package: clang-$LLVM_MAJOR=$LLVM_PKG"
for t in clang clang++ ld.lld llvm-ar llvm-ranlib llvm-strip llvm-objcopy; do
  ln -sf /usr/bin/$t-$LLVM_MAJOR /usr/local/bin/$t
done
cd /tmp
base="https://github.com/oven-sh/bun/releases/download/bun-v$BOOTSTRAP_BUN"
curl -fsSLO "$base/bun-linux-x64.zip"
pin bun-linux-x64.zip
curl -fsSLO "$base/SHASUMS256.txt"
grep -qxF "$(grep -E '  bun-linux-x64\.zip$' "$WS/fetch-pins.sha256")" SHASUMS256.txt
unzip -q bun-linux-x64.zip && install -m755 bun-linux-x64/bun /usr/local/bin/bun
# Stock 1.4.2 is also smoke.sh's negative control.
install -m755 bun-linux-x64/bun "$WS/stock-bun"
curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rustup-init \
  "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init"
(cd /tmp && pin rustup-init)
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --profile minimal --default-toolchain none --no-modify-path
export PATH=$HOME/.cargo/bin:$PATH
lap toolchain

# ── glibc sysroot from step 1, re-rooted at the path Bun's build auto-detects ──
mkdir -p "$SYSROOT"
tar -C "$SYSROOT" -xf "$WS/sysroot-$TARGET.tar"
# Absolute symlinks in the copied rootfs point at host paths; re-root them inside the sysroot so
# -lpthread/-ldl/libc.so resolve to the TARGET's glibc (bootstrap.sh does the same).
find "$SYSROOT" -type l | while read -r l; do
  t="$(readlink "$l")"
  case "$t" in /*) ln -sfn "$SYSROOT$t" "$l" ;; esac
done
if ! [ -e "$SYSROOT/lib/$TRIPLE/libc.so.6" ]; then
  mkdir -p "$SYSROOT/lib" && ln -sfn "../usr/lib/$TRIPLE" "$SYSROOT/lib/$TRIPLE"
fi
if [ "$TARGET" = x64 ] && ! [ -e "$SYSROOT/lib64" ]; then ln -sfn "usr/lib/$TRIPLE" "$SYSROOT/lib64"; fi
test -d "$SYSROOT/usr/include/c++/13"
lap sysroot

# ── source at the tag's commit, patches applied ──────────────────────────────
git init -q "$SRC"
cd "$SRC"
git remote add upstream https://github.com/oven-sh/bun.git
git fetch -q --depth 1 upstream "refs/tags/$UPSTREAM_TAG"
git checkout -q FETCH_HEAD
test "$(git rev-parse HEAD)" = "$UPSTREAM_SHA" || { echo "tag $UPSTREAM_TAG is $(git rev-parse HEAD), pinned $UPSTREAM_SHA" >&2; exit 1; }
# Fixed committer + author date keeps the patched HEAD (embedded as Bun's revision) reproducible.
GIT_COMMITTER_NAME=knext-bun-patched GIT_COMMITTER_EMAIL=bun-patched@getknext.invalid \
  git am --committer-date-is-author-date "$WS"/patches/*.patch
HEAD_SHA="$(git rev-parse HEAD)"
echo "patched head=$HEAD_SHA"
rustup toolchain install
bun install --frozen-lockfile
wk="$(grep -oE 'WEBKIT_VERSION = "[0-9a-f]{40}"' scripts/build/deps/webkit.ts | grep -oE '[0-9a-f]{40}')"
[ "$(printf '%s\n' "$wk" | grep -c .)" = 1 ] || { echo "cannot read a single WEBKIT_VERSION from the source" >&2; exit 1; }
wkshort="$(printf '%s' "$wk" | cut -c1-16)"
export BUN_BUILD_PREFETCH_DIR=/tmp/bun-prefetch
mkdir -p "$BUN_BUILD_PREFETCH_DIR/by-url" /tmp/wk
# `--profile=release` at bun-v1.4.2 is lto:false, so the prebuilt WebKit has no -lto suffix.
wkurl="https://github.com/oven-sh/WebKit/releases/download/autobuild-$wk/bun-webkit-linux-$WKARCH.tar.gz"
wkfile="bun-webkit-linux-$WKARCH-$wkshort.tar.gz"
curl -fsSL "$wkurl" -o "/tmp/wk/$wkfile"
(cd /tmp/wk && pin "$wkfile")
wkkey="$(printf '%s' "$wkurl" | sha256sum | cut -c1-32)"
cp "/tmp/wk/$wkfile" "$BUN_BUILD_PREFETCH_DIR/by-url/$wkkey"
lap source

# ── build ────────────────────────────────────────────────────────────────────
bd="build/release-linux-$TARGET"
bun scripts/build.ts --profile=release --os=linux --arch="$TARGET" --abi=gnu --canary=off \
  --build-dir="$bd" 2>&1 | tee "/tmp/build-$TARGET.log" | tail -n 80
test -x "$bd/bun"
# Proof the pinned tarball, not a fresh network fetch, is what got linked.
grep -qF "using prefetch cache: $BUN_BUILD_PREFETCH_DIR/by-url/$wkkey" "/tmp/build-$TARGET.log"
# Proof the sysroot was used (cross target set), not the build host's glibc 2.39: the highest
# GLIBC_ symbol version the binary needs must be <= 2.31.
maxglibc="$(llvm-objdump-$LLVM_MAJOR -T "$bd/bun" | grep -oE 'GLIBC_2\.[0-9]+' | sort -t. -k2 -n -u | tail -n 1)"
echo "highest glibc symbol version needed: $maxglibc"
case "$maxglibc" in
  GLIBC_2.[0-9] | GLIBC_2.[12][0-9] | GLIBC_2.3[01]) ;;
  *) echo "binary needs '$maxglibc' (want <= 2.31) — the glibc sysroot was not used" >&2; exit 1 ;;
esac
mkdir -p "$OUT"
install -m755 "$bd/bun" "$OUT/bun-linux-$TARGET"
file "$OUT/bun-linux-$TARGET"
if [ "$TARGET" = x64 ]; then
  "$OUT/bun-linux-$TARGET" --revision | tee "$OUT/bun-linux-$TARGET.revision"
  grep -qF "$(printf '%s' "$HEAD_SHA" | cut -c1-9)" "$OUT/bun-linux-$TARGET.revision"
fi
cat >"$OUT/manifest-$TARGET.json" <<JSON
{
  "purpose": "knext opt-in patched Bun toolchain (compile.bun: 'knext-patched'); used for the bun build --compile step only",
  "upstream": "https://github.com/oven-sh/bun",
  "upstream_tag": "$UPSTREAM_TAG",
  "upstream_sha": "$UPSTREAM_SHA",
  "patched_head": "$HEAD_SHA",
  "patches": [$(for pf in "$WS"/patches/*.patch; do printf '"%s",' "$(basename "$pf")"; done | sed 's/,$//')],
  "target": "bun-linux-$TARGET",
  "profile": "release, canary=off, glibc 2.31 sysroot (ubuntu:20.04 + gcc-13 libstdc++)",
  "toolchain": { "llvm": "clang-$LLVM_MAJOR=$LLVM_PKG", "bootstrap_bun": "$BOOTSTRAP_BUN", "rust": "$(rustc --version)", "webkit": "$wkshort (pinned prebuilt, fetch-pins.sha256)" },
  "max_glibc_symbol": "$maxglibc",
  "build_id": "${BUILD_ID:-local}"
}
JSON
cat "$OUT/manifest-$TARGET.json"
lap done
