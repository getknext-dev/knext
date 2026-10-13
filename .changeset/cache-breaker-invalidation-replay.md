---
"@getknext/core": patch
---

Replay cache invalidations that could not reach Redis. While Redis is unreachable, `revalidateTag` and `revalidatePath` can only clear the pod's own memory, so other pods kept serving the old page, and the CDN kept it too, until its TTL. The pod now remembers those tags (up to 1,000, deduplicated) and, as soon as Redis answers again, invalidates them in Redis and then purges them from the CDN. It does this in the background, one tag at a time, and stops at the first error until the next retry. If more than 1,000 tags pile up, it invalidates every cached page of the app and purges the whole app from the CDN instead. The list lives in the pod's memory, so a pod that restarts or scales to zero before Redis is back still leaves those pages stale until their TTL. `'use cache'` entries are not replayed.
