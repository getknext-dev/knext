---
name: knext-app
description: >-
  Turn a Next.js app into a deployable knext zone by wiring the @knext/core public
  surface: the KnativeNextConfig type for kn-next.config.ts, the official Next.js
  deployment adapter (@knext/core/adapter via the top-level adapterPath config), the ISR
  Redis cache handler (@knext/core/adapters/cache-handler via next.config
  cacheHandler), and OpenTelemetry wiring (resolveOtelOptions in
  instrumentation.ts). Use this skill whenever configuring a Next.js app for
  knext, writing or editing kn-next.config.ts or next.config.ts for knext, setting
  up the cache handler / instrumentation / assetPrefix / output:standalone, or
  scaffolding a new zone — even if "@knext/core" isn't named explicitly.
---

# Making a Next.js app a knext zone

A knext **zone** is a standard Next.js (App Router) app wired to `@knext/core` so
the build produces a knext-deployable, scale-to-zero output. There are four
touch-points; all use the **public** `@knext/core` surface (`docs/PUBLIC_API.md`).

## 1. `kn-next.config.ts` — the deploy config (`KnativeNextConfig`)

This file (at the app root) tells the `kn-next` CLI how to build/deploy the zone.
Use the typed config so invalid fields fail at author time:

```ts
// kn-next.config.ts
import type { KnativeNextConfig } from '@knext/core';

const config: KnativeNextConfig = {
  name: 'storefront',                       // DNS-1123 label; the zone slug
  registry: 'us-central1-docker.pkg.dev/PROJECT/repo',
  storage: {                                // static assets + image cache
    provider: 's3',                         // 'gcs' | 's3' | 'minio' | 'azure'
    bucket: 'storefront-assets',
    region: 'us-east-1',
    publicUrl: 'https://cdn.example.com/storefront-assets',
  },
  cache: { provider: 'redis', url: process.env.REDIS_URL!, keyPrefix: 'storefront' },
  scaling: { minScale: 0, maxScale: 6, memoryRequest: '256Mi', memoryLimit: '512Mi' },
  runtime: 'node',                          // 'node' (default) | 'bun'
};

export default config;
```

- Storage providers accepted by the validator are **`gcs` | `s3` | `minio` | `azure`**.
  Each shells out to that cloud's CLI (`gsutil` / `aws` / `mc` / `az`).
- The CLI turns this config into a `NextApp` Custom Resource at deploy time — see
  the `knext-deploy` skill.

## 2. `next.config.ts` — the adapter + the cache handler

```ts
// next.config.ts
import path from 'node:path';

export default {
  output: 'standalone',                                  // knext runs the standalone server
  adapterPath: '@knext/core/adapter',                    // the official knext adapter (top-level at Next.js 16.2+)
  cacheHandler: path.resolve(import.meta.dirname, 'cache-handler.js'),
  assetPrefix: process.env.ASSET_PREFIX || '',           // injected at deploy (object-store CDN)
};
```

- `@knext/core/adapter` is the official Next.js **deployment adapter**, wired via
  the top-level `adapterPath` config. On Next.js 16.0.x–16.1.x the option lives
  under `experimental` instead (`experimental: { adapterPath: ... }`); 16.2+
  auto-migrates that old key but 16.0.x does NOT accept the top-level form.
  Do not hand-roll a runtime.
- Next.js requires `cacheHandler` to be a **file path**, so ship a thin local
  re-export (next item).

## 3. `cache-handler.js` — the ISR / Redis cache (thin re-export)

```js
// cache-handler.js (at the app root)
export { default } from '@knext/core/adapters/cache-handler';
```

This keeps the cache logic in the framework (bug fixes apply everywhere) while
satisfying Next's file-path requirement. The Redis connection comes from
`cache.url` in your `kn-next.config.ts`.

## 4. `instrumentation.ts` — optional OpenTelemetry

```ts
// instrumentation.ts
import { resolveOtelOptions } from '@knext/core/adapters/otel-config';

export async function register() {
  const otel = resolveOtelOptions(); // OtelOptions | null
  if (!otel) return;                 // tracing is OFF unless an endpoint is configured
  // ...initialize your tracer with `otel`...
}
```

Unconfigured apps pay nothing — tracing only activates when an OTLP endpoint is
set (the operator plumbs this from `spec.observability`).

## 5. The health route

Add `app/api/health/route.ts` using `checkDeepHealth()` from `@knext/lib/health`
(see the `knext-lib` skill) so readiness probes reflect real dependency health.

## Rules
- Only import the **public** `@knext/core` paths above (`.`, `/adapter`,
  `/adapters/otel-config`, `/adapters/cache-handler`). Anything under
  `@knext/core/internal/*` is framework wiring with no stability guarantee.
- `output: 'standalone'` is required — knext spawns the standalone server.
- Keep server-only helpers (`@knext/lib/*`) out of client components.

## Related skills
- `knext-lib` — the runtime helpers app code calls (DB, storage, health, logger).
- `knext-deploy` — `kn-next` CLI + the `NextApp` CR the config compiles into.
- `nextjs-deployment-adapter` — the adapter API internals (framework-dev depth).
- `scs-zones` / `pwa-zones` — composing multiple zones into one SCS app.
