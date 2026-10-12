---
"@getknext/core": minor
---

Add the purge module for CDN caching. When a tag is revalidated, the pod that handled it queues a purge of that tag at the CDN, in batches of up to 100 tags with at most three attempts per batch (a `Retry-After` is honoured up to 60 seconds). Cloudflare is the supported provider; the purge credential is read only from the mounted Secret and is never logged. The purge never blocks the response and is waited for on shutdown. A pod that becomes ready also purges the app's tag once per build across the cluster, when Redis is available.

Pages can still be stale at the CDN for up to the edge TTL if a purge fails or is rate-limited. The module is inert until a CDN provider is configured, and it is not yet connected to cache revalidation, so nothing changes for existing apps.
