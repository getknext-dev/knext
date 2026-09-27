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
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS builder

# Node is still required in the BUILD stage: tsup shells out to `tsc` for the
# .d.ts pass. It does not reach the runtime image. pnpm is gone — `bun install`
# drives the workspace now, which is also why there is no `npm i -g` layer.
RUN apk add --no-cache nodejs libstdc++ libgcc

WORKDIR /repo
COPY . .

RUN bun install --frozen-lockfile

# Order matters: docs imports the libraries' dist. Building docs first compiles
# against the PREVIOUS library — the app builds fine and the bug only appears at
# runtime, which is what made this expensive when file-manager hit it.
RUN bun run --filter "@getknext/lib" build
RUN bun run --filter "@getknext/db" build
RUN bun run --filter "@getknext/core" build

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

# Stage sharp + its native `@img/*` platform packages into a layout-independent
# location (#1506). bun's isolated-store install ("linker" default since
# 1.4) does NOT hoist either one to a fixed path: `node_modules/sharp` under
# an app is typically a SYMLINK out to the workspace root's
# `node_modules/.bun/sharp@<ver>+<hash>/node_modules/sharp`, and the `@img/*`
# platform packages (sharp has no code of its own — libvips ships as a
# separate native addon) get hoisted to `node_modules/.bun/node_modules/@img`
# at the WORKSPACE ROOT, never to a plain `node_modules/@img` at any fixed
# depth. `COPY --from=builder /repo/node_modules/@img …` assumed the latter
# and failed outright; it would have shipped a DANGLING symlink for `sharp`
# even had that path existed, since a plain `COPY` of a symlink copies the
# link, not its target, and the target directory it points at is never itself
# copied into the runtime stage.
#
# The search order below mirrors the candidate walk `findSharpPackageDir` /
# `findImgPackages` already use in `packages/kn-next/src/cli/vinext-build.ts`
# for the compiled-target twin of this same problem (#949) — app dir, bun's
# isolated store under the app dir, workspace root, bun's isolated store at
# the workspace root — and `cp -L` DEREFERENCES whatever symlinks bun used, so
# `/stage` holds real files, not pointers off the copied tree.
RUN set -eu; \
    sharp_dir=""; \
    for c in \
        node_modules/sharp \
        node_modules/.bun/node_modules/sharp \
        ../../node_modules/sharp \
        ../../node_modules/.bun/node_modules/sharp \
    ; do \
        if [ -d "$c" ]; then sharp_dir="$c"; break; fi; \
    done; \
    if [ -z "$sharp_dir" ]; then \
        echo "ERROR: could not locate the 'sharp' package under any known bun install layout (checked: apps/docs/node_modules/sharp, its .bun isolated store, and both at the workspace root)" >&2; \
        exit 1; \
    fi; \
    img_dir=""; \
    for c in \
        node_modules/@img \
        node_modules/.bun/node_modules/@img \
        ../../node_modules/@img \
        ../../node_modules/.bun/node_modules/@img \
    ; do \
        if [ -d "$c" ]; then img_dir="$c"; break; fi; \
    done; \
    if [ -z "$img_dir" ]; then \
        echo "ERROR: could not locate the '@img' sharp platform packages under any known bun install layout (checked: apps/docs/node_modules/@img, its .bun isolated store, and both at the workspace root)" >&2; \
        exit 1; \
    fi; \
    mkdir -p /stage/node_modules; \
    cp -RL "$sharp_dir" /stage/node_modules/sharp; \
    cp -RL "$img_dir" /stage/node_modules/@img

# ---------------------------------------------------------------------------
# Runtime — the nitro output and its assets. No node, no npm, no package
# manager, no compile-cache volume to mount or warm.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f

# Whole-base upgrade BEFORE the link libs: `apk upgrade --no-cache` pulls EVERY
# base-layer package (busybox, zlib, apk-tools, ssl_client, openssl, ...) up to the
# alpine branch's current patch — not a hand-picked few — so the NEXT base-layer HIGH
# is cleared without a bespoke PR naming the package. Base digest stays PINNED for
# reproducibility (ADR-0035); versions deliberately NOT pinned (a pinned version goes
# stale like the digest and hard-fails the day the branch drops it). This base is also
# Trivy-scanned by the base-image matrix in .github/workflows/supply-chain.yml.
RUN apk upgrade --no-cache && apk add --no-cache libstdc++ libgcc

WORKDIR /app

COPY --from=builder /repo/apps/docs/.output /app/.output
# sharp is a native module and cannot be bundled; it ships beside the server so
# /_next/image can optimize instead of silently serving originals. Copied from
# /stage (staged above, dereferenced), never straight off the workspace tree —
# see the staging RUN step for why.
COPY --from=builder /stage/node_modules /app/node_modules

USER 65532:65532

ENV PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production

EXPOSE 3000

# One process, nothing wrapping it — which is also why draining on SIGTERM is
# the entry's own job rather than a parent's.
CMD ["bun", ".output/server/index.mjs"]
