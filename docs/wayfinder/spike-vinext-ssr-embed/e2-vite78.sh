#!/bin/bash
# Single-variable test: hold vinext + plugin-rsc + react fixed, vary ONLY vite 7 vs 8.
set -uo pipefail
SC=/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad
V="$1"
for pair in "7:^7.0.0:^5.0.0" "8:^8.0.0:^6.0.0"; do
  major="${pair%%:*}"; rest="${pair#*:}"; vite="${rest%%:*}"; preact="${rest##*:}"
  d="v78-$(echo "$V" | tr -d '.')-vite$major"
  D="$SC/$d"
  bash "$SC/e2-build19.sh" "$V" "$vite" "^0.5.32" "$d" > "/tmp/v78-$V-$major.log" 2>&1
  (cd "$D" && npm pkg set "dependencies.@vitejs/plugin-react=$preact" >/dev/null 2>&1 \
     && npm install --no-audit --no-fund --silent >/dev/null 2>&1 \
     && NODE_ENV=production npx vinext build >> "/tmp/v78-$V-$major.log" 2>&1)
  ssr="$D/dist/server/ssr/index.js"
  vv=$(node -e "console.log(require('$D/node_modules/vite/package.json').version)" 2>/dev/null)
  pr=$(node -e "console.log(require('$D/node_modules/@vitejs/plugin-rsc/package.json').version)" 2>/dev/null)
  if [ -f "$ssr" ]; then
    n=$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const re=/\b[A-Za-z_$][\w$]*\((`|")react-dom\1\)/g;console.log((s.match(re)||[]).length)' "$ssr")
    cr=$(grep -o "createRequire" "$ssr" | wc -l | tr -d ' ')
    printf "vinext@%-12s vite=%-8s plugin-rsc=%-8s ssrChunk=%-8s require(\"react-dom\")=%-3s createRequire=%s\n" \
      "$V" "$vv" "$pr" "$(wc -c < "$ssr" | tr -d ' ')" "$n" "$cr"
  else
    printf "vinext@%-12s vite=%-8s BUILD-FAILED (/tmp/v78-%s-%s.log)\n" "$V" "$vv" "$V" "$major"
  fi
done
