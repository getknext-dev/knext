---
"@getknext/core": patch
---

After a deploy, a page the previous build rendered is now re-rendered by the new build instead of being served from the shared cache for the rest of its revalidate window. Before, a prerendered page with `revalidate = 3600` kept answering `HIT` with the previous build's HTML for up to an hour after a deploy, and a `revalidate: false` page kept it until something revalidated it. Now, once the previous build has stopped serving, the first request for such a page may get the previous page once, as `STALE`, while a fresh copy renders in the background, and later requests get the new build's page. This holds for `revalidate: false` pages too. With `cdn` set, the stale response is still kept off the edge and the fresh copy is edge-cached as usual. While two builds are both serving (a canary split), each still honours the other's revalidate window, as before.
