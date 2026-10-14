#!/usr/bin/env bash
# Runs the UNCHANGED compat-smoke runner (apps/file-manager/scripts/
# compat-smoke.mjs, the one ci.yml's compat-smoke job runs) against the
# SHIPPED image: the digest-pinned, linux-musl image `knext deploy` pushed,
# booted with its own ENTRYPOINT through shipped-image-exec.sh. Every check,
# (g) next/image included, is asserted on the artifact the cluster runs.
#
#   run-compat-smoke-image.sh <repo-root> <image-ref>
#
# <image-ref> must be digest-pinned (repo:tag@sha256:…). The compiled
# executable's path is read from the image's own STANDALONE_SERVER_EXEC (the
# supervisor's), so a renamed executable fails here rather than in check (h).
# Redis is flushed first (redis-flush.mjs). Needs REDIS_URL (check (k) never
# skips) and a runner whose docker can reach the image's registry. Exit
# status is the runner's.
set -euo pipefail

repo="$(cd "${1:?usage: run-compat-smoke-image.sh <repo-root> <image-ref>}" && pwd)"
image="${2:?usage: run-compat-smoke-image.sh <repo-root> <image-ref>}"
case "${image}" in
  *@sha256:*) ;;
  *)
    echo "run-compat-smoke-image: ${image} is not digest-pinned" >&2
    exit 1
    ;;
esac

docker pull --quiet "${image}"
exe="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${image}" \
  | sed -n 's/^STANDALONE_SERVER_EXEC=//p')"
if [ -z "${exe}" ]; then
  echo "run-compat-smoke-image: ${image} sets no STANDALONE_SERVER_EXEC; is it a compiled standalone (bun) image?" >&2
  exit 1
fi
echo "run-compat-smoke-image: ${image} (compiled executable ${exe})"

name="knext-smoke-shipped-$$"
cleanup() { docker rm -f "${name}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

cd "${repo}"
node packages/ffi/scripts/redis-flush.mjs
wrapper="${repo}/packages/ffi/scripts/shipped-image-exec.sh"
code=0
KNEXT_SMOKE_IMAGE="${image}" KNEXT_SMOKE_IMAGE_EXEC="${exe}" KNEXT_SMOKE_CONTAINER="${name}" \
  RUNTIME=bun SMOKE_EXEC_TRANSPORT=node-http SERVER_CMD="${wrapper}" SERVER_PATH="${wrapper}" \
  node apps/file-manager/scripts/compat-smoke.mjs || code=$?
exit "${code}"
