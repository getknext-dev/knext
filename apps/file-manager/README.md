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
1. Builds Next.js with `bun run build`
2. Runs OpenNext: `npx open-next build`
3. Syncs static assets to GCS
4. Builds & pushes Docker image with BUILD_ID tag
5. Updates `knative-service.yaml`
6. Deploys to Knative

## Configuration

### knext.config.ts

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
        url: 'redis://redis.default.svc.cluster.local.:6379',
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
| `CACHE_INVALIDATE_TOKEN` | The app's admin token. Required for every change: uploads, adding a user, cache invalidation, and reading the audit log. Unset means all of those are refused. |

### Authentication

Every action that changes state, and the audit read, needs the admin token. That includes creating
the demo tables on `/setup`: opening the page does nothing until you submit its form with the token. Scripts send
`Authorization: Bearer $CACHE_INVALIDATE_TOKEN`. The pages ask for it in an **Access token** field
(a plain form cannot set headers, so the form sends it in a `token` field). Without the token the
upload, add-user and invalidate actions refuse and write nothing.

Uploads are stored under a generated id plus the file name (`<id>-<name>`), so uploading the same
name twice keeps both files.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Kubernetes health check |
| `/api/audit?page=N` | GET | Paginated audit logs (20/page); Bearer `CACHE_INVALIDATE_TOKEN` |
| `/api/cache-stats` | GET | Cache hit/miss statistics |
| `/api/cache/events` | GET | SSE stream of cache events |
| `/api/cache/invalidate` | POST | Invalidate cache by tag (Bearer `CACHE_INVALIDATE_TOKEN`) |
| `/api/files/stats` | GET | File count and total size, cached with `'use cache'` |

### Cache Invalidation

```bash
# Invalidate all audit-related cache
curl -X POST http://localhost:3000/api/cache/invalidate \
  -H "Authorization: Bearer $CACHE_INVALIDATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag": "audit"}'
```

### `'use cache'`

`/api/files/stats` reads its numbers through `getFileStats()`
(`src/app/api/files/stats/file-stats.ts`), a `'use cache'` function. The entry is
stored in the app's Redis, not in the process, so every pod serves the same
value, and a pod that wakes from scale-to-zero reads the entry instead of
querying Postgres again. `next.config.ts` turns the directive on with
`experimental.useCache` rather than Cache Components, so the cache-test pages
keep their route segment configs.

The entry is tagged `files`, which the upload action invalidates, so a new
upload refreshes the stats. To refresh them on their own, invalidate
`file-stats`:

```bash
curl -X POST http://localhost:3000/api/cache/invalidate \
  -H "Authorization: Bearer $CACHE_INVALIDATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag": "file-stats"}'
```

### Cache Tags

| Tag | Used By |
|-----|---------|
| `audit` | Audit logs API |
| `audit-logs` | Audit logs API (alias) |
| `dashboard` | Dashboard page |
| `files` | File list on `/` and the `'use cache'` file stats |
| `file-stats` | The `'use cache'` file stats only |

## Pages

| Route | Description |
|-------|-------------|
| `/` | File listing with upload |
| `/dashboard` | Statistics overview |
| `/users` | User management |
| `/audit` | Audit logs with infinite scroll |
| `/cache` | Cache monitor (SSE) |
| `/setup` | Database setup. A GET only shows a form; the **Initialize database** button is a POST that needs the admin token |

## Development

```bash
# Install dependencies
bun install

# Run development server
bun run dev

# Build for production
bun run build
```

### `e2e` — the end-to-end round

```bash
bun run --filter file-manager e2e
```

`e2e` is the named end-to-end round for this reference app: one command that
chains the app-level legs which otherwise have to be transcribed out of CI by
hand. It is a **name and an entry point** over checks that already run — not a
separate test suite. The legs, in order, each **fail-closed** (the round exits
non-zero on the first failure and **never silently skips** — a missing
precondition is an error that names the fix):

1. **build** — `lib → db → core → file-manager` (`--no-build` reuses artifacts).
2. **compile** — the single executable (`build:exec`); needs `bun` on `PATH`.
3. **serve + routes + ISR** — `scripts/compat-smoke.mjs` boots the built server
   and asserts over real HTTP (App Router, RSC, route handlers, `next/image`,
   Server Actions, streaming, and ISR revalidation against a **real Redis**).
   Requires `REDIS_URL` — it is never defaulted to empty, which would make the
   ISR check meaningless. Pass `--allow-docker` to have the round start a
   `redis:7-alpine` itself.
4. **ISR invalidate over HTTP** — `scripts/invalidation-probe.mjs` proves the
   authenticated on-demand loop end to end: an **unauthenticated** invalidation
   is rejected `401`, an **authenticated** one returns `200` and busts the tag.
   Requires `CACHE_INVALIDATE_TOKEN`.
5. **prod image** — builds the production `Dockerfile`, runs the container, and
   probes `next/image` transcoding. Requires a Docker daemon; `--no-docker`
   opts out (printed as **NOT RUN**, never as a pass).

Flags: `--only <leg>` (iterate on one leg), `--no-build`, `--no-docker`,
`--allow-docker`. A full local round needs Docker and a Redis; on Apple Silicon
the image leg needs the Rosetta/registry setup used elsewhere for local kind
serving.

**What this round does NOT prove:** graceful-shutdown drain for this app. Since
the app emits no standalone tree, its drain and clean-image proofs run as their
own containerised CI jobs rather than as legs here.

### `build:exec` — the knext build + asset upload

```bash
bun run build:exec   # knext build
```

`knext build` (vinext is the only target since ADR-0048, so there is no
`--target` flag) runs the project build, compiles the single executable, and
then **uploads the static assets to the configured `storage` bucket**. Because
this app sets `storage: { provider: 'gcs' }`, `build:exec` performs a **real GCS
upload** and needs GCS credentials on the machine that runs it
(`GOOGLE_APPLICATION_CREDENTIALS`, plus `gsutil`/`gcloud` on `PATH`). Without
them the upload step fails, so `build:exec` is not a fully offline/local command
today. To iterate on the build alone without an upload you currently need an app
whose config carries no `storage` block (knext then skips the upload and serves
assets from the image). A `knext build` upload-skip affordance is tracked
separately — do not add a CLI flag here to work around it.

### The nightly platform e2e

A separate nightly workflow (`.github/workflows/file-manager-platform-e2e-nightly.yml`, also
runnable with `workflow_dispatch`) deploys this app **through the product** on an ephemeral kind
cluster: `knext deploy` applies the `NextApp` CR and the operator (built from the same commit)
reconciles the Knative Service. It never touches a real cluster. It then checks, over real HTTP
through the ingress:

- **App flows** - upload (the client server action, driven at the HTTP level), the file listed on
  `/` and `/dashboard`, the object read back from storage byte for byte, users, audit, 404.
  The app has no rename, delete or download route today, and the browser-driven upload form is not
  covered (it needs a browser runtime).
- **Platform** - scale-to-zero then a timed wake, ISR served from Redis plus authenticated cache
  invalidation (401 without a token), image optimization, health, metrics, the operator's
  NetworkPolicy, and a graceful rollout under load.
- **Deployment basics** - content type and cache headers for every asset the page references
  and for `public/` files, and RSC streaming (fallback arrives before the resolved content).

Every check fails closed: a missing prerequisite throws, there is no skip. The kind profile lives in
`platform-e2e/knext.config.e2e.ts` (a guard test fails if it drifts from `knext.config.ts`
beyond storage/registry/cache/database). `scripts/platform-e2e.selftest.mjs` runs the same checks
against deliberately broken servers and needs no cluster, so you can run it locally:
`node scripts/platform-e2e.selftest.mjs`. The job budget is 45 minutes (about 10 measured).
A red scheduled run files one pinned issue.

Fonts are verified like any other asset: the `next/font/google` (Geist) URL referenced by the
home page and its CSS must be a real, served, content-hashed `/_next/static/...` URL that 200s
with a `font/*` content type. (Previously the build leaked the build machine's absolute
filesystem path into that URL, so it was quarantined rather than skipped - see #1284, fixed.)

## Deployment Files

| File | Purpose |
|------|---------|
| `deploy.sh` | Automated deployment script |
| `knative-service.yaml` | Knative service manifest |
| `Dockerfile.opennext` | Production Docker image |
| `open-next.config.ts` | Auto-generated OpenNext config |
| `knext.config.ts` | User configuration |
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

### Overview / RED page (`/observability`)

Server-rendered "Observability overview" showing the golden **RED** signals for the app over the
last hour: request rate (req/s), 5xx error rate (%), p75 + p99 latency, and current in-flight
concurrency — computed from the core `knext_http_*` metrics. Unlike the Web Vitals page, these are
range/rate aggregates only Prometheus can compute, so the page queries an in-cluster Prometheus
**server-side** (never from the browser) via `OBSERVABILITY_PROMETHEUS_URL`.

It **degrades closed, never crashing or hanging**:
- `OBSERVABILITY_PROMETHEUS_URL` **unset** ⇒ a clear "not configured" empty state (naming the
  variable); no network call is made.
- Prometheus **unreachable / slow** ⇒ an error state (the fetch is uncached and bounded by a short
  timeout); the page still returns 200.
- Otherwise ⇒ the live numbers.

A link-out row points to the shipped turnkey **Grafana dashboards** for deep, cluster-wide analysis
(no embedded iframe — the app renders its own aggregates).

### Cold start & scaling page (`/observability/scaling`)

The scale-to-zero lifecycle view — the page an always-on platform cannot show you. Over the last
hour it renders:

- **Replica count 0→N** and the current replica count. This series
  (`kube_deployment_status_replicas`) is **provided by the cluster via kube-state-metrics**, not by
  knext. If it is not installed the panel says **"requires kube-state-metrics"** — it never draws a
  misleading "0 replicas".
- **Cold starts** — rate per second plus p50 / p99 cold-start duration (`knext_coldstart_*`).
- **Database wake, by pool role** (writer / reader) — rate per second plus p50 / p99 wake duration
  (`knext_db_wake_*`), i.e. how long the first connect to a sleeping database takes.
- A **Currently** row (replicas now, in-flight requests).

It uses the same Prometheus backend and the same degrade-closed behaviour as the Overview page, and
runs the **same PromQL as the shipped "Scale-to-zero lifecycle" Grafana dashboard**, so the page and
the dashboard can never disagree. A link row points at that dashboard for longer ranges and
per-deployment breakdowns.

On both this page and the Overview page, a value that has produced **no sample** renders as
**`no data yet`** — deliberately distinct from a measured `0`, so "nothing recorded" is never
mistaken for "zero".

### Web Vitals page (`/observability/web-vitals`)

Server-rendered "Speed Insights" page showing the current **p75** for each Core Web Vital
(LCP, INP, CLS, FCP, TTFB) plus sample counts, read in-process from the app's own RUM registry
(the `/api/rum` beacons collected by `WebVitalsReporter`). It needs **no** external backend — no
Prometheus, no extra dependency.

The observability pages are **auth-gated with a timing-safe Bearer token** and are **never cached**
(`force-dynamic`). Provision `OBSERVABILITY_TOKEN` via a Kubernetes Secret (never hardcoded), then
request the page with `Authorization: Bearer <token>`. **If `OBSERVABILITY_TOKEN` is unset the pages
deny every request** — they fail closed rather than exposing metrics. Metric data is only read
server-side; the browser receives the rendered aggregate, never raw metrics.

**A denied request gets a real HTTP `401`** (not a `200` whose body says "unauthorized"), so a
monitor or probe can read the status rather than the page text. Two caveats worth knowing before you
alert on it: the response carries **no `WWW-Authenticate` challenge** (Next's `unauthorized()`
cannot set a response header), and the `401` applies to **document requests** — the same route
fetched as an RSC navigation returns `200` with the denial as its payload. Neither leaks data.

| Variable | Description |
|----------|-------------|
| `OBSERVABILITY_TOKEN` | Bearer token gating `/observability/*` (unset ⇒ deny-all) |
| `OBSERVABILITY_PROMETHEUS_URL` | In-cluster Prometheus base URL for the Overview/RED and Cold-start & scaling pages (unset ⇒ graceful "not configured" empty state; server-side only, never sent to the browser) |

### Events API (`/api/cache/events`)

Server-Sent Events stream:

```javascript
const es = new EventSource('/api/cache/events');
es.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // { type: 'HIT', layer: 'gcs', key: '...', durationMs: 12 }
};
```
