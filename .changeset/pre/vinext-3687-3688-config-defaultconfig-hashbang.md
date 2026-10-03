---
"@getknext/core": patch
---

Bundles two fixes ahead of their upstream vinext releases:

`cloudflare/vinext#3687`: a `next.config.js`/`.ts` exported as a function
now receives the real `defaultConfig.pageExtensions` (matching Next.js's
own default) instead of an empty object — a config that reads
`defaultConfig.pageExtensions` (e.g. to append a custom page extension)
previously threw `defaultConfig.pageExtensions is not iterable` at build
time.

`cloudflare/vinext#3688`: a module that starts with a hashbang line
(`#!/usr/bin/env node`) and also uses CommonJS syntax (`module.exports`,
`require(...)`) no longer fails to build. The CommonJS-to-ESM interop
transform used to prepend its runtime facade before the hashbang, pushing
`#!` out of the first two bytes of the file and causing the bundler to
reject it as invalid syntax; the hashbang is now stripped before that
transform runs and spliced back onto its output.
