# Reference image for the opt-in `bun-exec` target (ADR-0042 A9).
#
# WHY `apk add libstdc++ libgcc` IS NOT OPTIONAL: bun's `-musl` targets are
# dynamically linked. A bare `FROM alpine` + the binary — the shape ADR-0036's
# image row describes — does NOT run:
#
#   Error loading shared library libstdc++.so.6: No such file or directory
#   Error loading shared library libgcc_s.so.1: No such file or directory
#   Error relocating /app/server: _ZSt20__throw_length_errorPKc: symbol not found
#   ... ~30 more relocation errors, container exits 127
#
# It was never caught because every prior validation ran the binary somewhere
# those libraries already existed. `test/alpine-image.docker-e2e.test.ts` builds THIS
# file and runs the container, so deleting the line below turns red.
#
# Digest-pinned per security.md ("pin images by digest; reject :latest") and
# enforced by scripts/check-base-images-pinned.sh (CI: base-image-pin-guard) —
# which SCANS every Dockerfile* in the tree, so this file was covered the moment
# it existed. The tag lives in a full-line comment because Docker rejects a
# trailing comment on a FROM line. This is the multi-arch INDEX digest, so the
# same pin resolves on linux/amd64 (CI) and linux/arm64 (local).
# alpine:3.22
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

RUN apk add --no-cache libstdc++ libgcc

# The binary produced by `./build.sh <arch>`; override for a non-default arch.
ARG BINARY=knext-bun-exec-linux-x64

WORKDIR /app

# The ship shape: the single executable + the static-asset dir, and NOTHING
# else. `.output/server` is deliberately NOT copied — the routes are embedded in
# the binary, and the e2e asserts its absence so a regression to a
# runtime-chunked server cannot pass unnoticed.
COPY ${BINARY} /app/server
COPY .output/public /app/.output/public

# Non-root (security.md runtime hardening). Both ports are >1024.
USER 65532:65532

ENV PORT=3000 \
    METRICS_PORT=9091

EXPOSE 3000 9091

CMD ["/app/server"]
