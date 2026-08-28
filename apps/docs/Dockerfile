# syntax=docker/dockerfile:1
#
# knext-docs — vinext image (ADR-0048).
#
# Replaces the node/standalone image and, with it, the last consumer of the
# shared V8 compile cache. What that image needed and this one does not: a
# `.next/standalone` tree, `NODE_COMPILE_CACHE`, the vendored
# `scripts/warm-compile-cache.sh` warm-up step, and the absolute-path rules that
# warm-up imposed (V8 keys entries by module filename, so the build-time and
# run-time paths had to match exactly). None of it survives, because the build
# now emits a Nitro output that Bun runs directly.
#
# This image runs the UNCOMPILED `.output` under Bun rather than a
# `bun build --compile` single executable. That is deliberate and measured: the
# compiled binary cannot load a native module, which is what image optimization
# needs (EXPERIMENTS.md E13, ADR-0048 Amendment 2). Docs is served, not
# scaled-to-zero-critical, so the ~410ms it gives up is the cheaper side of that
# trade — and it is still far below the node standalone it replaces.

# ---------------------------------------------------------------------------
# Builder — the whole workspace, because docs depends on local @getknext/*
# packages and consumes them as BUILT dist, not source.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS builder

# Node is required in the BUILD stage only: the workspace packages compile with
# tsc/tsup and pnpm drives the install. It does not reach the runtime image.
RUN apk add --no-cache nodejs npm libstdc++ libgcc
RUN npm install -g pnpm@10.4.1

WORKDIR /repo
COPY . .

RUN pnpm install --frozen-lockfile

# Order matters: docs imports the libraries' dist. Building docs first compiles
# against the PREVIOUS library — the app builds fine and the bug only appears at
# runtime, which is what made this expensive when file-manager hit it.
RUN pnpm --filter "@getknext/lib" build
RUN pnpm --filter "@getknext/db" build
RUN pnpm --filter "@getknext/core" build

WORKDIR /repo/apps/docs

# fumadocs' MDX codegen. Bundler-independent — it emits `.source/` as ordinary
# TypeScript, which is what makes this site buildable off webpack at all.
RUN bunx fumadocs-mdx

# vinext -> nitro bun-preset .output/server/index.mjs
RUN ./node_modules/.bin/vite build

# Fail loudly rather than shipping an image whose CMD points at nothing — the
# #857 shape, where a build exits 0 while emitting no server.
RUN test -f .output/server/index.mjs \
    || (echo "vite build produced no .output/server/index.mjs" && exit 1)

# ---------------------------------------------------------------------------
# Runtime — the nitro output and its assets. No node, no npm, no package
# manager, no compile-cache volume to mount or warm.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb

RUN apk add --no-cache libstdc++ libgcc

WORKDIR /app

COPY --from=builder /repo/apps/docs/.output /app/.output
# sharp is a native module and cannot be bundled; it ships beside the server so
# /_next/image can optimize instead of silently serving originals.
COPY --from=builder /repo/apps/docs/node_modules/sharp /app/node_modules/sharp
COPY --from=builder /repo/node_modules/@img /app/node_modules/@img

USER 65532:65532

ENV PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production

EXPOSE 3000

# One process, nothing wrapping it — which is also why draining on SIGTERM is
# the entry's own job rather than a parent's.
CMD ["bun", ".output/server/index.mjs"]
