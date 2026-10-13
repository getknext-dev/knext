---
"@getknext/core": minor
---

Connect the cache handler to CDN caching. With a CDN provider configured, `revalidateTag` and `revalidatePath` now purge the matching pages at the CDN once the cache entry has been invalidated, from the pod that handled the call and without delaying the response. If Redis is configured but unreachable, the invalidation only clears that pod's memory, so no CDN purge is sent and a warning is logged instead; the pages then stay stale at the CDN for up to the edge TTL. The first pod of a new build purges the app's CDN entries once across the cluster, when Redis is available, and retries on a later request if Redis was briefly unreachable. The cache handler also records each cached page's tags for the response headers the CDN uses to key purges. Without a CDN provider configured, nothing changes: no purge is sent, no timer is started and no Redis key is written.
