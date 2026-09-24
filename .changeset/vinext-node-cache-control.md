---
"@getknext/core": patch
---

vinext on Node (`runtime: 'node'` with the default build) now sends `public, max-age=0, must-revalidate` in place of Next.js's shared-cache directives, the same as the compiled executable and the standalone server. The scaffolded `knext-node-entry.mjs` turns on vinext's own deploy mode (`VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1`) and rewrites `s-maxage` headers your own code sets. Set `KNEXT_CACHE_CONTROL_NORMALIZE=0` to keep the original headers. An app created before this change has an older `knext-node-entry.mjs`; replace it with the one from a freshly created app to pick this up.
