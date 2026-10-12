---
"@getknext/core": major
---

**Breaking: knext now requires Next.js 16.4.0 or newer.** The `next` peer dependency range moves from `>=16.0.0` to `>=16.4.0`. Apps on Next.js 16.0 through 16.3 must upgrade Next.js before upgrading knext, or stay on knext 1.x. The adapter no longer reads the Next.js 16.0.x build-context shape, so build diagnostics for that version are gone with it.
