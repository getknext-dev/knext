#!/bin/bash
# Build the SAME probe app against an old vinext and report the emitted dist/server layout.
# usage: e2-build-version.sh <vinext-version> <vite-range> <plugin-rsc-range> <dirname>
#
# NOTE: this writes `@vitejs/plugin-react: ^6.0.5` into the probe manifest. Callers that need a
# different plugin-react (e2-bisect.sh pins ^5 for the vite-7 line) MUST override it, reinstall
# and REBUILD -- see e2-bisect.sh, which does exactly that and fails loudly if either step fails.
set -uo pipefail
SC=/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad
S="$SC/pcprobe"
V="$1"; VITE="$2"; RSC="$3"; D="$SC/$4"

mkdir -p "$D"
cp -R "$S/app" "$D/" 2>/dev/null
cp -R "$S/public" "$D/" 2>/dev/null
cp "$S/next.config.ts" "$S/vite.config.ts" "$S/next-env.d.ts" "$D/" 2>/dev/null
cat > "$D/package.json" <<EOF
{
  "name": "vinext-e2-probe-$4",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "dependencies": {
    "@types/node": "^26.1.2",
    "@types/react": "^19.2.18",
    "@vitejs/plugin-react": "^6.0.5",
    "@vitejs/plugin-rsc": "$RSC",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "react-server-dom-webpack": "^19.2.8",
    "typescript": "^7.0.2",
    "vinext": "$V",
    "vite": "$VITE"
  }
}
EOF
cd "$D"
npm install --no-audit --no-fund --silent 2>&1 | tail -3
echo "installed vinext: $(node -e 'console.log(require("./node_modules/vinext/package.json").version)')"
echo "installed vite  : $(node -e 'console.log(require("./node_modules/vite/package.json").version)')"
echo "---- build"
NODE_ENV=production npx vinext build 2>&1 | tail -12
echo "---- emitted dist/server layout"
ls dist/server 2>/dev/null
echo "---- does dist/server/ssr/index.js exist? "
[ -f dist/server/ssr/index.js ] && echo "YES ($(wc -c < dist/server/ssr/index.js) bytes)" || echo "NO"
echo "---- createRequire('react-dom') shim in the ssr chunk?"
grep -c 'react-dom' dist/server/ssr/index.js 2>/dev/null
grep -o "createRequire" dist/server/ssr/index.js 2>/dev/null | wc -l | tr -d ' '
echo "---- how the rsc entry reaches the ssr chunk"
grep -o "[^;{},]\{0,60\}ssr/index\.js[^;{},]\{0,20\}" dist/server/index.js 2>/dev/null | head -4
