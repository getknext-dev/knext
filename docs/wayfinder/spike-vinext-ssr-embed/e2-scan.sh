#!/bin/bash
# e2-scan.sh <version>...
# For each published vinext version: pack the tarball and look for the emitting-side
# evidence of a SPLIT SSR SUB-ENTRY (`ssr/index.js`) in the package's own source.
set -uo pipefail
BASE=/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad/e2
mkdir -p "$BASE/tars"
cd "$BASE/tars"

printf "%-16s %-8s %-9s %-9s %-9s %-9s %-9s %s\n" version size ssrIdxJs ssrLoader loadSsrH nitro prodSrv deps
for v in "$@"; do
  d="$BASE/x/$v"
  if [ ! -d "$d" ]; then
    tgz=$(npm pack "vinext@$v" --silent 2>/dev/null)
    [ -z "$tgz" ] && { printf "%-16s PACK-FAILED\n" "$v"; continue; }
    mkdir -p "$d"
    tar xzf "$tgz" -C "$d"
  fi
  P="$d/package"
  size=$(du -sm "$P" 2>/dev/null | cut -f1)
  ssridx=$(grep -rl 'ssr/index\.js' "$P" 2>/dev/null | wc -l | tr -d ' ')
  ssrloader=$(grep -rl 'ssrLoader' "$P" 2>/dev/null | wc -l | tr -d ' ')
  loadssrh=$(grep -rl 'loadSsrHandler' "$P" 2>/dev/null | wc -l | tr -d ' ')
  nitro=$(node -e "const p=require('$P/package.json');const d={...p.dependencies,...p.peerDependencies};console.log(d.nitro?('nitro@'+d.nitro):'-')" 2>/dev/null)
  prodsrv=$([ -f "$P/dist/server/prod-server.js" ] && echo yes || echo no)
  deps=$(node -e "const p=require('$P/package.json');const d={...p.dependencies,...p.peerDependencies};console.log(['next','vite','@vitejs/plugin-rsc'].map(k=>d[k]?k+'@'+d[k]:'').filter(Boolean).join(','))" 2>/dev/null)
  printf "%-16s %-8s %-9s %-9s %-9s %-9s %-9s %s\n" "$v" "${size}M" "$ssridx" "$ssrloader" "$loadssrh" "$nitro" "$prodsrv" "$deps"
done
