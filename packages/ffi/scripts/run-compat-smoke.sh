#!/usr/bin/env bash
# Runs the UNCHANGED compat-smoke runner (apps/file-manager/scripts/
# compat-smoke.mjs, the one ci.yml's compat-smoke job runs) against a
# host-arch twin of a `knext build` (turbopack x bun) standalone tree.
#
#   run-compat-smoke.sh <repo-root> <app-dir> <scratch-dir>
#
# The build's .next/standalone is COPIED into <scratch-dir> and laid out the
# way the standalone-bun image lays it out (.next/static and public/ inside
# the tree, the executable beside server.js), so the build's own freshness
# stamp, which `knext deploy --skip-build` checks, is never touched. The twin
# is compiled by compile-smoke-twin.ts (core's buildStandaloneExecutable for
# the host arch); the shipped executable is linux-musl and cannot run here.
#
# Needs REDIS_URL (check (k) never skips). Exit status is the runner's.
set -euo pipefail

repo="${1:?usage: run-compat-smoke.sh <repo-root> <app-dir> <scratch-dir>}"
app="${2:?usage: run-compat-smoke.sh <repo-root> <app-dir> <scratch-dir>}"
smoke="${3:?usage: run-compat-smoke.sh <repo-root> <app-dir> <scratch-dir>}"
if [ -e "${smoke}" ]; then
  echo "run-compat-smoke: ${smoke} already exists" >&2
  exit 1
fi
mkdir -p "${smoke}/.next"
cp -R "${app}/.next/standalone" "${smoke}/.next/standalone"
cp -R "${app}/.next/static" "${smoke}/.next/standalone/.next/static"
cp -R "${app}/public" "${smoke}/.next/standalone/public"
exe="${smoke}/.next/standalone/knext-smoke-exec"
(cd "${repo}" && bun packages/ffi/scripts/compile-smoke-twin.ts "${smoke}" "${exe}")
cd "${repo}"
RUNTIME=bun SMOKE_EXEC_TRANSPORT=node-http SERVER_CMD="${exe}" SERVER_PATH="${exe}" \
  node apps/file-manager/scripts/compat-smoke.mjs
