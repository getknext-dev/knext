# knext-docs runtime image — ported from apps/file-manager/Dockerfile in the knext
# monorepo, adapted for a single-package (npm) repo instead of the pnpm workspace.
#
# Stage 1: build the Fumadocs Next.js app with standalone output.
FROM node:22-alpine AS builder
WORKDIR /app
COPY . .
# @knext/core is a file: dependency in the monorepo; in a real build it must be
# resolvable (vendored or published). See DEPLOY.md "Building the image".
RUN npm install --no-audit --no-fund
RUN npm run build

# Stage 2: lean production image using the Node standalone output.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install curl for the healthcheck.
RUN apk add --no-cache curl

# node:22-alpine ships a non-root `node` user/group at uid/gid 1000.

# Copy the standalone server bundle (includes the node_modules trace).
COPY --from=builder /app/.next/standalone ./
# Static assets served locally (non-CDN fallback).
COPY --from=builder /app/.next/static ./.next/static
# Public assets.
COPY --from=builder /app/public ./public

# ── Bake the V8 module compile cache INTO the image (#439) ───────────────────
# This used to be a bare `mkdir -p .next/compile-cache`, which shipped an EMPTY
# directory that nothing populated. NODE_COMPILE_CACHE only helps when the cache
# is already populated at process start, so every cold pod recompiled the whole
# standalone server from scratch, wrote the cache into the ephemeral container
# layer, and threw it away on scale-to-zero — the IDENTICAL bug ADR-0035 fixed
# for apps/file-manager (#437).
#
# The build now boots the SAME bare `node server.js` the CMD runs, with the SAME
# absolute NODE_COMPILE_CACHE (V8 keys entries by module filename, so the paths
# must match), waits for the dependency-free static home page `/` (docs serves no
# /api/health route, unlike file-manager), then SIGTERMs it — which is when V8
# flushes its accumulated entries to disk. The result lands in the image layer,
# so it is present from the FIRST pod onward (no volume; works on stock Knative)
# and can never go stale because it is versioned with the image. The script
# FAILS THE BUILD if the cache ends up empty or truncated.
#
# The warm-up script is the SHARED, promoted copy (ADR-0035 action item 2:
# scripts/warm-compile-cache.sh), so this second consumer inherits the guards
# instead of copy-pasting them. This single-package (npm) image builds from an
# apps/docs-rooted context, so — exactly as @knext/core is vendored into the
# build context (see DEPLOY.md "Resolve @knext/core") — the shared script is
# vendored to ./scripts/warm-compile-cache.sh before the build.
#
# NODE_COMPILE_CACHE here is ABSOLUTE (/app/…) on purpose: the warm-up CLEARS the
# cache dir before booting (#440) and its safety guard FATALs on a RELATIVE path.
# WORKDIR is /app, so this is the SAME on-disk dir the CMD default resolves to.
# The plausibility floor is sized for the smaller docs app (a static fumadocs
# site: no sharp, no @knext/core runtime supervisor), well below file-manager's
# 1106 entries / 4.25 MB reference — see the ADR-0035 determinism note.
COPY --from=builder /app/scripts/warm-compile-cache.sh /usr/local/bin/warm-compile-cache.sh
RUN chmod +x /usr/local/bin/warm-compile-cache.sh \
    && NODE_ENV=production \
       PORT=3000 \
       NODE_COMPILE_CACHE=/app/.next/compile-cache \
       KNEXT_WARMUP_BOOT_CMD="node server.js" \
       KNEXT_WARMUP_HEALTH_PATH=/ \
       KNEXT_WARMUP_MIN_FILES=100 \
       KNEXT_WARMUP_MIN_BYTES=300000 \
       /usr/local/bin/warm-compile-cache.sh \
    && chown -R node:node .next

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

# Drop privileges.
USER node

# NODE_COMPILE_CACHE: points at the V8 module compile cache that was POPULATED at
# image build time by the warm-up above (#439), so a cold pod loads baked bytecode
# instead of compiling the standalone server from source. Runtime writes to this
# dir are ephemeral (container layer) and that is fine — the baked entries are what
# every cold start reads.
# EXPORT so the value reaches the exec'd node process. The operator's
# externally-injected value (PVC path) still wins via `:-`; the Dockerfile only
# supplies the fallback, which is ABSOLUTE so it names the SAME dir the warm-up
# baked (WORKDIR is /app).
CMD ["sh", "-c", "export NODE_COMPILE_CACHE=\"${NODE_COMPILE_CACHE:-/app/.next/compile-cache}\"; exec node server.js"]
