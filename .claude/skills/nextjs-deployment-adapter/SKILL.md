---
name: nextjs-deployment-adapter
description: Build deployment adapters on the official Next.js Adapter API (Next 16.2+) — NextAdapter, modifyConfig, onBuildComplete, adapterPath/NEXT_ADAPTER_PATH, output:'standalone', cache interfaces, @next/routing, and the official compatibility suite. Use when implementing/validating knext's runtime, wiring the adapter, invoking build-output entrypoints, or replacing the deprecated Vinext/Nitro path. Do NOT reverse-engineer Nitro/Vinext.
---

# Next.js Official Deployment Adapter API

knext's north star is a **real, verified** Next.js adapter on the official API — open source +
passes the official compatibility suite + listed in the Next.js docs. **Do not** reverse-engineer
Nitro/Vinext (deprecated epic #11 path).

## The `NextAdapter` interface
Registered via `experimental.adapterPath` in `next.config.ts`, or `NEXT_ADAPTER_PATH` env
(zero-config for platforms). knext's lives at `apps/file-manager/next-adapter.ts`.
```ts
import type { NextAdapter } from 'next';
const adapter: NextAdapter = {
  name: 'knext',
  async modifyConfig(config, { phase /*, nextVersion */ }) {
    if (phase !== 'phase-production-build') return config; // guard — runs for every CLI cmd
    return { ...config, output: 'standalone',
             cacheHandler: require.resolve('./cache-handler') };
  },
  async onBuildComplete(ctx) { /* see below */ },
};
export default adapter;
```

### `modifyConfig(config, context)`
Called for **any** command that loads `next.config` (build, dev, start). Always guard
target-specific mutations with `context.phase === 'phase-production-build'`. Good home for forcing
`output:'standalone'`, injecting the `cacheHandler`, asset prefix, basePath.

### `onBuildComplete(context)` — fires **once** after `next build`
`context` fields:
- `buildId`, `distDir`, `projectDir`, `repoRoot`, `config`, `nextVersion`
- **`outputs`** — classified build outputs: `appPages`, `appRoutes`, `pages`, `pagesApi`,
  `prerenders`, `staticFiles`, `middleware`. Each entry has `filePath`, **`assets`** (Next's own
  per-route dependency trace → use this instead of `@vercel/nft`), `runtime` (`nodejs`|`edge`),
  and `edgeRuntime` `{modulePath, entryKey, handlerExport}` for edge routes.
- **`routing`** — `beforeMiddleware`, `beforeFiles`, `afterFiles`, `dynamicRoutes`, `onMatch`,
  `fallback`, `shouldNormalizeNextData`, `rsc`. (⚠️ on **next@16.0.3** this is `ctx.routes`, not
  `ctx.routing` — verify against the installed `next` types before using.)
Use it to: upload `staticFiles` + `prerenders` to object storage keyed by `buildId`; build a
deploy manifest; (optionally) assemble an embed set from `outputs[*].assets`.

## Two server models
- **`output:'standalone'` (knext default):** Next builds `server.js`; you just run it. Least code.
- **Adapter-native (no standalone):** you own the HTTP server — match routes with
  **`@next/routing`** `resolveRoutes()` (experimental — pin it), then invoke the matched
  entrypoint's `handler(req, res, ctx)`. Never read/transform the response body (breaks
  streaming/RSC).

## Invoking entrypoints
- **Node** (`runtime:'nodejs'`): `handler(req: IncomingMessage, res: ServerResponse, ctx)`, with
  `ctx.waitUntil` and `ctx.requestMeta` (`relativeProjectDir`, `hostname`, `revalidate`,
  `render404`). `revalidate` is where ISR/Kafka revalidation hooks in.
- **Edge** (`runtime:'edge'`): `handler(request: Request, ctx): Promise<Response>` via
  `output.edgeRuntime`.

## Cache interfaces (runtime, not the adapter)
Set in `modifyConfig`: `cacheHandler` (ISR/data store — knext uses Redis, `cache-handler.js`),
`cacheHandlers` (for `use cache`), `cacheMaxMemorySize: 0` to force the external store. ISR
revalidation across pods = Redis + Kafka dual-routing.

## Verification — the gate
**Every parity claim must pass the official Next.js compatibility test suite** in CI. Until then
parity is "claimed," not "verified." Maintain a supported/unsupported feature matrix.

## Caveats / version pins
- Adapter API stabilized in **Next 16.2+** (docs updated 2026-05-19). `@next/routing` is
  experimental.
- `setCacheHandler` is absent from `next/cache` in 16.0.3 — guard with `typeof`.
- `output:'export'` → only `staticFiles` populated (static site; no server routes).
