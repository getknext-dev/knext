# Stage 1: Build Vinext app with Node + pnpm
FROM node:22-alpine AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN NITRO_PRESET=bun pnpm --filter file-manager build

# Stage 2: Compile executable using Bun named image (latest 1.x version)
FROM oven/bun:1.3.10-alpine AS compiler
WORKDIR /app
COPY --from=builder /app /app
WORKDIR /app/apps/file-manager
# We compile to linux-x64-musl since we'll run on Alpine
RUN bun build --compile --minify --bytecode --target=bun-linux-x64-musl .output/server/index.mjs --outfile file-manager-server

# Stage 3: Final runner stage using pure alpine
FROM alpine:latest AS runner
WORKDIR /app/apps/file-manager
ENV NODE_ENV=production
ENV PORT=3000

# Install required network tools and C++ standard libraries needed by the compiled bun executable
RUN apk add --no-cache ca-certificates wget libstdc++ libgcc

# Create node user and group
RUN addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node

# Pre-create the Next.js cache directory to avoid permission issues
RUN mkdir -p .next/cache .next/server && chown -R node:node .next

# Copy the compiled executable and public assets from compiler
COPY --from=compiler /app/apps/file-manager/file-manager-server ./file-manager-server
COPY --from=compiler /app/apps/file-manager/.output/public ./.output/public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Drop privileges
USER node

# Run the single binary executable
CMD ["./file-manager-server"]
