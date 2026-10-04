---
"@getknext/core": patch
---

`knext create --builder vinext` now pins `@vercel/og` to `0.11.1` through an
`overrides` entry in the generated `package.json`, so `next/og`'s
`ImageResponse` (for example a dynamic `opengraph-image` route) renders in a
new app on both the Bun and Node runtimes without manual setup. Without the
pin, `vinext` 1.0.1 installs `@vercel/og` 1.0.3, which answers a 500 error in
this build. Apps created before this change add the entry by hand; see the
build-pipeline docs. Other builders are unchanged.

Escalation trigger acknowledged: this changes the `knext create` scaffold
output (CLI surface). It adds one `package.json` field to the vinext template
only; no config schema, CRD or public API change.
