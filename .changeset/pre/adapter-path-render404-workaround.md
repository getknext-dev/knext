---
"@getknext/core": patch
---

On Next.js before 16.4.0, a route with `dynamicParams = false` could answer a burst of concurrent prefetches for a parameter outside `generateStaticParams` with a 500 instead of a 404, whenever an adapter was configured; Next.js fixed it in 16.4.0 and did not backport it. `knext build`, `deploy` and `preview` now clear `adapterPath` from the standalone server's runtime configuration (`server.js` and `.next/required-server-files.json`) when the installed Next.js is older than 16.4.0, before the Bun executable is compiled, so both runtimes ship the fix. The adapter only works during `next build`, so nothing at runtime depends on it; those requests become plain 404s, as on a standalone server without an adapter, and each one logs `Error: Internal: NoFallbackError`. On Next.js 16.4.0 or later nothing changes. The workaround is gated on the installed Next.js version and removes itself there.
