---
"@getknext/core": patch
---

`kn-next build` (vinext target) now bundles packages that nitro's server chunks load at runtime with `createRequire(import.meta.url)`, not only the ones the entry loads, so a chunked server bundle no longer produces a binary that fails with `Cannot find module` once deployed. Set `KNEXT_COMPILE_STRICT_REQUIRES=1` to fail the build, instead of warning, when such a package cannot be resolved.
