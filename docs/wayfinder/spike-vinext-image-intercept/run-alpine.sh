#!/bin/sh
# SPIKE ONLY — the alpine:3.20 arm of P3 Q3, previously described in prose only.
#
# APPDIR must be an ISOLATED directory containing the linux-musl binary plus the
# assets under test and nothing else — that isolation is what makes "the binary
# is self-contained apart from these" a measurement rather than an assertion.
#
# `apk add libstdc++ libgcc` is required, not incidental: bun's `-musl` targets
# are NOT statically linked (ADR-0042 finding 1).
set -eu

APPDIR=${APPDIR:?set APPDIR to the isolated directory holding the binary}
BIN=${BIN:-./knext-server-wasm-linux}
PORT=${PORT:-3408}
NAME=${NAME:-knext-image-spike}

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT":3000 \
  -e PORT=3000 -e HOST=0.0.0.0 -e KNEXT_OUT_DIR=/app/dist \
  -v "$APPDIR":/app -w /app --platform linux/arm64 alpine:3.20 \
  sh -c "apk add --no-cache libstdc++ libgcc >/dev/null && $BIN"

echo "serving on http://127.0.0.1:$PORT"
echo "  node probe.mjs     $PORT <label>            # Q1/Q2 + Q4 correctness (takes a PORT)"
echo "  node cap-probe.mjs http://127.0.0.1:$PORT   # Q4 fail-closed caps (takes a URL)"
echo "  node load.mjs      $PORT                    # the no-cache latency numbers"
