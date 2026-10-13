---
"@getknext/core": patch
---

Harden the Redis-backed `'use cache'` handler.

- **Entry size limit.** An entry larger than 2 MiB is no longer stored; the function runs again on the next request and one warning is logged. Set `KNEXT_USE_CACHE_MAX_ENTRY_BYTES` (bytes, `0` = no limit) to change it. One very large write can no longer time out and take the ISR cache, which shares the Redis connection, offline with it.
- **Clock skew between pods.** Invalidation times now come from the Redis server's clock (read once a minute per pod, not per request), so an entry can no longer survive a `revalidateTag` because the pod that wrote it had a clock running ahead.
- **Concurrent invalidation during cleanup.** Old tag timestamps are removed with a compare-and-delete, so a `revalidateTag` that lands while a cleanup is running is no longer lost.
- **Logging.** The "Redis unavailable" warning is logged once per pod rather than once per cache kind, and a failed cleanup after a successful `revalidateTag` is reported as a cleanup failure, not as a tag-update error, and no longer interrupts the ISR cache.
