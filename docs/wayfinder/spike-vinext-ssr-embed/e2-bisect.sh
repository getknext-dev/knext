#!/bin/bash
# Same bisect, for the vinext versions that peer-require vite ^7 (needs plugin-react ^5).
set -uo pipefail
SC=/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad
#
# THIS SCRIPT IS VITE-7-ONLY. It pins vite `^7.0.0` on every point, so it cannot produce a
# 7-vs-8 comparison. Do not cite it for one; the single-variable 7-vs-8 test is
# e2-vite78-fixed.sh (which takes the vinext version as $1).
#
# The plugin-react override below used to run as a silent `&&` chain: if `npm install` failed,
# the rebuild was skipped and the measurement read the PREVIOUS dist -- built by
# e2-build-version.sh with plugin-react ^6 -- with nothing in the printed output distinguishing
# the two. It is now fail-loud: every step is checked, the stale dist is deleted before the
# rebuild so a skipped rebuild cannot be measured at all, and each line prints the plugin-react
# version actually resolved on disk so the output certifies itself.
resolved() {  # $1 = app dir, $2 = package name -> version, or ABSENT
  node -e 'const p=require("path"),f=require("fs");const j=p.join(process.argv[1],"node_modules",process.argv[2],"package.json");console.log(f.existsSync(j)?JSON.parse(f.readFileSync(j,"utf8")).version:"ABSENT")' "$1" "$2"
}

for v in "$@"; do
  d="pb$(echo "$v" | tr -d '.')"
  D="$SC/$d"
  log="/tmp/bisect7-$v.log"
  bash "$SC/e2-build-version.sh" "$v" "^7.0.0" "^0.5.32" "$d" > "$log" 2>&1

  # Fail loudly rather than silently measuring the plugin-react-^6 dist e2-build-version.sh left.
  if ! (cd "$D" && npm pkg set 'dependencies.@vitejs/plugin-react=^5.0.0') >>"$log" 2>&1; then
    printf "%-12s ABORT: npm pkg set failed (%s)\n" "$v" "$log"; continue
  fi
  rm -rf "$D/dist"
  if ! (cd "$D" && npm install --no-audit --no-fund --silent) >>"$log" 2>&1; then
    printf "%-12s ABORT: npm install failed after plugin-react override (%s)\n" "$v" "$log"; continue
  fi
  (cd "$D" && NODE_ENV=production npx vinext build) >>"$log" 2>&1

  pr=$(resolved "$D" "@vitejs/plugin-react")
  vv=$(resolved "$D" "vite")
  ssr="$D/dist/server/ssr/index.js"
  if [ -f "$ssr" ]; then
    n=$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const re=/\b[A-Za-z_$][\w$]*\((`|")react-dom\1\)/g;console.log((s.match(re)||[]).length)' "$ssr")
    cr=$(grep -o "createRequire" "$ssr" | wc -l | tr -d ' ')
    printf "%-12s vite=%-8s plugin-react=%-8s ssrChunk=%-8s require(\"react-dom\")=%-3s createRequire=%s\n" \
      "$v" "$vv" "$pr" "$(wc -c < "$ssr" | tr -d ' ')" "$n" "$cr"
  else
    printf "%-12s vite=%-8s plugin-react=%-8s BUILD-FAILED (%s)\n" "$v" "$vv" "$pr" "$log"
  fi
done
