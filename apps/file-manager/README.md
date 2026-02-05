# File Manager - Knative Next.js Demo

A demo Next.js 16 application showcasing the Knative Next.js framework with GCS caching, Redis tag invalidation, and real-time observability.

## Features

- 📁 File listing with metadata
- 📊 Dashboard with statistics
- 📜 Audit logs with infinite scroll
- 🔍 Real-time cache monitor
- ⚡ Tag-based cache invalidation

## Quick Deploy

```bash
./deploy.sh
```

This command handles everything:
1. Builds Next.js with `pnpm build`
2. Runs OpenNext: `npx open-next build`
3. Syncs static assets to GCS
4. Builds & pushes Docker image with BUILD_ID tag
5. Updates `knative-service.yaml`
6. Deploys to Knative

## Configuration

### kn-next.config.ts

```typescript
const config: KnativeNextConfig = {
    name: 'file-manager',
    storage: {
        provider: 'gcs',
        bucket: 'knative-next-assets-banna',
        publicUrl: 'https://storage.googleapis.com/knative-next-assets-banna',
    },
    cache: {
        provider: 'redis',
        url: 'redis://redis.default.svc.cluster.local:6379',
        keyPrefix: 'file-manager',
    },
    registry: 'us-central1-docker.pkg.dev/gsw-mcp/knative-next-repo',
};
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GCS_BUCKET_NAME` | GCS bucket for ISR cache |
| `GCS_BUCKET_KEY_PREFIX` | Key prefix (default: app name) |
| `REDIS_URL` | Redis connection URL |
| `DATABASE_URL` | PostgreSQL connection string |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to GCS service account key |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Kubernetes health check |
| `/api/audit?page=N` | GET | Paginated audit logs (20/page) |
| `/api/cache-stats` | GET | Cache hit/miss statistics |
| `/api/cache/events` | GET | SSE stream of cache events |
| `/api/cache/invalidate` | POST | Invalidate cache by tag |

### Cache Invalidation

```bash
# Invalidate all audit-related cache
curl -X POST http://localhost:3000/api/cache/invalidate \
  -H "Content-Type: application/json" \
  -d '{"tag": "audit"}'
```

### Cache Tags

| Tag | Used By |
|-----|---------|
| `audit` | Audit logs API |
| `audit-logs` | Audit logs API (alias) |
| `dashboard` | Dashboard page |

## Pages

| Route | Description |
|-------|-------------|
| `/` | File listing with upload |
| `/dashboard` | Statistics overview |
| `/users` | User management |
| `/audit` | Audit logs with infinite scroll |
| `/cache` | Cache monitor (SSE) |
| `/setup` | Database setup wizard |

## Development

```bash
# Install dependencies
pnpm install

# Run development server
pnpm dev

# Build for production
pnpm build

# Run OpenNext build
npx open-next build
```

## Deployment Files

| File | Purpose |
|------|---------|
| `deploy.sh` | Automated deployment script |
| `knative-service.yaml` | Knative service manifest |
| `Dockerfile.opennext` | Production Docker image |
| `open-next.config.ts` | Auto-generated OpenNext config |
| `kn-next.config.ts` | User configuration |
| `redis.yaml` | Redis deployment for tag cache |

## Cache Architecture

```
Browser Request
      │
      ▼
┌─────────────────┐
│ Knative Service │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌───────┐
│  GCS  │ │ Redis │
│ Cache │ │ Tags  │
└───────┘ └───────┘
```

- **GCS Cache**: Stores ISR data, fetch cache, images
- **Redis Tags**: Stores tag → keys mapping for invalidation

## Observability

### Cache Monitor (`/cache`)

Real-time visualization of:
- Cache hits/misses
- Event timeline
- Hit rate statistics
- Tag invalidation testing

### Events API (`/api/cache/events`)

Server-Sent Events stream:

```javascript
const es = new EventSource('/api/cache/events');
es.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // { type: 'HIT', layer: 'gcs', key: '...', durationMs: 12 }
};
```
