---
"@getknext/core": minor
---

Connect the cache handler to CDN caching. With a CDN provider configured, `revalidateTag` and `revalidatePath` now purge the matching pages at the CDN once the cache entry has been invalidated, from the pod that handled the call and without delaying the response. The first pod of a new build purges the app's CDN entries once across the cluster, when Redis is available. The cache handler also records each cached page's tags for the response headers the CDN uses to key purges. Without a CDN provider configured, nothing changes: no purge is sent, no timer is started and no Redis key is written.
