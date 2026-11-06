---
"@getknext/core": patch
---

`knext build`, `deploy`, `preview` and `doctor` now detect `experimental.turbopackModuleFragments: true` in a next.config that also contains a glob string such as `'/img/**'`. Before this fix, the check could miss the flag on the Bun runtime. Also, `knext doctor` no longer misses a `'use cache'` directive on filesystems that do not report file types in directory listings.
