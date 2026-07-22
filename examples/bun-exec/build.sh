#!/usr/bin/env bash
# Reproducible bun-exec build recipe (ADR-0036 P3). Produces a single, opt-in
# executable from a vinext build. Does NOT touch the default node build path.
#
#   ./build.sh [arch]
#     arch ∈ linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64
#     (default: linux-x64 — the ship target; alpine needs the -musl variants)
#     OUT=<path>  override the output binary name.
#
# The output is a self-contained binary: routes are bundled into
# `.output/server/index.mjs` (nitro 3.0.1-alpha.2 / vinext 0.0.19) so `--compile`
# embeds them. SHIP the binary alongside `.output/public` (static assets), run
# it from a dir where `./.output/public` resolves. See README.md.
set -euo pipefail
cd "$(dirname "$0")"

ARCH="${1:-linux-x64}"
case "$ARCH" in
  linux-x64)    TARGET="bun-linux-x64-musl" ;;
  linux-arm64)  TARGET="bun-linux-arm64-musl" ;;
  darwin-arm64) TARGET="bun-darwin-arm64" ;;
  darwin-x64)   TARGET="bun-darwin-x64" ;;
  *) echo "unknown arch '$ARCH' (want linux-x64|linux-arm64|darwin-arm64|darwin-x64)" >&2; exit 2 ;;
esac
OUT="${OUT:-knext-bun-exec-$ARCH}"

command -v bun >/dev/null 2>&1 || { echo "bun is required (https://bun.sh)"; exit 1; }

echo "==> [1/3] bun install --frozen-lockfile (exact pinned deps)"
bun install --frozen-lockfile

echo "==> [2/3] vite build (vinext → Nitro bun preset → .output/server/index.mjs)"
./node_modules/.bin/vite build

echo "==> [3/3] bun --compile --minify --bytecode → $OUT ($TARGET)"
bun build --compile --minify --bytecode --target="$TARGET" \
  .output/server/index.mjs --outfile "$OUT"

echo "==> done: $OUT"
ls -lh "$OUT"
