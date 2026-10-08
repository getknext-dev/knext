---
"@getknext/core": patch
---

On the vinext target, `/_next/static/<buildId>/_buildManifest.js` now lists the app's Pages Router routes (API routes, `/_app` and `/_error` included) in `sortedPages`, in Next.js order, instead of an empty list.
