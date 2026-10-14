#!/usr/bin/env bash
# The SERVER_CMD (and SERVER_PATH) that makes the UNCHANGED compat-smoke
# runner (apps/file-manager/scripts/compat-smoke.mjs) boot the SHIPPED image:
# the digest-pinned image `knext deploy` pushed and the cluster runs, not a
# host-arch rebuild of its tree. run-compat-smoke-image.sh sets it up.
#
# The runner spawns its server with no arguments and its own env (PORT,
# HOSTNAME, NODE_ENV, REDIS_URL); that is `docker run` of the image with its
# OWN ENTRYPOINT (the supervisor, which spawns the compiled executable), on
# the host network so the runner reaches it on 127.0.0.1:$PORT and it reaches
# the runner's Redis. exec, so the runner's SIGTERM reaches the docker CLI,
# which proxies it to the container.
#
# Check (h) reads the embedded Bun version with `BUN_BE_BUN=1 <cmd>
# --version`; that is the image's compiled executable run as the bun CLI.
#
# Inputs (env, which the runner passes through to both spawns):
#   KNEXT_SMOKE_IMAGE       repo:tag@sha256:… (digest-pinned, or refused)
#   KNEXT_SMOKE_IMAGE_EXEC  the compiled executable's path in the image
#   KNEXT_SMOKE_CONTAINER   the container name (the caller removes it after)
set -euo pipefail

image="${KNEXT_SMOKE_IMAGE:?shipped-image-exec: KNEXT_SMOKE_IMAGE is not set}"
case "${image}" in
  *@sha256:*) ;;
  *)
    echo "shipped-image-exec: ${image} is not digest-pinned; refusing to smoke a tag that can move" >&2
    exit 2
    ;;
esac

if [ "${BUN_BE_BUN:-}" = 1 ]; then
  exe="${KNEXT_SMOKE_IMAGE_EXEC:?shipped-image-exec: KNEXT_SMOKE_IMAGE_EXEC is not set}"
  exec docker run --rm -e BUN_BE_BUN=1 --entrypoint "${exe}" "${image}" "$@"
fi

if [ "$#" -ne 0 ]; then
  echo "shipped-image-exec: the server takes no arguments (got: $*); the image's ENTRYPOINT is the server" >&2
  exit 2
fi
name="${KNEXT_SMOKE_CONTAINER:?shipped-image-exec: KNEXT_SMOKE_CONTAINER is not set}"
exec docker run --rm --name "${name}" --network host \
  -e PORT -e HOSTNAME -e NODE_ENV -e REDIS_URL \
  "${image}"
