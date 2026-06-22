# Knative Next.js Architecture

## Overview

This framework enables deploying Next.js applications as Knative services on GKE with Fluid Compute characteristics. It uses the **official Next.js Deployment Adapter API** (`experimental.adapterPath`) with `output:'standalone'` to produce a self-contained Node.js server, while providing pluggable adapters for storage, caching, and messaging.

## System Architecture

```mermaid
flowchart TB
    subgraph GKE["Google Kubernetes Engine"]
        subgraph Knative["Knative Serving"]
            FM["file-manager<br/>Knative Service"]
        end
        
        subgraph Infrastructure["Infrastructure Services"]
            Redis["Redis<br/>Tag Cache"]
            PG["PostgreSQL<br/>Application Data"]
        end
    end
    
    subgraph GCP["Google Cloud Platform"]
        GCS["Cloud Storage<br/>Static Assets"]
        AR["Artifact Registry<br/>Container Images"]
    end
    
    User["Browser"] --> FM
    FM --> GCS
    FM --> Redis
    FM --> PG
    
    style FM fill:#4285f4,color:#fff
    style GCS fill:#34a853,color:#fff
    style Redis fill:#dc3545,color:#fff
    style PG fill:#336791,color:#fff
```

## Key Components

### 1. Official Next.js Adapter (`output:'standalone'`)

`next build` with `output:'standalone'` and `experimental.adapterPath` produces:

```text
.next/
├── standalone/          # Self-contained Node.js server (copied to Docker image)
│   └── server.js        # Entry point — starts the Next.js HTTP server
├── static/              # Client-side JS/CSS/fonts → uploaded to GCS
└── cache/               # Build-time pre-rendered pages
```

The `next-adapter.ts` (`NextAdapter`) hooks into `modifyConfig` (enforce standalone) and
`onBuildComplete` (upload static assets to object storage keyed by `buildId`).

### 2. kn-next Package

The `@kn-next/config` package provides pluggable adapters:

| Adapter | Purpose | Implementation |
| --------- | --------- | ---------------- |
| **GCS Storage** | Static assets only (NOT ISR) | — |
| **Redis Cache** | ISR/data cache + tag invalidation | `cache-handler.js` |
| **Kafka Queue** | Revalidation queue | `kafka-queue.ts` |
| **Node Server** | HTTP server wrapper | `node-server.ts` |

### 3. Configuration System

```text
kn-next.config.ts           # User configuration
        ↓
    kn-next build
        ↓
```

**Example `kn-next.config.ts`:**

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

## Data Flow

### Request Flow

```mermaid
sequenceDiagram
    participant Browser
    participant Knative as Knative Service
    participant Redis as Redis (ISR/Data Cache)
    participant GCS as GCS (Static Assets)
    participant Next as Next.js Runtime

    Browser->>Knative: GET /page
    Knative->>Redis: Check ISR cache (cache-handler.js)

    alt Cache HIT
        Redis-->>Knative: Cached HTML + stale-while-revalidate
        Knative-->>Browser: 200 OK (cached)
        Note over Knative: Background revalidation if stale
    else Cache MISS
        Knative->>Next: Render page
        Next->>Redis: Store rendered page in ISR cache
        Next->>Redis: Store cache tags
        Knative-->>Browser: 200 OK (fresh)
    end
```

### Cache Invalidation Flow

```mermaid
sequenceDiagram
    participant Admin
    participant API as /api/cache/invalidate
    participant Redis as Redis (ISR/Data Cache)
    participant GCS as GCS (Static Assets Only)
    
    Admin->>API: POST /api/cache/invalidate {tag: "products"}
    API->>Redis: Get keys for tag "products"
    Redis-->>API: ["key1", "key2", "key3"]
    loop For each key
        API->>Redis: Delete ISR cache entry (cache-handler.js)
    end
    API->>Redis: Clear tag mapping
    API-->>Admin: 200 OK {invalidated: 3}
```

## Deployment Pipeline

The `deploy.sh` script automates the entire deployment:

```mermaid
flowchart LR
    A["1. pnpm build"] --> B["2. npx open-next"]
    B --> C["3. Read BUILD_ID"]
    C --> D["4. gsutil rsync to GCS"]
    D --> E["5. docker buildx"]
    E --> F["6. Update YAML"]
    F --> G["7. kubectl apply"]
    
    style C fill:#ff9800,color:#000
```

**BUILD_ID Synchronization:**

The BUILD_ID ensures server and client assets are always in sync:

- Docker image tagged: `file-manager:build-{BUILD_ID}`
- Static assets in GCS: `gs://bucket/{appName}/_next/static/{BUILD_ID}/`
  (assets are **app-namespaced** under `{appName}/` — #74 — so a shared bucket
  isolates zones and the operator's deletion finalizer can delete exactly this
  app's keys; served via `assetPrefix = {publicUrl}/{appName}`)
- Both reference the same BUILD_ID at runtime

## Caching Architecture

### Two-Tier Cache

```text
┌─────────────────────────────────────────────────────┐
│              Redis (ISR / Data Cache)               │
│  - ISR page cache (cache-handler.js)                │
│  - Fetch cache                                      │
│  - Tag → Keys mapping for invalidation              │
│  Keyed by: {prefix}/{key}                           │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              GCS (Static Assets only)               │
│  - _next/static/ (JS, CSS, fonts)                  │
│  - Uploaded at build time keyed by buildId          │
│  NOT used for ISR/data cache (that is Redis)        │
└─────────────────────────────────────────────────────┘
```

> **Correction from earlier docs:** GCS holds **static assets only**. The ISR/data cache
> (`cache-handler.js`) is backed by **Redis**. S3/Azure/MinIO are thin shell-outs;
> DynamoDB/Kafka are config/manifest-only and not yet implemented end-to-end.

### Cache Events (Observability)

The cache system emits real-time events via SSE:

```typescript
// Server-Sent Events at /api/cache/events
interface CacheEvent {
    type: 'HIT' | 'MISS' | 'SET' | 'DELETE' | 'REVALIDATE';
    layer: 'gcs' | 'redis';
    key: string;
    timestamp: number;
    durationMs?: number;
    details?: string;
}
```

## Environment Variables

The environment variables depend on your chosen storage and cache providers.

**Core (all deployments):**

| Variable | Description | Default |
| ---------- | ------------- | --------- |
| `NODE_ENV` | Runtime environment | `production` |
| `NEXT_BUILD_ID` | From `next build` | Auto |
| `DATABASE_URL` | PostgreSQL connection | Required |
| `NODE_COMPILE_CACHE` | V8 bytecode cache path | Optional |

**Cache (Redis):**

| Variable | Description | Default |
| ---------- | ------------- | --------- |
| `REDIS_URL` | Redis connection URL | Required |
| `REDIS_KEY_PREFIX` | Cache key namespace | App name |

**Storage (provider-specific):**

| Variable | Provider | Description |
| ---------- | ---------- | ------------- |
| `GCS_BUCKET_NAME` | GCS | Bucket name |
| `GOOGLE_APPLICATION_CREDENTIALS` | GCS | SA key path (or use ADC) |
| `S3_BUCKET_NAME` | S3 | Bucket name |
| `AWS_REGION` | S3 | AWS region |
| `AZURE_STORAGE_ACCOUNT` | Azure | Storage account |
| `MINIO_ENDPOINT` | MinIO | MinIO endpoint URL |
| `MINIO_ACCESS_KEY` | MinIO | Access key |
| `MINIO_SECRET_KEY` | MinIO | Secret key |

## API Endpoints

| Endpoint | Method | Description |
| ---------- | -------- | ------------- |
| `/api/health` | GET | Health check |
| `/api/audit` | GET | Paginated audit logs |
| `/api/cache-stats` | GET | Cache statistics |
| `/api/cache/events` | GET | SSE cache events stream |
| `/api/cache/invalidate` | POST | Invalidate by tag |

## Project Structure

```text
knative-next-monorepo/
├── apps/
│   └── file-manager/           # Example Next.js 16 application
│       ├── kn-next.config.ts   # App configuration
│       ├── deploy.sh           # Deployment automation
│       ├── knative-service.yaml
│       └── src/app/            # App Router pages
│
├── packages/
│   ├── kn-next/                # Core framework package
│   │   └── src/
│   │       ├── adapters/       # Cache & queue adapters
│   │       ├── config.ts       # Config type definitions
│   │       └── loader.ts       # Runtime loader
│   │
│   └── lib/                    # Shared utilities
│       └── src/clients.ts      # DB/storage clients
│
├── docs/
│   └── ARCHITECTURE.md         # This document
│
└── README.md
```

## Knative Configuration

**Key Settings:**

```yaml
autoscaling.knative.dev/minScale: "1"      # Always-on (avoid cold starts)
autoscaling.knative.dev/maxScale: "5"      # Max replicas
autoscaling.knative.dev/target: "100"      # Concurrent requests per pod
```

**Volume Mounts for GCS:**

```yaml
volumeMounts:
  - name: gcs-credentials
    mountPath: /secrets/gcs
    readOnly: true
volumes:
  - name: gcs-credentials
    secret:
      secretName: gcs-credentials
```

## Cold Start Optimization & Bun Bytecode Compilation

Knative scale-to-zero services incur a cold start cost each time a pod is created. The framework eliminates this bottleneck through **Bun bytecode compilation** — producing a single native binary that bypasses V8 JIT compilation entirely.

### Architecture: 3-Stage Docker Build

```mermaid
flowchart LR
    subgraph Stage1["Stage 1: Build"]
        A["node:22-alpine + pnpm"] --> B["next build<br/>output:standalone"]
    end

    subgraph Stage2["Stage 2: Compile"]
        B --> C["oven/bun:1.3.10-alpine"]
        C --> D["bun build --compile<br/>--bytecode --minify"]
    end

    subgraph Stage3["Stage 3: Run"]
        D --> E["alpine:latest<br/>Single Binary (~50MB)"]
    end

    style Stage1 fill:#3b82f6,color:#fff
    style Stage2 fill:#8b5cf6,color:#fff
    style Stage3 fill:#10b981,color:#fff
```

The compiled binary includes the Bun runtime and all application code pre-compiled to bytecode, eliminating:
- Node.js runtime installation (~150MB saved)
- `node_modules` directory
- V8 JIT compilation at startup

### Performance Benchmarks

> All benchmarks measured on Knative Serving with `minScale: 0` (full scale-to-zero). Pods terminate after 10 seconds of inactivity.

#### Cold Start (0 Pods → Provision → Boot → Response)

| Metric | Value |
|--------|-------|
| **Time to First Byte (TTFB)** | **0.66s** |
| **Total Response Time** | **0.92s** |
| **Pod Provisioning** | `Pending → ContainerCreating → Running` in ~1s |

#### Warm Start (Already Running Pod)

| Metric | Value |
|--------|-------|
| **Time to First Byte (TTFB)** | **0.58s** |
| **Total Response Time** | **0.80s** |

#### Load Test (100,000 Requests)

```bash
seq 1 100000 | xargs -n1 -P100 -I {} curl -s -o /dev/null -w "%{time_total}\n" \
  "http://file-manager.default.136.111.227.195.sslip.io/audit"
```

| Metric | Value |
|--------|-------|
| **Total Requests** | 100,000 |
| **Concurrency** | 100 parallel workers |
| **Average Response Time** | **0.521s** |
| **Requests/Second (RPS)** | **~192 req/s** |
| **Total Test Duration** | ~521s (~8.7 min) |

#### Throughput Analysis

| Metric | Value |
|--------|-------|
| **Sustained RPS** | ~192 req/s (100 workers ÷ 0.521s avg) |
| **Peak Autoscale** | 2 pods (`maxScale: 2`) |
| **Per-Pod RPS** | ~96 req/s |
| **Scale-to-Zero Recovery** | Pods terminate after 10s idle, resume in < 1s |
| **Zero Errors** | All 100,000 requests completed successfully |

#### Why Sub-Second Cold Starts?

Two factors combine to achieve this:

1. **Bun Bytecode Compilation** — `bun build --compile --bytecode` pre-compiles all JavaScript into native machine code. No V8 parsing or JIT compilation occurs at startup.
2. **Knative Resource Caching** — Knative pre-caches container images and maintains warm network paths, reducing image pull time to near-zero on subsequent cold starts.

### Optional: V8 Bytecode PVC Caching

For deployments using the standard Node.js runtime (without Bun compilation), the framework also supports Node.js 24's `NODE_COMPILE_CACHE` with shared volumes:

```typescript
const config: KnativeNextConfig = {
  name: 'my-app',
  bytecodeCache: {
    enabled: true,
    storageSize: '512Mi',
  },
};
```

This provisions a `ReadWriteMany` PVC so subsequent pods skip V8 JIT compilation.

**Requirements:** Node.js 24+ and ReadWriteMany PVC support (NFS, GCS Filestore, EFS).

## CLI Reference

The `kn-next` CLI provides commands for building and deploying Next.js applications to Knative.

### Deploy Command

```bash
npx kn-next deploy [options]
```

#### Options

| Option | Short | Description |
| -------- | ------- | ------------- |
| `--registry <url>` | `-r` | Override container registry |
| `--bucket <name>` | `-b` | Override storage bucket |
| `--tag <tag>` | `-t` | Image tag (default: timestamp) |
| `--namespace <ns>` | `-n` | Kubernetes namespace (default: default) |
| `--skip-build` | | Skip Next.js build step |
| `--skip-upload` | | Skip asset upload to storage |
| `--skip-infra` | | Skip infrastructure deployment |
| `--dry-run` | | Generate manifests without deploying |
| `--help` | `-h` | Show help |

#### Environment Variables (CI/CD)

These environment variables can override config file values, useful for CI/CD pipelines:

| Variable | Description |
| ---------- | ------------- |
| `KN_REGISTRY` | Container registry URL |
| `KN_BUCKET` | Storage bucket name |
| `KN_IMAGE_TAG` | Docker image tag |
| `KN_NAMESPACE` | Kubernetes namespace |
| `KN_REDIS_URL` | Redis connection URL (overrides config) |
| `KN_DATABASE_URL` | Database connection URL (overrides config) |

### CI/CD Integration

#### GitHub Actions

```yaml
name: Deploy to Knative

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: pnpm install
        
      - name: Configure GCP
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}
          
      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2
        
      - name: Configure kubectl
        run: |
          gcloud container clusters get-credentials ${{ vars.GKE_CLUSTER }} \
            --zone ${{ vars.GKE_ZONE }}
            
      - name: Deploy to Knative
        working-directory: apps/file-manager
        env:
          KN_REGISTRY: gcr.io/${{ secrets.GCP_PROJECT }}
          KN_IMAGE_TAG: ${{ github.sha }}
          KN_NAMESPACE: production
          KN_REDIS_URL: ${{ secrets.REDIS_URL }}
          KN_DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: npx kn-next deploy
```

#### GitLab CI

```yaml
stages:
  - build
  - deploy

variables:
  KN_REGISTRY: gcr.io/my-project

deploy_production:
  stage: deploy
  image: google/cloud-sdk:slim
  before_script:
    - gcloud auth activate-service-account --key-file=$GCP_KEY
    - gcloud container clusters get-credentials $GKE_CLUSTER --zone $GKE_ZONE
  script:
    - cd apps/file-manager
    - npx kn-next deploy --tag $CI_COMMIT_SHA --namespace production
  environment:
    name: production
  only:
    - main
```

#### Azure DevOps

```yaml
trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'
      
  - script: pnpm install
    displayName: 'Install dependencies'
    
  - task: AzureCLI@2
    displayName: 'Deploy to Knative'
    inputs:
      azureSubscription: 'my-subscription'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        az aks get-credentials --resource-group myRG --name myCluster
        cd apps/file-manager
        npx kn-next deploy --tag $(Build.SourceVersion) --namespace production
    env:
      KN_REGISTRY: myregistry.azurecr.io
      KN_DATABASE_URL: $(DATABASE_URL)
```

### Build Command

```bash
npx kn-next build
```

Runs the following steps:

1. Loads `kn-next.config.ts`
2. Runs `npm run build` (`next build` with `output:'standalone'`)
3. Uploads static assets to GCS/S3/MinIO
4. Generates `knative-service.yaml` in `.output/`

### Cleanup Command

```bash
npx kn-next cleanup [--namespace <ns>]
```

Removes deployed resources from the cluster:

- Knative Service
- Infrastructure services (if deployed)

## Development Workflow

1. **Local Development:**

   ```bash
   cd apps/file-manager
   pnpm dev
   ```

2. **Build for Production:**

   ```bash
   cd apps/file-manager
   npx kn-next deploy
   ```

3. **Deploy to Staging:**

   ```bash
   npx kn-next deploy --namespace staging --tag staging-$(date +%s)
   ```

4. **Preview Manifest (Dry Run):**

   ```bash
   npx kn-next deploy --dry-run
   cat .output/knative-service.yaml
   ```

5. **Manual Steps (if needed):**

   ```bash
   # Build Next.js with standalone output
   cd apps/file-manager
   pnpm build   # runs next build → .next/standalone/

   # Upload static assets to GCS (app-namespaced under <appName>/ — #74)
   gsutil -m rsync -r .next/static gs://bucket/<appName>/_next/static

   # Build & push image
   docker buildx build --platform linux/amd64 \
     -t registry/file-manager:tag -f Dockerfile . --push

   # Deploy
   kubectl apply -f .output/knative-service.yaml
   ```

## Future Roadmap

- [ ] CLI tool for initialization (`npx kn-next init`)
- [x] CI/CD parameter support
- [ ] Multi-zone support with shared cache
- [ ] Edge middleware on Cloudflare Workers
- [x] Automatic Dockerfile generation
- [x] GitHub Actions workflow examples
- [x] Bun bytecode compilation for sub-second cold starts
- [x] Kubernetes Operator (`NextApp` CRD)
