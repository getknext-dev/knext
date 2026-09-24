---
"@getknext/core": patch
---

`healthCheckPath` in `kn-next.config.ts` is now validated: it must start with a leading slash and must not contain a comma or whitespace. This value is joined into a comma-separated list of warm-up paths at image-build time, so a missing slash or an embedded comma or space used to corrupt that list silently instead of failing at `kn-next deploy`/`preview`/`build` time.
