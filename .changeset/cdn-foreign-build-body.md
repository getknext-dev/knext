---
"@getknext/core": patch
---

With `cdn` set, a page that the previous build rendered is no longer edge-cached after a deploy. Cached pages are shared across builds, so for a while after a rollout the new build can serve a page from the shared cache that the previous build rendered. Before, such a response was marked edge-cacheable and tagged with the new build's tag, so the CDN refilled with the previous build's HTML right after the deploy purge. Now the cache handler notes which build wrote the page it serves, and the response is served to the browser but not cached at the edge. It is counted as `foreign_build_body`. Once the new build renders the page itself, for example on `revalidatePath` or `revalidateTag`, the page is edge-cached again. Without `cdn` nothing changes.
