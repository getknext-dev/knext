# Stage 1: Build Next.js app with standalone output
FROM node:22-alpine AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# next build → .next/standalone/ (output:'standalone' set in next.config.ts)
RUN pnpm --filter file-manager build

# Stage 2: Lean production image using Node.js standalone output
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install curl for healthcheck
RUN apk add --no-cache curl

# Create non-root user
RUN addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node

# Copy standalone server bundle (includes node_modules trace)
COPY --from=builder /app/apps/file-manager/.next/standalone ./
# Copy static assets served locally (non-CDN fallback)
COPY --from=builder /app/apps/file-manager/.next/static ./apps/file-manager/.next/static
# Copy public assets
COPY --from=builder /app/apps/file-manager/public ./apps/file-manager/public

# Pre-create the compile-cache directory
RUN mkdir -p apps/file-manager/.next/compile-cache && chown -R node:node apps/file-manager/.next

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Drop privileges
USER node

# NODE_COMPILE_CACHE: V8 bytecode cache for faster subsequent cold starts
CMD ["sh", "-c", "NODE_COMPILE_CACHE=apps/file-manager/.next/compile-cache node apps/file-manager/server.js"]
