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
# Two details make the guard trustworthy rather than merely present:
#
#   1. It waits for the whole PROCESS TREE, not just the process it launched.
#      The runtime entry is a supervisor that SPAWNS the standalone `server.js`
#      (node-server.ts) — and it is that GRANDCHILD whose modules V8 caches. The
#      supervisor's graceful shutdown has a hard cap (SHUTDOWN_GRACE_MS, 25s) and
#      calls process.exit() even if the child has not finished, so waiting on the
#      supervisor alone can return while an orphaned server.js is still flushing
#      entries to disk — committing a PARTIAL cache into the image layer.
#   2. It asserts a PLAUSIBILITY FLOOR, not just non-emptiness. A truncated flush
#      leaves a handful of entries, which sails past a `>= 1` check — so the
#      anti-regression device would not fire on the very failure it exists for.
#      The failure mode is a silently degraded optimisation: the hardest kind to
#      notice, since the image still builds and the app still works, just slower.
set -eu

CACHE_DIR="${NODE_COMPILE_CACHE:-}"
if [ -z "$CACHE_DIR" ]; then
    echo "FATAL: NODE_COMPILE_CACHE must be set when baking the compile cache" >&2
    exit 1
fi

PORT="${PORT:-3000}"
# Seconds to wait for the server to answer the health probe.
READY_TIMEOUT_S="${KNEXT_WARMUP_TIMEOUT_S:-120}"
# Seconds to wait for the WHOLE process tree to exit cleanly after SIGTERM.
# Must comfortably exceed the runtime entry's own shutdown cap (SHUTDOWN_GRACE_MS,
# 25s by default — node-server.ts) PLUS the time the standalone child needs to
# flush its V8 entries, because we wait for the child too (see stop_server).
# Reaching this timeout is FATAL: a SIGKILLed server never flushed its cache.
STOP_TIMEOUT_S="${KNEXT_WARMUP_STOP_TIMEOUT_S:-60}"
# Plausibility floor for the baked cache. Reference values from the real build:
# 1106 entries / 4,246,032 bytes (CI) and 1106 / 4,246,088 (in-cluster run 6).
# The defaults sit ~5x and ~4x under those, so ordinary app-size variation never
# fails a healthy build, while a truncated flush still trips the wire.
# Overridable so other knext apps can adopt this script at their own size.
MIN_FILES="${KNEXT_WARMUP_MIN_FILES:-200}"
MIN_BYTES="${KNEXT_WARMUP_MIN_BYTES:-1000000}"
# The boot command. Overridable so the warm-up can be exercised in unit tests
# (and by a knext app whose runtime entry differs) without a container build.
BOOT_CMD="${KNEXT_WARMUP_BOOT_CMD:-node -e \"import('@knext/core/internal/node-server')\"}"

# Shallow health route: returns 200 as soon as the server is up, WITHOUT dialing
# Postgres or Redis. Never point this at the DEEP health route — probing real
# dependencies would make the image build require a live database.
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

mkdir -p "$CACHE_DIR"

# Decide HOW we will enumerate child processes before booting anything, so a
# platform we cannot walk fails immediately instead of orphaning a live server.
if command -v pgrep >/dev/null 2>&1; then
    PS_METHOD=pgrep
elif [ -r /proc/self/stat ]; then
    PS_METHOD=proc
else
    echo "FATAL: cannot enumerate child processes (no pgrep, no /proc)." >&2
    echo "       The warm-up must wait for the standalone server.js grandchild to" >&2
    echo "       flush its V8 entries; without that it could bake a PARTIAL cache." >&2
    exit 1
fi

echo "warm-compile-cache: booting runtime entry (NODE_COMPILE_CACHE=$CACHE_DIR)"
# `eval … &` backgrounds the command in THIS shell, so $! is the node process
# itself — not a wrapper subshell that SIGTERM would never reach through.
eval "$BOOT_CMD &"
BOOT_PID=$!

# Direct children of $1, space-separated. `pgrep -P` exists on both busybox (the
# alpine build image) and macOS/BSD (where the unit tests run); /proc is the
# no-tool-dependency fallback on Linux. If NEITHER works we abort rather than
# silently degrade to parent-only waiting — an undetected partial cache is worse
# than a loud build failure.
children_of() {
    if [ "$PS_METHOD" = "pgrep" ]; then
        pgrep -P "$1" 2>/dev/null | tr '\n' ' '
    else
        # /proc/<pid>/stat: field 2 is "(comm)" and may contain spaces and ')',
        # so drop everything through the LAST ')' — after that $2 is the ppid.
        for _stat in /proc/[0-9]*/stat; do
            [ -r "$_stat" ] || continue
            awk -v parent="$1" '{ p=$1; sub(/^.*\) /, ""); if ($2 == parent) print p }' \
                "$_stat" 2>/dev/null
        done | tr '\n' ' '
    fi
}

# Every descendant of $1 (children, grandchildren, …), space-separated.
# Iterative, not recursive: POSIX sh has no local variables, so a recursive walk
# would clobber its own loop state.
descendants_of() {
    _queue="$1"
    _found=""
    while [ -n "$_queue" ]; do
        _next=""
        for _p in $_queue; do
            for _k in $(children_of "$_p"); do
                _found="$_found $_k"
                _next="$_next $_k"
            done
        done
        _queue="$_next"
    done
    echo "$_found"
}

# True while any of the given PIDs is still running.
any_alive() {
    for _p in "$@"; do
        if kill -0 "$_p" 2>/dev/null; then return 0; fi
    done
    return 1
}

# PIDs of the process tree we must outlive. Captured BEFORE we signal anything:
# once the supervisor exits its children are reparented to PID 1, and `pgrep -P`
# can no longer relate them back to it.
TREE_PIDS=" $BOOT_PID "

# Add each PID in $1 to TREE_PIDS if not already tracked. PIDs are only ever
# ADDED — a process we once saw must stay on the wait-list even after it is
# reparented and can no longer be found by walking down from $BOOT_PID.
track_pids() {
    for _p in $1; do
        case "$TREE_PIDS" in
            *" $_p "*) ;;
            *) TREE_PIDS="$TREE_PIDS$_p " ;;
        esac
    done
}

stop_server() {
    # Snapshot the tree BEFORE signalling. The supervisor can exit almost
    # immediately (its shutdown cap does not wait for the child), and once it is
    # gone its children are reparented to PID 1 — so scanning after the SIGTERM
    # can miss the very process whose flush we need to wait for.
    track_pids "$(descendants_of "$BOOT_PID")"
    kill -TERM "$BOOT_PID" 2>/dev/null || true
    waited=0
    # Wait for the ENTIRE tree, not just $BOOT_PID. While the supervisor is still
    # alive keep re-scanning, so a child spawned late is picked up too.
    while [ "$waited" -lt "$STOP_TIMEOUT_S" ]; do
        if kill -0 "$BOOT_PID" 2>/dev/null; then
            # UNION, never replace: as soon as the supervisor exits (or becomes a
            # zombie awaiting reap) its children are reparented away, so a fresh
            # scan returns nothing. Overwriting here would silently DROP the very
            # grandchild we snapshotted above and stop waiting for it.
            track_pids "$(descendants_of "$BOOT_PID")"
        fi
        # shellcheck disable=SC2086 # intentional word-splitting of the PID list
        if ! any_alive $TREE_PIDS; then
            wait "$BOOT_PID" 2>/dev/null || true # reap
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done

    # Timed out: something never exited. SIGKILL it and report — a killed process
    # never flushed its cache entries, so anything baked so far is suspect.
    # shellcheck disable=SC2086
    for _p in $TREE_PIDS; do
        kill -KILL "$_p" 2>/dev/null || true
    done
    wait "$BOOT_PID" 2>/dev/null || true
    STOP_TIMED_OUT=1
}
STOP_TIMED_OUT=0

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

# SIGTERM is what makes V8 flush the accumulated cache entries to disk. This
# returns only once the supervisor AND the standalone server.js it spawned have
# both exited — measuring the cache while the child is still writing is exactly
# how a partial cache would get committed into the image layer.
stop_server

if [ "$STOP_TIMED_OUT" -ne 0 ]; then
    echo "FATAL: the warm-up process tree did not exit within ${STOP_TIMEOUT_S}s and was SIGKILLed." >&2
    echo "       A killed server never flushes its V8 entries, so the cache is partial" >&2
    echo "       at best. Raise KNEXT_WARMUP_STOP_TIMEOUT_S (must exceed the runtime's" >&2
    echo "       SHUTDOWN_GRACE_MS) or fix the shutdown path. Failing the build." >&2
    exit 1
fi

FILES=$(find "$CACHE_DIR" -type f | wc -l | tr -d ' ')
BYTES=$(find "$CACHE_DIR" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')

if [ "$FILES" -lt 1 ] || [ "$BYTES" -lt 1 ]; then
    echo "FATAL: the compile cache at $CACHE_DIR is EMPTY after warm-up" >&2
    echo "       ($FILES files, $BYTES bytes). Shipping an empty cache is the #437 bug:" >&2
    echo "       every cold pod would recompile the server from scratch. Failing the build." >&2
    exit 1
fi

# Non-empty is not enough: a truncated flush leaves a few entries and would pass
# a `>= 1` check while silently costing most of the cold-start win.
if [ "$FILES" -lt "$MIN_FILES" ] || [ "$BYTES" -lt "$MIN_BYTES" ]; then
    echo "FATAL: the compile cache at $CACHE_DIR looks PARTIAL after warm-up." >&2
    echo "       expected: >= $MIN_FILES files and >= $MIN_BYTES bytes" >&2
    echo "         actual: $FILES files, $BYTES bytes" >&2
    echo "       A truncated flush ships a cache that only covers part of the module" >&2
    echo "       graph, so cold pods still recompile most of the server — the #437 bug," >&2
    echo "       just quieter. If this app is legitimately smaller, lower the floor via" >&2
    echo "       KNEXT_WARMUP_MIN_FILES / KNEXT_WARMUP_MIN_BYTES. Failing the build." >&2
    exit 1
fi

echo "warm-compile-cache: baked $FILES entries, $BYTES bytes into $CACHE_DIR"
