#!/usr/bin/env bash
# Build the Rust function as a static linux/amd64 musl binary (inside an amd64
# rust:alpine container, so no cross toolchain is needed on the Mac), put it on
# a scratch image and push it to the kind registry with crane. Prints the
# digest-pinned ref to use as FN_RUST_IMAGE.
#
# Regenerate ping.binpb after a proto change:
#   buf build ../proto --as-file-descriptor-set -o ping.binpb
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${Z2_WORK:?scratch dir}"
mkdir -p "$WORK/rust-target" "$WORK/fn-rust-layer/app"
docker run --rm --platform linux/amd64 \
  -v "$HERE":/src -v z2-cargo-home:/cargo -v "$WORK/rust-target":/target \
  -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR=/target -e CARGO_HTTP_MULTIPLEXING=false -w /src \
  rust:1.90-alpine sh -c "apk add --no-cache musl-dev >/dev/null && cargo build --release"
cp "$WORK/rust-target/release/fn-rust" "$WORK/fn-rust-layer/app/fn"
tar -C "$WORK/fn-rust-layer" -cf "$WORK/fn-rust-layer.tar" app
crane append --platform linux/amd64 -f "$WORK/fn-rust-layer.tar" -t localhost:5001/z2-fn-rust:base >/dev/null
crane mutate localhost:5001/z2-fn-rust:base --entrypoint /app/fn --user 65532:65532 \
  --set-platform linux/amd64 -t localhost:5001/z2-fn-rust:z2
