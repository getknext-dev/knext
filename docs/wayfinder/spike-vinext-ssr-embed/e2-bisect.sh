#!/bin/bash
# Same bisect, for the vinext versions that peer-require vite ^7 (needs plugin-react ^5).
set -uo pipefail
SC=/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad
for v in "$@"; do
  d="pb$(echo "$v" | tr -d '.')"
  D="$SC/$d"
  bash "$SC/e2-build19.sh" "$v" "^7.0.0" "^0.5.32" "$d" > "/tmp/bisect7-$v.log" 2>&1
  (cd "$D" && npm pkg set 'dependencies.@vitejs/plugin-react=^5.0.0' >/dev/null 2>&1 && npm install --no-audit --no-fund --silent >/dev/null 2>&1 && NODE_ENV=production npx vinext build >>"/tmp/bisect7-$v.log" 2>&1)
  ssr="$D/dist/server/ssr/index.js"
  if [ -f "$ssr" ]; then
    n=$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const re=/\b[A-Za-z_$][\w$]*\((`|")react-dom\1\)/g;console.log((s.match(re)||[]).length)' "$ssr")
    cr=$(grep -o "createRequire" "$ssr" | wc -l | tr -d ' ')
    printf "%-12s ssrChunk=%-8s require(\"react-dom\")=%-3s createRequire=%s\n" "$v" "$(wc -c < "$ssr" | tr -d ' ')" "$n" "$cr"
  else
    printf "%-12s BUILD-FAILED (/tmp/bisect7-%s.log)\n" "$v" "$v"
  fi
done
