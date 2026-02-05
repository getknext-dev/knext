# OpenNext Production Dockerfile
# Uses pre-built .open-next output (built by kn-next CLI)
# Build from repo root: docker build -f apps/file-manager/Dockerfile .

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy pre-built OpenNext server bundle (built by CLI, not Docker)
COPY apps/file-manager/.open-next/server-functions/default ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "index.mjs"]
