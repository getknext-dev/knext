#!/usr/bin/env bash
# Cloud Build step 3 (ubuntu:20.04 — glibc 2.31, the oldest glibc stock Bun 1.4.2 supports): run
# the x64 patched toolchain there and prove the one thing it exists for — `--compile --include`
# embeds a file that the executable loads LAZILY (not evaluated at startup, evaluated on the first
# computed import) and FROM ITSELF (run from an empty directory after the sources are deleted).
# The same program compiled with stock Bun 1.4.2 is the negative control: it must fail to load.
#
# Also run by .github/workflows/bun-patched-release.yml against the downloaded release asset
# (BUN=<asset> STOCK_BUN=<stock 1.4.2>).
set -euo pipefail
WS=/workspace
BUN="${BUN:-$WS/out/bun-linux-x64}"
STOCK_BUN="${STOCK_BUN:-$WS/stock-bun}"
"$BUN" --version
"$BUN" --revision
tmp="$(mktemp -d)"
mkdir -p "$tmp/src/plugins" "$tmp/empty"
cd "$tmp/src"
printf 'console.log("PLUGIN_EVALUATED");\nexport default "plugin-ok";\n' >plugins/p.js
cat >main.mjs <<'JS'
console.log("MAIN_START");
const name = process.argv[2];
if (name) {
  try {
    const m = await import("./plugins/" + name + ".js");
    console.log("RESULT " + m.default);
  } catch (e) {
    console.log("RESULT fail " + String(e && e.message).split("\n")[0]);
  }
}
JS
"$BUN" build --compile ./main.mjs --include=./plugins --outfile "$tmp/app"
"$STOCK_BUN" build --compile ./main.mjs --include=./plugins --outfile "$tmp/app-stock" || true
cd "$tmp" && rm -rf "$tmp/src"
cd "$tmp/empty"
startup="$("$tmp/app")"
ondemand="$("$tmp/app" p)"
echo "--- startup: $startup"
echo "--- on demand: $ondemand"
[ "$startup" = "MAIN_START" ] || { echo "included module was evaluated at startup (not lazy)" >&2; exit 1; }
[ "$ondemand" = "$(printf 'MAIN_START\nPLUGIN_EVALUATED\nRESULT plugin-ok')" ] \
  || { echo "included module did not load from the executable on demand" >&2; exit 1; }
if [ -x "$tmp/app-stock" ]; then
  control="$("$tmp/app-stock" p || true)"
  echo "--- stock 1.4.2 control: $control"
  case "$control" in *"RESULT plugin-ok"*) echo "negative control loaded the plugin — the smoke does not discriminate" >&2; exit 1 ;; esac
fi
echo "SMOKE_OK lazy --include from the executable on glibc $(ldd --version | head -n 1 | awk '{print $NF}')"
