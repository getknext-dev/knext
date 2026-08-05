#!/usr/bin/env bash
# Reproducible bun-exec build recipe (ADR-0036 P3). Produces a single, opt-in
# executable from a vinext build. Does NOT touch the default node build path.
#
#   ./build.sh [arch]
#     arch ∈ linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64
#     (default: linux-x64 — the ship target; alpine needs the -musl variants)
#     OUT=<path>  override the output binary name.
#
#   ./build.sh --print-labels [arch]
#     print the OCI image labels for this build and exit WITHOUT building.
#     Feed them to the image build so the deployed digest carries its own build
#     provenance (see "Build provenance" below).
#
# The output is a self-contained binary: `--compile` embeds every route from
# `.output/server/index.mjs` (vinext 1.0.0-beta.4 / vite 8 / nitro
# 3.0.260610-beta — the abandoned `vinext@^0.0.19` / `nitro@3.0.1-alpha.2` pin is
# retired, ADR-0042 A1). SHIP the binary alongside `.output/public` (static
# assets): the runtime anchors static assets on the EXECUTABLE's own directory,
# NOT on the working directory, so `<dir>/server` + `<dir>/.output/public` serves
# from any cwd. See README.md.
#
# The `-musl` targets are NOT statically linked: the image MUST `apk add
# libstdc++ libgcc` or the binary exits 127 (ADR-0042 A9). Use the `Dockerfile`
# in this directory; `bun run test:image` proves the result actually runs.
#
# ── Build provenance (S8 / #551) ─────────────────────────────────────────────
# Nothing used to tie a deployed image digest to the flags it was built with, so
# establishing that a benchmarked binary was really `--compile --minify
# --bytecode` required extracting it from the image and fingerprinting it
# against version-matched controls. The exact command is now emitted as an image
# label, which turns that forensics into a one-line lookup:
#
#   LABELS=(); while IFS= read -r l; do LABELS+=(--label "$l"); done \
#     < <(./build.sh --print-labels linux-x64)
#   docker build "${LABELS[@]}" -t <ref> .
#   crane config <ref> | jq -r '.config.Labels["dev.knext.build.command"]'
#
# The label value and the command that actually runs are ONE array, built once
# below — a hand-copied string would be free to drift from the build, which is
# the failure this exists to prevent. `benchmarks/scale-to-zero-oke/run.sh` reads
# the same labels and records them in every results file.
set -euo pipefail
cd "$(dirname "$0")"

PRINT_LABELS=0
if [ "${1:-}" = "--print-labels" ]; then PRINT_LABELS=1; shift; fi

ARCH="${1:-linux-x64}"
case "$ARCH" in
  linux-x64)    TARGET="bun-linux-x64-musl" ;;
  linux-arm64)  TARGET="bun-linux-arm64-musl" ;;
  darwin-arm64) TARGET="bun-darwin-arm64" ;;
  darwin-x64)   TARGET="bun-darwin-x64" ;;
  *) echo "unknown arch '$ARCH' (want linux-x64|linux-arm64|darwin-arm64|darwin-x64)" >&2; exit 2 ;;
esac
OUT="${OUT:-knext-bun-exec-$ARCH}"

# THE build command. Executed from this array and stamped from this array;
# there is no second copy to fall out of step with it.
BUN_BUILD_CMD=(bun build --compile --minify --bytecode --target="$TARGET"
               .output/server/index.mjs --outfile "$OUT")

# APP identity — what the two arms of an A/B must agree on. Two build TARGETS of
# one app share this; two different apps do not, which is the Run 25/26 defect
# (`p1b-node` and `p1b-bunexec` served different applications and nothing
# noticed). Content-addressed over the app sources, so it does not depend on git
# state or on anyone remembering to bump it.
app_id() {
  local sum
  sum=$( { find app -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 2>/dev/null
           shasum -a 256 package.json vite.config.ts runtime-contract.mjs knext-bun-entry.mjs 2>/dev/null
         } | shasum -a 256 | cut -c1-16 )
  printf 'bun-exec-%s' "${sum:-unknown}"
}

# One `key=value` per line, UNESCAPED. The build command contains spaces, so
# `docker build $(./build.sh --print-labels)` would mangle it however it were
# quoted — read the lines into an array instead (see the header).
print_labels() {
  local bun_version
  bun_version=$(bun --version 2>/dev/null || echo unknown)
  printf 'dev.knext.build.command=%s\n' "${BUN_BUILD_CMD[*]}"
  printf 'dev.knext.build.target=%s\n' "$TARGET"
  printf 'dev.knext.build.bun-version=%s\n' "$bun_version"
  printf 'dev.knext.app.id=%s\n' "$(app_id)"
}

if [ "$PRINT_LABELS" = "1" ]; then print_labels; exit 0; fi

command -v bun >/dev/null 2>&1 || { echo "bun is required (https://bun.sh)"; exit 1; }

echo "==> [1/3] bun install --frozen-lockfile (exact pinned deps)"
bun install --frozen-lockfile

echo "==> [2/3] vite build (vinext → Nitro bun preset → .output/server/index.mjs)"
./node_modules/.bin/vite build

echo "==> [3/3] ${BUN_BUILD_CMD[*]}"
"${BUN_BUILD_CMD[@]}"

# Written next to the binary so the provenance survives even when the image is
# built somewhere else entirely.
cat > "${OUT}.build-provenance.json" <<JSON
{
  "command": "${BUN_BUILD_CMD[*]}",
  "target": "${TARGET}",
  "bun_version": "$(bun --version 2>/dev/null || echo unknown)",
  "app_id": "$(app_id)",
  "built_at_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "==> done: $OUT"
ls -lh "$OUT"
echo "==> image labels (pass to the image build so the digest carries its own provenance):"
print_labels | sed 's/^/    /'
