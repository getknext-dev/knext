# ADR-0050: ISR-to-Redis wiring on the vinext target goes through the `vinext()` plugin's `cache.data` adapter

- Status: Accepted
- Date: 2026-09-05
- Issue: #953 (sprint-2 exit criterion 2; S3-V verification row E)

## Context

The S3-V cluster verification observed, on BOTH kind and OKE, that a freshly
scaffolded vinext app with `export const revalidate = 30` served every request
as `x-nextjs-cache: MISS` with `cache-control: no-store, must-revalidate`, and
Redis `DBSIZE` stayed 0 — with `CACHE_PROVIDER=redis` and a reachable
`REDIS_URL` injected (evidence: `docs/verification/sprint2-aggregate-2026-09-05.md`,
row E, branch `agent/s3-verification`).

Root cause: the scaffold wired knext's Redis cache handler through
`next.config.ts`'s `cacheHandler`. That option is a webpack/turbopack
mechanism; vinext (Vite/rolldown) never reads it — nothing in
vinext@1.0.0-beta.8's dist references it. Unregistered, vinext falls back to a
per-pod `MemoryCacheHandler`, and the page-cache policy the runtime computed
never left anything servable, so the provisioned Redis was simply never
dialled. The #906 unit prover runs with `REDIS_URL` deleted, so it proved the
handler while being structurally unable to see that the handler was never
invoked.

**Why the gap was invisible from CI** (corrected in review — the first draft of
this ADR claimed "nothing registered a data cache handler", which was true of
the scaffold but false of the app CI actually smokes): `apps/file-manager`
carried `src/cache-init.ts`, a POC-era probe that called
`nextCache.setCacheHandler(new CacheHandler())` if the function existed. Under
Next it never existed, so the file was believed to be a no-op — but under
vinext, `next/cache` resolves to vinext's shim, where `setCacheHandler` is a
real alias of `setDataCacheHandler`. So file-manager HAD a working (imperative,
accidental) registration, compat-smoke's ISR check stayed green on it, and
only fresh scaffolds — which have no cache-init — showed the row-E red. That
imperative call is retired in the same change (single registration mechanism),
and the smoke's ISR evidence was hardened so a bystander writer can no longer
satisfy it (see Consequences).

## Decision

Register knext's existing Redis cache handler through **vinext's own
declarative cache hook**: the `cache` option of the `vinext()` vite plugin.

```ts
vinext({
  cache: {
    data: { adapter: '@getknext/core/internal/vinext-cache-adapter' },
  },
}),
```

Measured against vinext@1.0.0-beta.8's dist (the scaffold's exact pin), the
chain is: the plugin generates `virtual:vinext-cache-adapters` from that
option (`dist/index.js` → `generateCacheAdaptersModule(options.cache)`); every
server entry imports it and calls `registerConfiguredCacheAdapters(env)` per
request (`dist/server/app-router-entry.js:23`), which runs
`setDataCacheHandler(factory({ env, options }))` once per isolate.

Two consequences of that shape:

- **A factory subpath, not the class.** The generated module CALLS the
  descriptor's default export; handing it the class `./adapters/cache-handler`
  exports for Next would throw "cannot be invoked without `new`" — which
  vinext catches, warns once about, and silently replaces with the memory
  handler, i.e. row E again. So `@getknext/core/internal/vinext-cache-adapter`
  (`src/adapters/vinext-cache-adapter.mjs`) is a ~1-line factory over the
  same `CacheHandler` class. One handler, two entrances — not a second
  runtime.
- **No `cache.cdn` adapter is registered.** vinext's `DefaultCdnCacheAdapter`
  is the origin-managed ISR strategy: it stores page artifacts through the
  registered data cache, serves HIT/STALE from it, and runs in-process
  background regeneration — exactly the Knative origin topology. An edge
  adapter is a CDN-era decision (Tier C), not this one.

The interface fit needed no adaptation: vinext's `CacheHandler` contract
(`get` → `{ lastModified, value, cacheState? }`, `set(key, data, ctx)` with
`ctx.cacheControl/tags`, `revalidateTag`) is the shape knext's handler already
speaks — `cacheState` labelling landed with #886/#940, and the Redis TTL rule
(entry outlives its revalidate window; TTL is `expire` when the render claims
one) is what makes STALE reachable at all.

## Options considered

| Option | Verdict |
| --- | --- |
| **A. `vinext({ cache: { data } })` plugin option (chosen)** | Upstream's own supported hook, registered in every server entry by generated code; survives vinext refactors of entry layout; zero knext-side interception. |
| B. Imperative `setDataCacheHandler(...)` (from `knext-bun-entry.mjs` or app code) | **It works** — file-manager's accidental `cache-init.ts` registration proves it (that is what kept check (k) green). Rejected anyway, with that evidence in hand: the setter is deprecated upstream in favour of A; a registration buried in one app file is invisible to review (this exact mechanism masked the scaffold gap for a full verification cycle); and two mechanisms coexisting means two handler instances with an order-dependent winner. From the nitro entry specifically there is the additional ordering hazard against the render services' own per-request registration guard. |
| C. Intercept ISR routes in the nitro entry (like the image optimizer) | Reimplements vinext's ISR decision logic (freshness, background regen, header policy) — hand-rolling a runtime, which ADR-0036 forbids. The image intercept exists only because vinext's optimizer branch is dead on non-Cloudflare platforms; the cache hook is alive. |
| D. Upstream contribution to make vinext read `next.config` `cacheHandler` | Wrong direction: vinext deliberately moved cache config to the vite plugin; Next's own option stays webpack-scoped. Nothing to fix upstream. |

## Consequences

- Every `vinext()` call site now carries the wiring: both scaffold template
  trees, `apps/docs`, `apps/file-manager`. A scanning guard
  (`vinext-isr-redis-wiring.test.ts` layer 1) reds any future `vinext()` vite
  config that omits it, with a written-exemption map
  (`examples/bun-exec` — pinned to beta.4, which predates the option).
- `next.config.ts`'s `cacheHandler` line stays in the templates, honestly
  re-commented: it is inert on this target and kept for Next-aware tooling,
  pointing at the same handler so the two cannot drift.
- The registration + ISR round-trip is proven through vinext's REAL beta.8
  code against a live RESP2 socket (`vinext-isr-redis-wiring.test.ts` layer
  3): registered handler replaces `MemoryCacheHandler`, the ISR SET carries an
  `EX` pinned to the no-expire floor (3600 s — never the revalidate window),
  HIT while fresh, STALE past it.
- **compat-smoke check (k) was decorative for THIS wiring and is hardened in
  the same change.** Its `DBSIZE > 0` evidence was satisfiable by any writer —
  measured: the check's output was byte-identical green before and after the
  plugin wiring, because file-manager's imperative cache-init registration was
  doing the writing. It now additionally asserts the ISR route's **own key by
  name** (`*:cache:*knext-smoke/isr*`), a **TTL longer than the revalidate
  window** on every matched key, and the **absence** of vinext's
  cache-adapter registration-failure warn in the server log. Mutation-proved:
  removing `cache.data` from file-manager's vite config and rebuilding reds
  the check.
- **`apps/file-manager/src/cache-init.ts` is deleted** and a scanning guard
  (`vinext-isr-redis-wiring.test.ts`) reds any imperative
  `setCacheHandler`/`setDataCacheHandler` call outside vinext's generated
  module — one registration mechanism, enforced.
- **Public-surface consequence:** `@getknext/core/internal/vinext-cache-adapter`
  is `/internal/` (no semver guarantee) but is referenced by NAME from
  generated user projects, which gives it the real obligation documented in
  `docs/PUBLIC_API.md` §"Generated-file-referenced internal subpaths": no
  rename/removal without a minor bump, a changelog entry, and a
  scaffold/codemod migration path. Same class as `internal/vinext-image-optimizer`
  and `internal/node-server`.
- `vinext` becomes a devDependency of `@getknext/core` (test-only; the
  published package does not depend on it).

## Action items

- [x] Factory subpath `@getknext/core/internal/vinext-cache-adapter` (tsup
      entry + export map).
- [x] Wire `cache.data` in both template trees + `apps/docs` +
      `apps/file-manager`.
- [x] Scan-guard + real-vinext integration prover
      (`packages/kn-next/src/__tests__/vinext-isr-redis-wiring.test.ts`).
- [x] Retire the "item 4 deferred" note in all pinned `runtime-contract.mjs`
      copies; re-comment the inert `cacheHandler` in both `next.config` templates.
      (`examples/bun-exec`'s copy states the honest NOT-wired status instead — a
      recorded, hash-pinned divergence with an expiry tied to its beta.4 pin.)
- [x] Harden compat-smoke check (k): ISR key by name + TTL > revalidate +
      registration-warn absence; delete `cache-init.ts`; scan-guard imperative
      registration.
- [ ] Cluster re-verification of row E (kind + OKE) by the S3-V runner —
      HIT/STALE observed live, Redis key + TTL inspected (#953 acceptance).
- [ ] **Consolidate the scaffolded vite config behind a `knextVinext()`
      wrapper** exported by `@getknext/core`, so the cache adapter, the nitro
      entry, and future plugin options are one framework-owned call instead of
      N copied config blocks a user can partially delete. Would also collapse
      the per-config scanning guard into a single-symbol check. Not done here:
      it changes the scaffold's public shape and belongs behind its own design
      pass.
