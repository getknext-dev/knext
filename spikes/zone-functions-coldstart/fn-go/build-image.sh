#!/usr/bin/env bash
# Build the Go function as a static linux/amd64 binary on a scratch image and
# push it to the kind registry with crane (no Docker build, no base image).
# Prints the digest-pinned ref to use as FN_GO_IMAGE.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${Z2_WORK:?scratch dir}/fn-go-$(date +%s)"
mkdir -p "$WORK/layer/app"
(cd "$HERE" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$WORK/layer/app/fn" .)
tar -C "$WORK/layer" -cf "$WORK/layer.tar" app
crane append --platform linux/amd64 -f "$WORK/layer.tar" -t localhost:5001/z2-fn-go:base >/dev/null
crane mutate localhost:5001/z2-fn-go:base --entrypoint /app/fn --user 65532:65532 \
  --set-platform linux/amd64 -t localhost:5001/z2-fn-go:z2
