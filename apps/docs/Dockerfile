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

# Pre-create the compile-cache directory.
RUN mkdir -p .next/compile-cache && chown -R node:node .next

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

# Drop privileges.
USER node

# NODE_COMPILE_CACHE: V8 bytecode cache for faster subsequent cold starts.
# EXPORT so the value reaches the exec'd node process. The operator's
# externally-injected value (PVC path) wins via `:-`; this is only the fallback.
CMD ["sh", "-c", "export NODE_COMPILE_CACHE=\"${NODE_COMPILE_CACHE:-.next/compile-cache}\"; exec node server.js"]
