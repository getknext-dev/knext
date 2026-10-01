---
"@getknext/core": patch
---

Fix on-demand invalidation of statically and ISR-cached pages with the Redis cache handler. `revalidateTag` and `revalidatePath` returned success but never evicted full-route-cached pages, because Next.js stores those pages' tags (including the implicit path tags `revalidatePath` uses) in the `x-next-cache-tags` header instead of the cache-write context. The handler now indexes both, so invalidating a tag or path refreshes the cached page on the next request.
