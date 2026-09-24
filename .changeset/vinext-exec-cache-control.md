---
"@getknext/core": patch
---

The compiled Bun executable now sends `public, max-age=0, must-revalidate` in place of Next.js's shared-cache directives (`s-maxage=…, stale-while-revalidate=…`), matching knext's standalone server and what a deployed Next.js app returns to browsers. Set `KNEXT_CACHE_CONTROL_NORMALIZE=0` to keep the original headers, for example when your own CDN sits in front of the app.
