---
"@getknext/core": minor
---

The adapter no longer overwrites `output: 'export'` with `output: 'standalone'`. `standalone` is now only the default: an app that sets `output: 'export'` keeps it, so Next.js runs its own static-export validation (for example, it rejects intercepting routes in a static export) instead of having it silently skipped. knext deploys a Next.js server, so on the Next.js build path (turbopack or webpack) `knext build`, `knext deploy` and `knext preview` now stop after a static-export build with a clear message: a static export is not a server deployment. Remove `output: 'export'`, or host the `out/` folder on a static host. Apps with `output` unset or set to `'standalone'` build exactly as before, and the vinext target is unchanged.
