#!/usr/bin/env bash
#
# scripts/e2e-logs.sh — print the knext deployment logs for the official Next.js
# compatibility harness (#89, ADR-0007 A3-2). The harness calls this (cwd = the
# fixture app dir) when a test fails, to capture diagnostics. It is a SEPARATE
# process from e2e-deploy.sh and shares state only via .adapter-build.log.
#
# Prints: the harness-parseable id block FIRST, then the deployment metadata
# (.adapter-build.log) + the captured server stdout/stderr (.adapter-server.log).
#
# #147 A3-3 fix round 1, follow-up 2 (branch run 28563269411): deployments fully
# worked, and then EVERY test failed at `Failed to get buildId from logs …`.
# GROUND TRUTH (vercel/next.js@v16.2.0, test/lib/next-modes/next-deploy.ts):
# after running this script the harness combines stdout+stderr (line 123) and
# parseIdsFromCliOuput() (lines 159-182) REQUIRES all three, colon+space form:
#   /BUILD_ID: (.+)/              (line 160 — hard throw if absent)
#   /DEPLOYMENT_ID: (.+)/         (line 165 — hard throw if absent)
#   /IMMUTABLE_ASSET_TOKEN: (.+)/ (line 171 — hard throw if absent; the literal
#                                  string "undefined" is accepted and mapped to
#                                  undefined at line 179)
# Our metadata dump printed the equals-form `BUILD_ID=<id>`, which those regexes
# never match. So: emit the EXACT parseable block first (sourced from the
# metadata e2e-deploy.sh persisted), then keep the human-useful dumps. knext has
# no Vercel-style immutable-asset (skew) token → the documented "undefined"
# escape. The regexes are unanchored first-match, so the block leads stdout.
set -uo pipefail

APP_DIR="$(pwd)"
LOG_FILE="${APP_DIR}/.adapter-build.log"
SERVER_LOG="${APP_DIR}/.adapter-server.log"

meta() { # <KEY> → value of the KEY=... line in the metadata file (empty if absent)
  grep -E "^$1=" "${LOG_FILE}" 2>/dev/null | head -n1 | cut -d= -f2-
}

BUILD_ID="$(meta BUILD_ID)"
DEPLOYMENT_ID="$(meta DEPLOYMENT_ID)"
if [ -n "${BUILD_ID}" ] && [ -n "${DEPLOYMENT_ID}" ]; then
  echo "==== harness-parseable deployment ids (next-deploy.ts contract, v16.2.x + v16.3.x) ===="
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${DEPLOYMENT_ID}"
  # v16.2.x harness parses IMMUTABLE_ASSET_TOKEN; v16.3.x replaced it with
  # NEXT_SUPPORTS_IMMUTABLE_ASSETS (0|1) and THROWS if absent. Emit both so one
  # log hook serves both Next versions. Value 0: knext's targets do not implement
  # Next's immutable content-addressed assets (`/_next/static/immutable/*`), so
  # advertising 1 would run immutable-asset tests the deployment cannot satisfy.
  echo "IMMUTABLE_ASSET_TOKEN: undefined"
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: 0"
else
  # HONESTY: no fake parseable ids. Without metadata the deploy did not persist
  # (or never ran) — let the harness's own "Failed to get buildId from logs"
  # throw carry THIS dump, which names the cause, instead of masking it behind
  # a bogus "unknown" id that would fail assertions much further downstream.
  echo "(no harness-parseable ids: ${LOG_FILE} is missing or incomplete — deploy may not have run)"
fi

echo ""
echo "==== knext deployment metadata (.adapter-build.log) ===="
if [ -f "${LOG_FILE}" ]; then
  cat "${LOG_FILE}"
else
  echo "(no .adapter-build.log — deploy may not have run)"
fi

echo ""
echo "==== next build output (.adapter-next-build.log) ===="
# #147 A3-3 fix round 2 (B4, triage of run 28564443662): harness tests assert
# on `next build` warnings via fetchCliOutputs() → THIS script (e.g.
# next-config-warnings, app-middleware's deprecated-middleware warning,
# prerender's large-page-data warning). e2e-deploy.sh persists the full build
# stream; print it AFTER the parseable id block (parseIdsFromCliOuput takes the
# FIRST match, so a build line like "BUILD_ID: x" can never shadow the real ids).
BUILD_LOG="$(meta BUILD_LOG)"
BUILD_LOG="${BUILD_LOG:-${APP_DIR}/.adapter-next-build.log}"
if [ -f "${BUILD_LOG}" ]; then
  cat "${BUILD_LOG}"
else
  echo "(no next build log at ${BUILD_LOG} — build may not have run)"
fi

echo ""
echo "==== knext standalone server log (.adapter-server.log) ===="
# Prefer the SERVER_LOG path recorded in the metadata, else the default location.
RECORDED_SERVER_LOG="$(grep -E '^SERVER_LOG=' "${LOG_FILE}" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
SERVER_LOG="${RECORDED_SERVER_LOG:-${SERVER_LOG}}"
if [ -f "${SERVER_LOG}" ]; then
  cat "${SERVER_LOG}"
else
  echo "(no server log at ${SERVER_LOG})"
fi
