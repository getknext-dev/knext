# Multi-Zone Architecture

This project has been refactored to use Next.js Multi-Zone architecture for improved build performance and scalability.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Main App                             │
│                    (apps/main)                               │
│  - Routing/Proxy layer                                       │
│  - Home page                                                 │
│  - Rewrites traffic to zones                                 │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  Dashboard    │   │    Users      │   │   Future      │
│  Zone         │   │    Zone       │   │   Zones       │
│ (apps/        │   │ (apps/users)  │   │               │
│  dashboard)   │   │               │   │               │
│               │   │               │   │               │
│ /dashboard/*  │   │ /users/*      │   │               │
└───────────────┘   └───────────────┘   └───────────────┘
        │                   │
        └───────────────────┘
                  │
                  ▼
        ┌───────────────────┐
        │   Shared UI       │
        │ (packages/ui)     │
        │ - shadcn/ui       │
        │ - Button, Card    │
        └───────────────────┘
```

## Zones

### Main (`apps/main`)
- **Port**: 3000
- **Base Path**: `/`
- **Purpose**: Entry point and routing layer
- **Routes**: Home page, navigation

### Dashboard (`apps/dashboard`)
- **Port**: 3001
- **Base Path**: `/dashboard`
- **Asset Prefix**: `/dashboard-static`
- **Purpose**: Dashboard and analytics
- **Routes**: `/dashboard/*`

### Users (`apps/users`)
- **Port**: 3002
- **Base Path**: `/users`
- **Asset Prefix**: `/users-static`
- **Purpose**: User management
- **Routes**: `/users/*`

## Development

### Run all zones in parallel:
```bash
turbo dev
```

### Run individual zones:
```bash
# Main app
cd apps/main && bun dev

# Dashboard zone
cd apps/dashboard && bun dev

# Users zone
cd apps/users && bun dev
```

## Building

### Build all zones with Turbopack:
```bash
turbo build
```

### Build individual zones:
```bash
cd apps/dashboard && bun run build
cd apps/users && bun run build
cd apps/main && bun run build
```

## Testing

### Run all tests:
```bash
turbo test
```

### Run tests for specific zone:
```bash
npx vitest run apps/dashboard/
npx vitest run apps/users/
```

## Benefits

1. **Parallel Builds**: Turborepo builds zones in parallel
2. **Turbopack**: Each zone uses `--turbo` for faster builds
3. **Independent Deployment**: Deploy zones separately
4. **Shared UI**: Common components via `@knative-next/ui`
5. **Scalability**: Easy to add new zones
6. **Isolation**: Changes to one zone don't affect others

## Adding a New Zone

1. Create new app: `mkdir -p apps/new-zone`
2. Copy config from existing zone
3. Update `basePath` and `assetPrefix` in `next.config.ts`
4. Add rewrites to `apps/main/next.config.ts`
5. Add to workspace in root `package.json`

## Environment Variables

Set these in production:
- `DASHBOARD_URL`: URL of dashboard zone
- `USERS_URL`: URL of users zone
- `DATABASE_URL`: Database connection
- `MINIO_*`: MinIO configuration
- `CERBOS_URL`: Cerbos authorization server

