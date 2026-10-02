---
"@getknext/core": minor
---

Bundle six vinext fixes ahead of their upstream release. A new
`knext vinext-patches` command applies them to the app's installed vinext
(1.0.1 only — any other version is left untouched); vinext apps created by
`knext create` run it from `postinstall`, and `knext build` re-applies it before
the vinext build. Fixes: Pages Router `/_next/data` requests see the original
URL as `req.url`; `require()` of CommonJS dependencies picks the `require`
export condition; `turbopack.resolveExtensions` without `.mjs` no longer breaks
the Nitro build; RSC dependencies are bundled so `react-server` export
conditions apply; Web Workers get `NEXT_DEPLOYMENT_ID` inlined; and
`outputFileTracingIncludes`/`Excludes` reach Nitro's dependency trace.
