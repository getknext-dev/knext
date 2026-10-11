---
"@getknext/core": patch
---

A vinext version other than the one knext's bundled fixes were checked against no longer goes unnoticed. `knext doctor` now reports a row for it: an older vinext is a `FAIL` (the fixes are missing, including the Nitro image optimizer and the 404 for unmatched asset requests), a newer one is a `WARN`. The `knext build` message is now a warning that says how many fixes were skipped, what the build lacks and how to fix it. The default is unchanged (the build continues); set `KNEXT_VINEXT_PATCHES=strict` to make the mismatch a build error.

The Redis cache handler also recognises vinext's `{ env, options }` constructor argument by its exact shape (those two keys, `options` a plain object), so a Next.js options object that happens to carry an `env` or `options` key is passed through untouched instead of silently losing its options.
