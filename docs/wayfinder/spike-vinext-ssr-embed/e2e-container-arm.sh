#!/bin/bash
# The end-to-end container arm, committed rather than elided.
#
# §6 of the findings doc previously wrote this as `docker run --platform=linux/amd64 ...` with no
# Dockerfile and no script on disk. Since this PR's headline finding is that HOST arms produce
# FALSE GREENS (§1.1 — the build host's ancestor node_modules feeds the resolver walk-up), the
# container invocation is the single highest-value artifact to have committed.
#
# What it does, in order:
#   1. bun build --compile --minify --bytecode --target=bun-linux-x64-musl on the bespoke knext
#      entry (knext-bare-entry.mjs), reporting the module count.
#   2. Assembles a CLEAN directory: binary + dist/client only. Asserts 0 node_modules and
#      0 server-side .js — an assertion, not a comment, because that is the whole control.
#   3. Asserts the container WORKDIR does NOT exist on the build host, so a build-host path
#      leaking into the binary cannot resolve.
#   4. Builds + runs the image and probes the nine-route set, then dumps a full SSR body.
#
# usage: bash e2e-container-arm.sh <built-probe-app-dir> <arm-name> <host-port>
set -uo pipefail
SC=/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$1"; NAME="$2"; PORT="$3"
WORKDIR="/opt/knext-$NAME"
W="$SC/ctr-$NAME"

cp "$HERE/knext-bare-entry.mjs" "$D/knext-bare-entry.mjs"
cd "$D"
echo "== compile"
bun build --compile --minify --bytecode --target=bun-linux-x64-musl \
  ./knext-bare-entry.mjs --outfile "/tmp/ctr-$NAME.bin" 2>&1 | grep -E "bundle|compile|error|warn"
echo "app marker in binary (want >0): $(grep -ac 'prerender-compile-probe' "/tmp/ctr-$NAME.bin")"

rm -rf "$W"; mkdir -p "$W/app/dist/client"
cp -R "$D/dist/client/." "$W/app/dist/client/"
cp "/tmp/ctr-$NAME.bin" "$W/app/knext-bin"
cat > "$W/app/Dockerfile" <<EOF
FROM alpine:3.22
RUN apk add --no-cache libstdc++ libgcc
WORKDIR $WORKDIR
COPY knext-bin $WORKDIR/knext-bin
COPY dist $WORKDIR/dist
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["$WORKDIR/knext-bin"]
EOF

nm=$(find "$W/app" -name node_modules | wc -l | tr -d ' ')
sj=$(find "$W/app/dist" -path '*server*' -name '*.js' | wc -l | tr -d ' ')
echo "clean dir: node_modules=$nm server-js=$sj"
[ "$nm" = "0" ] || { echo "ABORT: node_modules present in the clean dir"; exit 1; }
[ "$sj" = "0" ] || { echo "ABORT: server .js present in the clean dir"; exit 1; }
[ -d "$WORKDIR" ] && { echo "ABORT: $WORKDIR exists on the build host — not a valid control"; exit 1; }
echo "$WORKDIR on build host: ABSENT-GOOD"

echo "== container"
docker build --platform=linux/amd64 -t "knext-$NAME:musl" "$W/app" 2>&1 | tail -1
docker rm -f "$NAME" > /dev/null 2>&1
docker run -d --platform=linux/amd64 --name "$NAME" -p "$PORT:3000" "knext-$NAME:musl" > /dev/null
sleep 8
docker logs "$NAME" 2>&1 | grep -vE "AVX support|^  https" | head -8
node "$HERE/probe-routes.mjs" "http://127.0.0.1:$PORT"

echo "== full body of the dynamic (non-prerendered) SSR route, for the 'real SSR' claim"
node -e '
  const r = await fetch(process.argv[1]);
  const b = await r.text();
  const scripts = [...b.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)];
  const scriptBytes = scripts.reduce((a, m) => a + m[0].length, 0);
  console.log("status", r.status, "ctype", r.headers.get("content-type"), "bytes", Buffer.byteLength(b));
  console.log("references a /assets/ or /_next/ client bundle:", /(?:src|href)="[^"]*\/(assets|_next)\//.test(b));
  // vinext names its flight payload __VINEXT_RSC_CHUNKS__. An earlier version of this probe
  // tested only for React/Next names and reported a FALSE NEGATIVE on a body that plainly
  // carried one -- hence the literal name, and the raw body printed below as the check on it.
  console.log("carries an RSC/flight payload inline:", /__VINEXT_RSC_CHUNKS__|self\.__(?:vite_rsc|next)_f/.test(b));
  console.log("<script> tags:", scripts.length, " script bytes:", scriptBytes,
              " markup outside scripts:", Buffer.byteLength(b) - scriptBytes);
  // Truncated: a 500 here is a ~92 KB bun error overlay, and dumping it buries the result.
  console.log("---- body (first 4000 bytes) ----");
  console.log(b.length > 4000 ? b.slice(0, 4000) + "\n...[truncated]" : b);
' "http://127.0.0.1:$PORT/blog/alpha"
