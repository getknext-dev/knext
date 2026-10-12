---
"@getknext/core": minor
---

`'use cache'` is now shared across pods. Until now only the ISR cache was backed by Redis: on a knext app, Next's own `'use cache'` handler was off in production (the scaffold sets `cacheMaxMemorySize: 0`), so a Cache Components app got no caching and no error.

- **Wired for you.** When an app uses knext's `cacheHandler`, a `knext build` or `knext deploy` build now also points `cacheHandlers.default` and `cacheHandlers.remote` at a Redis-backed handler, for the Node and the Bun runtime. An entry written by one pod is a hit on the others and survives scale-to-zero. An entry of your own in `cacheHandlers` for a kind still wins.
- **Tags.** `revalidateTag` and `updateTag` on one pod invalidate the entry on every pod, and `revalidateTag(tag, profile)` keeps serving stale once while it refreshes.
- **Bounded.** Every entry gets a Redis expiry of at most 24 hours (set `KNEXT_USE_CACHE_MAX_TTL_SECONDS` to change the ceiling); `expire: 0` entries are never stored.
- **Redis down means no cache, not a per-pod copy.** Reads miss, writes are dropped, and one warning is logged per outage.
- **`knext doctor`** now reports PASS for an app that enables `cacheComponents` with knext's `cacheHandler`, and a warning for one with no `cacheHandler`.
- New internal entries `@getknext/core/internal/use-cache-handler-{node,bun}` and `…-remote-{node,bun}` (no stability guarantee; the adapter wires them).
- Document your Redis `maxmemory` and `maxmemory-policy volatile-lru`; see "ISR & the Redis cache" in the docs.
