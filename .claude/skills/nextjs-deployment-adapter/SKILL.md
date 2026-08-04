---
name: nextjs-deployment-adapter
description: Build deployment adapters on the official Next.js Adapter API (Next 16.2+) — NextAdapter, modifyConfig, onBuildComplete, adapterPath/NEXT_ADAPTER_PATH, output:'standalone', cache interfaces, @next/routing, and the official compatibility suite. Use when implementing/validating knext's runtime, wiring the adapter, invoking build-output entrypoints, or replacing the deprecated Vinext/Nitro path. Do NOT reverse-engineer Nitro/Vinext.
---

# Next.js Official Deployment Adapter API

knext's north star is a **real, verified** Next.js adapter on the official API — open source +
passes the official compatibility suite + listed in the Next.js docs. **Do not** reverse-engineer
Nitro/Vinext (deprecated epic #11 path).

## The `NextAdapter` interface
Registered via the top-level `adapterPath` in `next.config.ts` (Next.js 16.2+; under
`experimental` on 16.0.x-16.1.x), or `NEXT_ADAPTER_PATH` env
(zero-config for platforms). knext's lives at `apps/file-manager/next-adapter.ts`.
```ts
import type { NextAdapter } from 'next';
const adapter: NextAdapter = {
  name: 'knext',
  async modifyConfig(config, { phase /*, nextVersion */ }) {
    // Gate BUILD-ARTIFACT instructions on the build phase…
    const build = phase === 'phase-production-build';
    return {
      ...config,
      ...(build ? { output: 'standalone',
                    cacheHandler: require.resolve('./cache-handler') } : {}),
      // …but a COMPILE-CORRECTNESS fence must apply wherever the bundler runs,
      // dev included — see the phase guidance below.
      webpack: composeFence(config.webpack),
    };
  },
  async onBuildComplete(ctx) { /* see below */ },
};
export default adapter;
```

### `modifyConfig(config, context)`
Called for **any** command that loads `next.config` (build, dev, start). Good home for forcing
`output:'standalone'`, injecting the `cacheHandler`, asset prefix, basePath.

**Phase-gate by what the mutation IS, not reflexively.** A blanket
`if (phase !== 'phase-production-build') return config` is wrong for anything that must hold
wherever the bundler runs:

- **Build-artifact instructions** (`output:'standalone'`, `generateBuildId`) — gate on
  `phase-production-build`; they are meaningless outside a build.
- **Compile-correctness fences** (e.g. knext's edge-scoped `IgnorePlugin` excluding
  `instrumentation-node` from the edge bundle) — apply in EVERY phase. Measured on next 16.2.11:
  `next dev --webpack` fails the edge compile without the fence
  (`UnhandledSchemeError: Reading from "node:fs"`), exactly as the production build did; plain
  `next dev` (Turbopack) is unaffected only because Turbopack never reads `config.webpack`.
  Production-only gating there is a silent dev/prod parity gap (knext #408, ADR-0031 amendment).

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
