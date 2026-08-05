#!/bin/bash
# Why §3.3's bespoke-entry arm and §6's mech-ssr arm BOTH reported "52 modules".
#
# The review's challenge was right to flag it: §3.3's graph (bespoke entry -> RSC entry ->
# node:path -> Bun.serve -> the SSR chunk) and §6's graph (the SSR chunk ALONE) cannot both be
# the same size if one contains the other. The suspicion was a reused measurement. It was not.
# Both were separately built and both genuinely print 52. Two things explain it:
#
#  1. The two chunks are MUTUALLY reachable, so both roots have the SAME closure:
#       dist/server/index.js      --  import(`./ssr/index.js`)   (lazy)
#       dist/server/ssr/index.js  --  import(`../index.js`)      (lazy)  <- the cycle
#     Containment holds in BOTH directions, so equality is the correct answer, not a defect.
#
#  2. bun's headline "N modules" is not a graph size. It is the same 52 for three different
#     roots. The module list that actually differs is the sourcemap `sources` array (modules
#     with emitted output): SSR chunk alone = 20, RSC entry alone = 50, bespoke entry = 50.
#     So "52 modules" must NOT be quoted as if it distinguished the arms -- it does not.
#
# Run from a built beta.4 probe app. Prints the headline count, the sourcemap count, and the
# set differences.
set -uo pipefail
SC=/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="${1:-$SC/pcprobe}"
cd "$D"

# the three roots
printf 'import * as ssr from "./dist/server/ssr/index.js";\nconsole.log(typeof ssr.handleSsr);\n' > mc-ssronly.mjs
printf 'import * as m from "./dist/server/index.js";\nconsole.log(typeof m.default);\n'          > mc-rsconly.mjs
cp "$HERE/knext-bare-entry.mjs" mc-bare.mjs

echo "== the cycle that makes both closures equal"
node -e '
  const fs=require("fs");
  const dyn=f=>[...fs.readFileSync(f,"utf8").matchAll(/import\(\s*[`"]([^`"]+)[`"]/g)].map(m=>m[1]);
  console.log("  dist/server/index.js     dynamic imports ./ssr/index.js :",
    dyn("dist/server/index.js").includes("./ssr/index.js"));
  console.log("  dist/server/ssr/index.js dynamic imports ../index.js    :",
    dyn("dist/server/ssr/index.js").includes("../index.js"));
'

echo "== headline count vs actual emitted-module list"
for e in mc-ssronly mc-rsconly mc-bare; do
  chdr=$(bun build "./$e.mjs" --compile --target=bun-linux-x64-musl --outfile "/tmp/mc-$e.bin" 2>&1 | grep -oE '[0-9]+ modules')
  bun build "./$e.mjs" --target=bun --sourcemap=external --outdir "/tmp/mc-sm-$e" >/dev/null 2>&1
  sm=$(node -e '
    const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const u=[...new Set(j.sources)].sort();
    require("fs").writeFileSync("/tmp/mc-srcs-"+process.argv[2], u.join("\n")+"\n");
    console.log(u.length);
  ' "/tmp/mc-sm-$e/$e.js.map" "$e")
  printf "  %-12s bun --compile headline: %-12s sourcemap sources: %s\n" "$e" "$chdr" "$sm"
done

echo "== set differences (containment check)"
echo "  in SSR-chunk-alone but NOT in bespoke-entry (want: only its own entry file):"
comm -23 /tmp/mc-srcs-mc-ssronly /tmp/mc-srcs-mc-bare | sed 's/^/    /'
echo "  in bespoke-entry but NOT in SSR-chunk-alone: $(comm -23 /tmp/mc-srcs-mc-bare /tmp/mc-srcs-mc-ssronly | wc -l | tr -d ' ') modules"
