#!/bin/sh
# SPIKE ONLY — the exact `bun build` invocations behind P3's Q3 rows.
#
# The first revision of this spike described these in prose only, which meant the
# central compile claim could not be re-run. Run from the fixture app directory
# (the one holding `knext-entry-wasm.mjs`, `dist/` from `vinext build`, and a
# `node_modules` with vinext@1.0.0-beta.4 + the @jsquash codecs).
#
# Measured with bun 1.3.5.
set -eu

ENTRY=${ENTRY:-./knext-entry-wasm.mjs}

# Host arm (darwin-arm64) — the JIT/compiled comparison rows.
bun build --compile --minify --bytecode \
  "$ENTRY" --outfile knext-server-wasm

# Deployment-target arm — this is the binary that produced the 1,463 B AVIF in
# alpine:3.20. `--bytecode` was REQUESTED here; that it is actually present in
# the cross-compiled artifact was NOT verified by extraction.
bun build --compile --minify --bytecode --target=bun-linux-arm64-musl \
  "$ENTRY" --outfile knext-server-wasm-linux

# The `sharp` arm, kept because its FAILURE is the finding (both targets).
if [ -f ./knext-entry.mjs ]; then
  bun build --compile --minify --bytecode \
    ./knext-entry.mjs --outfile knext-server
  bun build --compile --minify --bytecode --target=bun-linux-arm64-musl \
    ./knext-entry.mjs --outfile knext-server-sharp
fi

ls -l knext-server-wasm knext-server-wasm-linux 2>/dev/null || true
