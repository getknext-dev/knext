#!/usr/bin/env bash
set -euo pipefail
npm i -g bun@1.4.2 >/dev/null 2>&1
echo "bun $(bun --version) node $(node --version) npm $(npm --version)"
cd /workspace/app && npm ci --no-audit --no-fund 2>&1 | tail -3
node -e 'for (const p of ["@getknext/core","@getknext/lib","@getknext/db","next","react","react-dom"]) console.log("VERSION", p, require("./node_modules/"+p+"/package.json").version)'
mkdir -p /workspace/cells
for cell in n131 b131; do
  case $cell in n131) rt=node;; b131) rt=bun;; esac
  echo "=== CELL $cell (runtime=$rt)"
  cp -a /workspace/app /workspace/cells/$cell
  cd /workspace/cells/$cell
  sed -i "s|^  name: \"b131\",|  name: \"$cell\",|; s|^  runtime: \"node\",|  runtime: \"$rt\",|" knext.config.ts
  grep -n -E '^  (name|runtime|registry|imagePullSecrets):|maxScale|containerConcurrency|imagePrewarm|scaleDownDelay' knext.config.ts
  npx knext build 2>&1 | tail -30
  T=node_modules/@getknext/core/templates/runtime-standalone
  cp $T/Dockerfile.standalone.hbs Dockerfile.standalone
  for f in knext-standalone-entry.mjs knext-compile-cache-bake.mjs knext-self-contained-server-shim.js; do cp $T/$f.hbs $f; done
  ls -la | grep -E 'knext-|Dockerfile'
done
