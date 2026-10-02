#!/usr/bin/env bash
# Release test matrix (#1822, from the spike harness): --include behaviour matrix for the knext-patched Bun.
# usage: include-tests.sh <patched bun> <stock bun> <out dir>
# Records RESULT|include|<test>|PASS/FAIL/INFO|detail lines; never exits non-zero on a test failure.
set -uo pipefail
P=$1; S=$2; OUT=$3
mkdir -p "$OUT"
R="$OUT/results.txt"
H="$(cd "$(dirname "$0")" && pwd)"
rec(){ echo "RESULT|include|$1|$2|$3" | tee -a "$R"; }
now(){ date +%s%N; }
ms(){ echo $(( ($2-$1)/1000000 )); }
W="$(mktemp -d)"; cd "$W"
mkdir -p plugins/sub plugins/node_modules/x bin run
printf 'console.log("PLUGIN_EVALUATED");\nexport default "plugin-ok";\n' > plugins/p.js
printf 'export default "sub-ok";\n' > plugins/sub/q.js
printf 'const v: string = "ts-ok";\nexport default v;\n' > plugins/t.ts
printf 'export default "nm-ok";\n' > plugins/node_modules/x/i.js
cat > main.mjs <<'JS'
console.log("MAIN_START");
const name = process.argv[2];
if (name) {
  try { const m = await import("./plugins/" + name); console.log("RESULT " + m.default); }
  catch (e) { console.log("RESULT fail " + String(e && e.message).split("\n")[0]); }
}
JS
cat > main.cjs <<'JS'
console.log("MAIN_START");
const name = process.argv[2];
if (name) {
  try { const m = require("./plugins/" + name); console.log("RESULT " + (m.default ?? m)); }
  catch (e) { console.log("RESULT fail " + String(e && e.message).split("\n")[0]); }
}
JS
# compile <bun> <outname> <args...>  (cwd = $W); echoes exit code + ms + size
c(){ local b=$1 o=$2; shift 2; local s e rc; s=$(now); "$b" build --compile "$@" --outfile "bin/$o" >"bin/$o.log" 2>&1; rc=$?; e=$(now)
  echo "rc=$rc ms=$(ms "$s" "$e") size=$(stat -c %s "bin/$o" 2>/dev/null || echo NA)"; }
# r <outname> <args>: run with every source tree hidden, from an empty cwd
hide(){ for d in plugins plugins_big plugins_many native blob.bin; do [ -e "$W/$d" ] && mv "$W/$d" "$W/.h_$d"; done; }
unhide(){ for d in plugins plugins_big plugins_many native blob.bin; do [ -e "$W/.h_$d" ] && mv "$W/.h_$d" "$W/$d"; done; }
r(){ local o=$1; shift; ( cd "$W/run" && timeout 60 "$W/bin/$o" "$@" 2>&1 ); }

# --- 1. lazy load (native target = the patched runtime is embedded) ----------------------------
info=$(c "$P" lazy main.mjs --include=./plugins); rec lazy-compile INFO "$info"
infos=$(c "$S" lazy-stock main.mjs --include=./plugins); rec lazy-stock-compile INFO "$infos $(head -c 200 bin/lazy-stock.log | tr '\n' ' ')"
hide
st=$(r lazy); od=$(r lazy p.js); sub=$(r lazy sub/q.js); ts=$(r lazy t.ts); nm=$(r lazy node_modules/x/i.js)
[ "$st" = "MAIN_START" ] && rec lazy-not-evaluated-at-startup PASS "$st" || rec lazy-not-evaluated-at-startup FAIL "$st"
[ "$od" = "$(printf 'MAIN_START\nPLUGIN_EVALUATED\nRESULT plugin-ok')" ] && rec lazy-loaded-on-first-import PASS "$(echo $od)" || rec lazy-loaded-on-first-import FAIL "$(echo $od)"
case "$sub" in *"RESULT sub-ok"*) rec dir-include-nested PASS "$(echo $sub)";; *) rec dir-include-nested FAIL "$(echo $sub)";; esac
case "$ts" in *"RESULT ts-ok"*) rec ts-module-transpiled PASS "$(echo $ts)";; *) rec ts-module-transpiled FAIL "$(echo $ts)";; esac
case "$nm" in *"RESULT nm-ok"*) rec node_modules-skipped-in-dir-include INFO "dir include EMBEDS node_modules: $(echo $nm)";; *) rec node_modules-skipped-in-dir-include INFO "not embedded: $(echo $nm)";; esac
[ -x bin/lazy-stock ] && { ctl=$(r lazy-stock p.js); case "$ctl" in *"plugin-ok"*) rec stock-negative-control FAIL "stock loaded it: $(echo $ctl)";; *) rec stock-negative-control PASS "$(echo $ctl)";; esac; }
unhide

# --- 2. missing / invalid paths -----------------------------------------------------------------
for spec in "./nope" "./plugins/*.zzz" "/abs/path" "../outside" "./plugins/../../x"; do
  out=$("$P" build --compile main.mjs --include="$spec" --outfile bin/miss 2>&1); rc=$?
  rec "missing-or-invalid[$spec]" "$([ $rc -ne 0 ] && echo PASS || echo FAIL)" "rc=$rc $(echo "$out" | grep -i -E 'error|include' | head -n 2 | tr '\n' ' ' | cut -c1-220)"
done
out=$("$P" build main.mjs --include=./plugins --outdir bin/nocompile 2>&1); rc=$?
rec include-without-compile "$([ $rc -ne 0 ] && echo PASS || echo FAIL)" "rc=$rc $(echo "$out" | head -n 2 | tr '\n' ' ' | cut -c1-200)"
out=$("$P" build --compile main.mjs --include=./plugins --target=browser --outfile bin/br 2>&1); rc=$?
rec include-with-target-browser "$([ $rc -ne 0 ] && echo PASS || echo FAIL)" "rc=$rc $(echo "$out" | head -n 2 | tr '\n' ' ' | cut -c1-200)"

# --- 3. globs ---------------------------------------------------------------------------------
c "$P" g1 main.mjs --include='./plugins/**/*.js' >/dev/null
c "$P" g2 main.mjs --include='./plugins/{p,t}.*' >/dev/null
c "$P" g3 main.mjs --include='./plugins/?.js' --include='./plugins/sub/[pq].js' >/dev/null
hide
a=$(r g1 p.js); b=$(r g1 sub/q.js); t=$(r g1 t.ts); n=$(r g1 node_modules/x/i.js)
[[ "$a" == *plugin-ok* && "$b" == *sub-ok* && "$t" != *ts-ok* ]] && rec 'glob[**/*.js]' PASS "p+sub/q in, t.ts out" || rec 'glob[**/*.js]' FAIL "$(echo $a $b $t)"
[[ "$n" == *nm-ok* ]] && rec 'glob-skips-node_modules' FAIL "node_modules matched: $(echo $n)" || rec 'glob-skips-node_modules' PASS "$(echo $n | cut -c1-120)"
a=$(r g2 p.js); t=$(r g2 t.ts); b=$(r g2 sub/q.js)
[[ "$a" == *plugin-ok* && "$t" == *ts-ok* && "$b" != *sub-ok* ]] && rec 'glob[{p,t}.*]' PASS "brace expansion ok" || rec 'glob[{p,t}.*]' FAIL "$(echo $a $t $b)"
a=$(r g3 p.js); b=$(r g3 sub/q.js)
[[ "$a" == *plugin-ok* && "$b" == *sub-ok* ]] && rec 'glob[?,[..]]' PASS "ok" || rec 'glob[?,[..]]' FAIL "$(echo $a $b)"
unhide

# --- 4. large file (50 MB module) ---------------------------------------------------------------
mkdir -p plugins_big
node -e 'const fs=require("fs");fs.writeFileSync("plugins_big/big.js","console.log(\"BIG_EVAL\");\nexport default \""+"a".repeat(50*1024*1024)+"\".length;\n")'
cat > big.mjs <<'JS'
const t0 = performance.now(); console.log("MAIN_START");
if (process.argv[2]) { const m = await import("./plugins_big/" + process.argv[2]); console.log("RESULT " + m.default + " importMs=" + Math.round(performance.now() - t0)); }
JS
c "$P" hello-base big.mjs >/dev/null
info=$(c "$P" big big.mjs --include=./plugins_big); rec large-50MB-compile INFO "$info (base exe $(stat -c %s bin/hello-base))"
info=$(c "$P" big-bc big.mjs --include=./plugins_big --bytecode --format=esm); rec large-50MB-compile-bytecode INFO "$info $(grep -i error bin/big-bc.log | head -n1)"
hide
for e in big big-bc; do
  [ -x "bin/$e" ] || { rec "large-50MB-run[$e]" FAIL "no exe"; continue; }
  st=$(r $e); ld=$(r $e big.js | tr '\n' ' ')
  [[ "$st" == "MAIN_START" && "$ld" == *"RESULT 52428800"* ]] && rec "large-50MB-run[$e]" PASS "$ld" || rec "large-50MB-run[$e]" FAIL "st=$(echo $st | cut -c1-80) ld=$(echo $ld | cut -c1-200)"
  rec "large-50MB-startup[$e]" INFO "$(bash "$H/cli-bench.sh" 10 "$e" -- "$W/bin/$e")"
done
rec "large-50MB-startup[baseline]" INFO "$(bash "$H/cli-bench.sh" 10 base -- "$W/bin/hello-base")"
unhide

# --- 5. many files (1,000) ----------------------------------------------------------------------
mkdir -p plugins_many
for i in $(seq 1 1000); do printf 'globalThis.__n=(globalThis.__n||0)+1;\nexport default %d;\n' "$i" > "plugins_many/m$i.js"; done
cat > many.mjs <<'JS'
const t0 = performance.now(); console.log("MAIN_START n=" + (globalThis.__n || 0));
if (process.argv[2] === "all") { let s = 0; for (let i = 1; i <= 1000; i++) s += (await import("./plugins_many/m" + i + ".js")).default; console.log("RESULT sum=" + s + " evaluated=" + globalThis.__n + " ms=" + Math.round(performance.now() - t0)); }
JS
info=$(c "$P" many many.mjs --include=./plugins_many); rec many-1000-compile INFO "$info"
info=$(c "$P" many-glob many.mjs --include='./plugins_many/*.js' --bytecode --format=esm); rec many-1000-compile-glob-bytecode INFO "$info $(grep -i error bin/many-glob.log | head -n1)"
hide
for e in many many-glob; do
  [ -x "bin/$e" ] || { rec "many-1000-run[$e]" FAIL "no exe"; continue; }
  st=$(r $e); al=$(r $e all | tr '\n' ' ')
  [[ "$st" == "MAIN_START n=0" && "$al" == *"sum=500500 evaluated=1000"* ]] && rec "many-1000-run[$e]" PASS "$al" || rec "many-1000-run[$e]" FAIL "st=$st al=$(echo $al | cut -c1-200)"
  rec "many-1000-startup[$e]" INFO "$(bash "$H/cli-bench.sh" 10 "$e" -- "$W/bin/$e")"
done
unhide

# --- 6. native addon (.node) via --include ------------------------------------------------------
mkdir -p native npmtmp
( cd npmtmp && npm pack @node-rs/crc32-linux-x64-gnu >/dev/null 2>&1 && tar xzf ./*.tgz ) && cp "$(find npmtmp -name '*.node' | head -n1)" native/crc.node
if [ -f native/crc.node ]; then
  cat > addon.mjs <<'JS'
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
console.log("MAIN_START");
try { const m = require("./native/" + process.argv[2]); console.log("RESULT crc32=" + m.crc32("hello")); }
catch (e) { console.log("RESULT fail " + String(e && e.message).split("\n")[0]); }
JS
  info=$(c "$P" addon addon.mjs --include=./native); rec native-addon-compile INFO "$info $(grep -i -E 'error|warn' bin/addon.log | head -n2 | tr '\n' ' ')"
  cat > addon-static.cjs <<'JS'
const m = require("./native/crc.node"); console.log("RESULT crc32=" + m.crc32("hello"));
JS
  c "$S" addon-static-stock addon-static.cjs >/dev/null
  hide
  # Raw Bun: an --include'd .node still compiles and then cannot load (upstream). knext refuses it at
  # plan time — proven by the knext-level refusal checks, not here. INFO, not a verdict.
  out=$(r addon crc.node | tr '\n' ' '); rec native-addon-via-raw-include INFO "upstream behaviour (knext refuses at plan time): $(echo $out | cut -c1-200)"
  out=$(r addon-static-stock | tr '\n' ' '); rec native-addon-static-require-stock-control INFO "$(echo $out | cut -c1-200)"
  unhide
else rec native-addon-via-include FAIL "could not obtain a prebuilt .node"; fi

# --- 7. include + bytecode ----------------------------------------------------------------------
info=$(c "$P" bc-esm main.mjs --include=./plugins --bytecode --format=esm); rec bytecode-esm-compile INFO "$info $(grep -i error bin/bc-esm.log | head -n1)"
info=$(c "$P" bc-cjs main.cjs --include=./plugins --bytecode); rec bytecode-cjs-compile INFO "$info $(grep -i error bin/bc-cjs.log | head -n1)"
info=$(c "$P" bc-default main.mjs --include=./plugins --bytecode); rec bytecode-default-format-compile INFO "$info $(grep -i error bin/bc-default.log | head -n1 | cut -c1-160)"
hide
for e in bc-esm bc-cjs bc-default; do
  [ -x "bin/$e" ] || { rec "include+bytecode[$e]" FAIL "no exe ($(head -c 200 bin/$e.log | tr '\n' ' '))"; continue; }
  st=$(r $e); od=$(r $e p.js | tr '\n' ' ')
  [[ "$st" == "MAIN_START" && "$od" == *"PLUGIN_EVALUATED RESULT plugin-ok"* ]] && rec "include+bytecode[$e]" PASS "$od" || rec "include+bytecode[$e]" FAIL "st=$st od=$(echo $od | cut -c1-200)"
done
unhide

# --- 8. cross-compile targets -------------------------------------------------------------------
for t in bun-linux-x64-musl bun-linux-arm64 bun-linux-arm64-musl bun-linux-x64-baseline bun-darwin-arm64 bun-windows-x64; do
  info=$(c "$P" "x-$t" main.mjs --include=./plugins --target="$t"); rec "cross-compile[$t]" INFO "$info $(grep -i error "bin/x-$t.log" | head -n1 | cut -c1-160)"
  info=$(c "$P" "xbc-$t" main.cjs --include=./plugins --target="$t" --bytecode); rec "cross-compile+bytecode[$t]" INFO "$info $(grep -i error "bin/xbc-$t.log" | head -n1 | cut -c1-160)"
done
hide
for e in x-bun-linux-x64-baseline xbc-bun-linux-x64-baseline; do
  od=$(r $e p.js | tr '\n' ' '); [[ "$od" == *"RESULT plugin-ok"* ]] && rec "cross-run[$e]" PASS "$od" || rec "cross-run[$e]" FAIL "$(echo $od | cut -c1-200)"
done
unhide
# musl ones in the knext runtime base (alpine:3.22 + libstdc++ libgcc), plugins NOT mounted
for e in x-bun-linux-x64-musl xbc-bun-linux-x64-musl; do
  [ -x "bin/$e" ] || { rec "cross-run-alpine[$e]" FAIL "no exe"; continue; }
  od=$(docker run --rm -v "$W/bin:/b:ro" alpine:3.22 sh -c "apk add --no-cache libstdc++ libgcc >/dev/null; cd /tmp; /b/$e; /b/$e p.js; BUN_BE_BUN=1 /b/$e --revision" 2>&1 | tr '\n' ' ')
  [[ "$od" == *"PLUGIN_EVALUATED RESULT plugin-ok"* ]] && rec "cross-run-alpine[$e]" PASS "$od" || rec "cross-run-alpine[$e]" FAIL "$(echo $od | cut -c1-250)"
done
od=$(docker run --rm -v "$W/bin:/b:ro" alpine:3.22 sh -c "cd /tmp; /b/x-bun-linux-x64-musl p.js" 2>&1 | tr '\n' ' ')
rec "cross-run-alpine-no-libstdcxx[x-bun-linux-x64-musl]" INFO "$(echo $od | cut -c1-200)"
mkdir -p "$OUT/arm"; cp bin/x-bun-linux-arm64 bin/xbc-bun-linux-arm64 bin/x-bun-linux-arm64-musl bin/xbc-bun-linux-arm64-musl "$OUT/arm/" 2>/dev/null
ls -la bin | awk '{print $5, $9}' > "$OUT/sizes.txt"
echo "include-tests done: $(grep -c '|PASS|' "$R") pass, $(grep -c '|FAIL|' "$R") fail"
