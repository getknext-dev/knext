#!/bin/sh
# Bake the V8 module compile cache into the image at BUILD time (#437).
#
# Why this exists
# ---------------
# NODE_COMPILE_CACHE only pays off if the cache is already POPULATED when a
# process starts. Before #437 the Dockerfile merely `mkdir`ed the cache dir and
# pointed the runtime CMD at it, so every cold pod compiled the whole standalone
# server from scratch (~2s of a 3.81s median cold start measured on OKE), wrote
# the cache into the EPHEMERAL container layer, and threw it away on
# scale-to-zero. Nothing ever survived a cold start.
#
# Baking it at build time puts the cache inside the image layer, so it is:
#   - present from the FIRST pod onward (no "someone must warm it" precondition),
#   - per-pod (no RWO volume to strand a multi-node scale-out, #432),
#   - available on stock Knative (no PVC support required, #436),
#   - versioned with the image, so it can never go stale against the code.
#
# The warm-up boots the SAME runtime entry the CMD boots, with the SAME
# NODE_COMPILE_CACHE and STANDALONE_SERVER_PATH values — V8 keys cache entries by
# module filename, so a cache baked under different paths would be dead weight.
# It waits for the shallow, dependency-free health route (ADR-0026) rather than
# sleeping a fixed time, so the build never needs Postgres/Redis/network, then
# stops the server with SIGTERM (the runtime entry's graceful-shutdown path),
# which is when V8 flushes its accumulated entries to disk.
#
# Finally it ASSERTS the cache is non-empty and fails the build otherwise. The
# bug this file fixes was precisely an empty dir shipping unnoticed; without this
# check the same regression is invisible again.
set -eu

CACHE_DIR="${NODE_COMPILE_CACHE:-}"
if [ -z "$CACHE_DIR" ]; then
    echo "FATAL: NODE_COMPILE_CACHE must be set when baking the compile cache" >&2
    exit 1
fi

PORT="${PORT:-3000}"
# Seconds to wait for the server to answer the health probe.
READY_TIMEOUT_S="${KNEXT_WARMUP_TIMEOUT_S:-120}"
# Seconds to wait for a clean SIGTERM exit before escalating to SIGKILL.
STOP_TIMEOUT_S="${KNEXT_WARMUP_STOP_TIMEOUT_S:-30}"
# The boot command. Overridable so the warm-up can be exercised in unit tests
# (and by a knext app whose runtime entry differs) without a container build.
BOOT_CMD="${KNEXT_WARMUP_BOOT_CMD:-node -e \"import('@knext/core/internal/node-server')\"}"

# Shallow health route: returns 200 as soon as the server is up, WITHOUT dialing
# Postgres or Redis. Never point this at the DEEP health route — probing real
# dependencies would make the image build require a live database.
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

mkdir -p "$CACHE_DIR"

echo "warm-compile-cache: booting runtime entry (NODE_COMPILE_CACHE=$CACHE_DIR)"
# `eval … &` backgrounds the command in THIS shell, so $! is the node process
# itself — not a wrapper subshell that SIGTERM would never reach through.
eval "$BOOT_CMD &"
BOOT_PID=$!

stop_server() {
    kill -TERM "$BOOT_PID" 2>/dev/null || true
    waited=0
    while kill -0 "$BOOT_PID" 2>/dev/null && [ "$waited" -lt "$STOP_TIMEOUT_S" ]; do
        sleep 1
        waited=$((waited + 1))
    done
    kill -KILL "$BOOT_PID" 2>/dev/null || true
    wait "$BOOT_PID" 2>/dev/null || true
}

ready=0
elapsed=0
while [ "$elapsed" -lt "$READY_TIMEOUT_S" ]; do
    if ! kill -0 "$BOOT_PID" 2>/dev/null; then
        echo "FATAL: warm-up server exited before it was ready — cannot bake the compile cache" >&2
        wait "$BOOT_PID" 2>/dev/null || true
        exit 1
    fi
    if curl -sf -o /dev/null --max-time 2 "$HEALTH_URL"; then
        ready=1
        break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

if [ "$ready" -ne 1 ]; then
    echo "FATAL: warm-up server was not ready within ${READY_TIMEOUT_S}s ($HEALTH_URL)" >&2
    stop_server
    exit 1
fi

echo "warm-compile-cache: server ready after ${elapsed}s; exercising routes"
# Pull the app-router render path through the compiler too. Best-effort: a
# non-200 here (e.g. a page that needs a database) must not fail the build — the
# module graph it loaded on the way is already compiled and cached.
curl -sf -o /dev/null --max-time 10 "http://127.0.0.1:${PORT}/" || true

# SIGTERM is what makes V8 flush the accumulated cache entries to disk.
stop_server

FILES=$(find "$CACHE_DIR" -type f | wc -l | tr -d ' ')
BYTES=$(find "$CACHE_DIR" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')

if [ "$FILES" -lt 1 ] || [ "$BYTES" -lt 1 ]; then
    echo "FATAL: the compile cache at $CACHE_DIR is EMPTY after warm-up" >&2
    echo "       ($FILES files, $BYTES bytes). Shipping an empty cache is the #437 bug:" >&2
    echo "       every cold pod would recompile the server from scratch. Failing the build." >&2
    exit 1
fi

echo "warm-compile-cache: baked $FILES entries, $BYTES bytes into $CACHE_DIR"
