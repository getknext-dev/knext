#!/usr/bin/env bash
#
# scripts/e2e-cleanup.sh — tear down a knext deployment for the official Next.js
# compatibility harness (#89, ADR-0007 A3-2). SEPARATE process from e2e-deploy.sh;
# reads the server PID/PORT from .adapter-build.log and stops it.
#
# Sends SIGTERM first (node-server / standalone drains in-flight requests + runs
# after() callbacks — the graceful-shutdown security rule), then SIGKILL fallback.
set -uo pipefail

APP_DIR="$(pwd)"
LOG_FILE="${APP_DIR}/.adapter-build.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/e2e-empty-dir.sh
. "${SCRIPT_DIR}/lib/e2e-empty-dir.sh"

# round-2 review, finding 3 (runner disk): captured BEFORE anything else runs,
# so the orphan sweep below only ever removes a `knext-empty-dir*` directory
# that already existed when THIS cleanup invocation started — never one a
# concurrently-running deploy (a different shard) creates while this script
# is executing.
ED_RUN_START_EPOCH="$(date +%s)"

# round-2 review, finding 3 (runner disk): sweeps orphaned `knext-empty-dir*`
# staging directories under RUNNER_TEMP (the pre-check dir from
# scripts/e2e-deploy.sh/-vinext.sh's §3c-ii/§6c, and a suite dir from a
# self-contained deploy killed before it could write SERVED_FROM_DIR to
# metadata — the normal, metadata-present path below removes its own
# SERVED_FROM_DIR directly and never needs this). Only entries OLDER than
# this script's own start are swept (see ED_RUN_START_EPOCH above) — never
# assumed, one `stat` per candidate, best-effort on a platform whose `stat`
# flags differ (GNU vs BSD/macOS, since this also runs under `bun test`
# locally).
ed_sweep_orphaned_empty_dirs() {
  local now="$1" root="${RUNNER_TEMP:-/tmp}" d mtime
  for d in "${root}"/knext-empty-dir.* "${root}"/knext-empty-dir-suite.*; do
    [ -d "${d}" ] || continue
    mtime="$(stat -c %Y "${d}" 2>/dev/null || stat -f %m "${d}" 2>/dev/null || echo "${now}")"
    if [ "${mtime}" -lt "${now}" ]; then
      rm -rf "${d}"
      echo "[e2e-cleanup] swept orphaned empty-dir staging directory ${d}" >&2
    fi
  done
}

if [ ! -f "${LOG_FILE}" ]; then
  # #1514: no metadata means no server to stop, but a self-contained deploy
  # killed before writing it may still have left APP_DIR hidden.
  ed_suite_restore_app_dir "${APP_DIR}" || true
  # round-2 review, finding 3: no metadata also means no SERVED_FROM_DIR to
  # read, so sweep by mtime instead — this is the one path where a leaked
  # empty-dir staging directory from a killed deploy would otherwise never be
  # found (the normal path below reads SERVED_FROM_DIR directly).
  ed_sweep_orphaned_empty_dirs "${ED_RUN_START_EPOCH}"
  echo "[e2e-cleanup] no .adapter-build.log — nothing to clean up" >&2
  exit 0
fi

PID="$(grep -E '^PID=' "${LOG_FILE}" | head -n1 | cut -d= -f2- || true)"
PORT="$(grep -E '^PORT=' "${LOG_FILE}" | head -n1 | cut -d= -f2- || true)"

echo "[e2e-cleanup] stopping deployment pid=${PID:-?} port=${PORT:-?}" >&2

if [ -n "${PID:-}" ] && kill -0 "${PID}" 2>/dev/null; then
  # graceful drain first
  kill -TERM "${PID}" 2>/dev/null || true
  for _ in $(seq 1 30); do
    if ! kill -0 "${PID}" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  # hard kill if still alive
  if kill -0 "${PID}" 2>/dev/null; then
    echo "[e2e-cleanup] SIGTERM timed out; sending SIGKILL to ${PID}" >&2
    kill -KILL "${PID}" 2>/dev/null || true
  fi
fi

# The node lane boots through knext's supervisor, whose Next child holds the
# port. A drained supervisor takes the child with it; a SIGKILLed one orphans
# it, so reap the recorded child too (a no-op when it already exited).
CHILD_PID="$(grep -E '^CHILD_PID=' "${LOG_FILE}" | head -n1 | cut -d= -f2- || true)"
if [ -n "${CHILD_PID:-}" ] && kill -0 "${CHILD_PID}" 2>/dev/null; then
  echo "[e2e-cleanup] reaping the supervisor's Next child pid=${CHILD_PID}" >&2
  kill -KILL "${CHILD_PID}" 2>/dev/null || true
fi

# ── #1166/#1225 (the compiled bun exec's docker boot) — reap the container ───
# `docker run --rm` only removes the container on ITS OWN exit; a hard
# SIGKILL of the `docker run` CLIENT above (PID) kills the CLIENT, not the
# container it was attached to, so a client that had to be force-killed can
# leave the container running. Best-effort, non-fatal on every other boot
# path (CONTAINER_NAME is absent — `docker rm` is simply skipped).
CONTAINER_NAME="$(grep -E '^CONTAINER_NAME=' "${LOG_FILE}" | head -n1 | cut -d= -f2- || true)"
if [ -n "${CONTAINER_NAME:-}" ] && command -v docker >/dev/null 2>&1; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
fi

# ── #1514: restore APP_DIR after a self-contained (served_from=empty-dir) run ─
# The deploy script hid APP_DIR's node_modules/.next/.output for the WHOLE
# suite run; restore them now that the server above is stopped. Unconditional
# and metadata-independent (a no-op when nothing was hidden, i.e. every disk
# run), so it also covers a deploy killed before it wrote SERVED_FROM.
ed_suite_restore_app_dir "${APP_DIR}" || echo "[e2e-cleanup] WARNING: could not restore every hidden APP_DIR entry — see above" >&2

# ── round-2 review, finding 3 (runner disk) — remove the suite's staged copy ──
# SERVED_FROM_DIR (written at metadata time, §5 of e2e-deploy.sh/-vinext.sh)
# is a mktemp path the deploy script itself owns — a full copy of the binary +
# static assets, on top of APP_DIR, that the suite server ran from. Nothing
# was ever removing it: about 33 deploys/shard × this one dir × 100+ MB each
# would otherwise accumulate in RUNNER_TEMP over a self-contained dispatch
# with no disk management. Read AFTER the server above is stopped (the same
# ordering the restore above depends on) and removed unconditionally — a
# no-op on every disk-mode run, where SERVED_FROM_DIR was never written.
SERVED_FROM_DIR="$(grep -E '^SERVED_FROM_DIR=' "${LOG_FILE}" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
if [ -n "${SERVED_FROM_DIR:-}" ] && [ -d "${SERVED_FROM_DIR}" ]; then
  rm -rf "${SERVED_FROM_DIR}"
  echo "[e2e-cleanup] removed the suite's staged empty dir ${SERVED_FROM_DIR}" >&2
fi

# ── #188 (bun-lane fix round 1) — surface the server log at teardown ──────────
# Triage's #1 finding (run 28607626868): every Bucket-1 "socket hang up"
# failure's real cause sat in .adapter-server.log and CI discarded it —
# e2e-logs.sh only runs at SETUP (next-deploy.ts fetchBuildLogsUsingCustomScript),
# so nothing surfaced the server stderr on a mere per-test failure. THIS
# script's output IS piped into the jest process by next-deploy.ts@v16.2.0
# cleanupUsingCustomScript (stdout/stderr pipes, lines 140-148), and
# run-tests.js prints that combined output inside the failing file's
# `❌ <file> output` group (hidden for passing files). Dump a BOUNDED tail
# (last 16 KiB — run-tests.js trims groups around 64 KiB) AFTER the kill, so
# shutdown-time exceptions are included too.
SERVER_LOG="$(grep -E '^SERVER_LOG=' "${LOG_FILE}" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
SERVER_LOG="${SERVER_LOG:-${APP_DIR}/.adapter-server.log}"

# ── #188 paths 2+3 — ship the sandbox-fetch instrumentation at teardown ──────
# The dispatch-only debug lane (KNEXT_SANDBOX_FETCH_DEBUG=1, see e2e-deploy.sh)
# writes host-side (path 2) and in-realm (path 3) phase lines into the server
# log; the generic 16KiB tail below can crop them on a chatty server, so
# surface them explicitly (bounded — run-tests.js trims output groups around
# 64KiB). This block is inert on every scheduled/default run (env unset).
if [ "${KNEXT_SANDBOX_FETCH_DEBUG:-0}" = "1" ] && [ -f "${SERVER_LOG}" ]; then
  echo "==== sandbox-fetch instrumentation (last 400 lines; KNEXT_SANDBOX_FETCH_DEBUG=1) ====" >&2
  grep -aE "\[sandbox-fetch-debug\]|\[sandbox-fetch-realm\]" "${SERVER_LOG}" 2>/dev/null | tail -n 400 >&2 || true
  echo "==== end of sandbox-fetch instrumentation ====" >&2
fi

if [ -f "${SERVER_LOG}" ]; then
  echo "==== knext standalone server log tail (${SERVER_LOG}; last 16KiB) ====" >&2
  tail -c 16384 "${SERVER_LOG}" >&2 || true
  echo "==== end of server log tail ====" >&2
else
  echo "[e2e-cleanup] no server log at ${SERVER_LOG}" >&2
fi

# best-effort: clear the log so a re-run starts clean
rm -f "${LOG_FILE}" 2>/dev/null || true

echo "[e2e-cleanup] done" >&2
exit 0
