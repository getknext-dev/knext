# syntax=docker/dockerfile:1
#
# file-manager — vinext single-executable image (ADR-0048).
#
# Replaces the multi-stage node/standalone image. What that one needed and this
# one does not: a package manager in the runtime layer, a `node_modules` deploy, a separate
# `sharp` runtime stage, and the baked V8 compile cache
# (`scripts/warm-compile-cache.sh`). None of it survives, because the server is
# one binary.
#
# MEASURED on this app, same source, same route, n=6:
#
#   node + standalone      cold 2670ms   p95 2780   127 req/s
#   vinext single-exec      cold  753ms   p95  777  1092 req/s
#                          3.5x faster    8.6x throughput
#
# Bytecode is NOT passed. `bun build --bytecode` emits CommonJS, and the
# vinext/nitro generated bundle uses `import.meta`, which is a syntax error
# there — the binary builds with a warning and then dies at boot. That is an
# upstream limitation, not a knext one, and the numbers above are without it.
# Add `--bytecode` the day it works; nothing else here changes.
# See docs/benchmarks/EXPERIMENTS.md E11-E12.

# ---------------------------------------------------------------------------
# Builder — needs the whole workspace, because the app depends on the local
# @getknext/* packages and they are consumed as BUILT dist, not source.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS builder

# Node is still required in the BUILD stage: tsup shells out to `tsc` for the
# .d.ts pass. It does not reach the runtime image. pnpm is gone — `bun install`
# drives the workspace now, which is also why there is no `npm i -g` layer.
RUN apk add --no-cache nodejs libstdc++ libgcc

WORKDIR /repo
COPY . .

RUN bun install --frozen-lockfile

# Order matters: file-manager imports @getknext/lib's dist. Building the app
# before the library compiles the OLD library — a mistake that cost real time
# here, because the app builds fine and the bug only appears at runtime.
RUN bun run --filter "@getknext/lib" build
RUN bun run --filter "@getknext/db" build
RUN bun run --filter "@getknext/core" build

WORKDIR /repo/apps/file-manager

# vinext -> nitro bun-preset .output/server/index.mjs
RUN ./node_modules/.bin/vite build

# Fail loudly here rather than shipping an image whose CMD points at nothing.
# This is the #857 shape: a build that exits 0 while emitting no server.
RUN test -f .output/server/index.mjs \
    || (echo "vite build produced no .output/server/index.mjs" && exit 1)

# The compile target must match the RUNTIME image's libc AND its architecture.
# alpine is musl; a glibc binary exits with no useful message.
#
# Derived from buildx's TARGETARCH rather than defaulted, because a default is
# only ever right on one machine. It used to be `bun-linux-arm64-musl` — correct
# on an Apple Silicon laptop, and silently wrong everywhere else. CI passes no
# build-arg, so the amd64 runner compiled an arm64 binary and the container died
# with `exec /app/server: exec format error` after starting successfully. OKE is
# amd64 too, so the same image could not have run there.
#
# BUN_TARGET stays overridable for a caller that wants to cross-compile
# deliberately; it just no longer has a guess baked in as its default.
ARG TARGETARCH
ARG BUN_TARGET=
RUN set -eu; \
    if [ -z "${BUN_TARGET}" ]; then \
      case "${TARGETARCH}" in \
        amd64) BUN_TARGET=bun-linux-x64-musl ;; \
        arm64) BUN_TARGET=bun-linux-arm64-musl ;; \
        *) echo "unsupported TARGETARCH='${TARGETARCH}' — add its bun target" >&2; exit 1 ;; \
      esac; \
    fi; \
    echo "compiling for TARGETARCH=${TARGETARCH} -> ${BUN_TARGET}"; \
    KNEXT_BUN_TARGET="${BUN_TARGET}" \
    KNEXT_EXEC_OUTFILE=/repo/knext-exec \
      bun run scripts/compile-single-exec.mjs

# The sharp addon, staged for the runtime layer.
#
# It cannot go INSIDE the binary: `--asset` embeds it and the OS still cannot
# `dlopen` a path in the binary's virtual filesystem. It is loaded by absolute
# path instead (see @getknext/core's sharp-addon-dlopen shim).
#
# `cp -RL` dereferences: bun's isolated store keeps these under
# `node_modules/.bun/node_modules/@img`, reached by symlink, and a plain `cp -R`
# would copy the links and leave the runtime layer with dangling pointers.
#
# The WHOLE `@img` tree, not a per-platform pair, and the layout preserved:
#
#   - naming it per-platform means encoding sharp's own scheme, and that guess
#     was wrong — sharp uses `linuxmusl`, one word, not `linux-musl`. The build
#     failed on `can't stat .../@img/sharp-linux-musl-x64`.
#   - bun installs only the optional packages matching the build platform, so
#     copying everything present IS the per-platform set, without the naming.
#   - the addon links libvips by a RELATIVE rpath, so flattening the tree makes
#     `dlopen` find the addon and then fail on `libvips-cpp`.
#
# The `-not -path '*libvips*'` matters: libvips ships a `stub.node` that also
# matches `sharp-*`, and selecting it would dlopen the wrong library.
RUN set -eu; \
    SRC=/repo/node_modules/.bun/node_modules/@img; \
    test -d "$SRC" || { echo "no @img packages installed at $SRC" >&2; exit 1; }; \
    mkdir -p /repo/native; \
    cp -RL "$SRC"/. /repo/native/; \
    ADDON=$(find /repo/native -name 'sharp-*.node' -not -path '*libvips*' | head -1); \
    test -n "$ADDON" || { echo "no sharp addon staged under /repo/native" >&2; exit 1; }; \
    echo "staged sharp addon: $ADDON"

# ---------------------------------------------------------------------------
# Runtime — the binary, its public assets, and the two libraries Bun links.
# No node, no npm, no package manager, no bytecode cache to mount.
# ---------------------------------------------------------------------------
# Named `runner` because ci.yml's prod-image job builds `target: runner`. The
# vinext rewrite replaced the old node-based runtime stage with this compiled
# single-binary one and left it unnamed, so the build died with
# `target stage "runner" could not be found`. Naming the stage keeps the
# workflow's contract explicit rather than making it build whatever is last.
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce AS runner

RUN apk add --no-cache libstdc++ libgcc

WORKDIR /app

# NEVER name this after a runtime (`bun`, `node`, `deno`): knext's asset-root
# resolver classifies a compiled binary by basename, and those names make it
# read the build tree's assets instead of the image's.
COPY --from=builder /repo/knext-exec /app/server
COPY --from=builder /repo/apps/file-manager/.output/public /app/.output/public
# The sharp addon + libvips. ~18 MB, and the reason /_next/image can optimize at
# all: a compiled binary cannot resolve a package from disk, so the native module
# ships beside the executable and is opened by path.
#
# No env var wires this up — the shim DISCOVERS `native/sharp-*/lib/sharp-*.node`
# next to the executable. One less value to set correctly in a deploy manifest,
# and a mis-set one is a failure mode the shim already had to defend against.
COPY --from=builder /repo/native /app/native

USER 65532:65532

ENV PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production

EXPOSE 3000

# One process. No supervisor, no `sh -c`, nothing to spawn — which is also why
# draining on SIGTERM is the entry's own job rather than a parent's.
CMD ["/app/server"]
