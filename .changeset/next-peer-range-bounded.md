---
"@getknext/core": patch
---

The `next` peer range is now bounded to the Next.js minors knext has compatibility evidence for: `>=16.0.0 <16.5.0` (was `>=16.0.0`, which admitted every future minor unvetted). Next.js 16.4 stays admitted, and now caches correctly (see the ISR window fix in this release). A Next.js minor above the range is refused until a knext release admits it: npm stops the install with `ERESOLVE` (`--legacy-peer-deps` overrides it), pnpm warns, Bun installs silently. `knext doctor` also gains a `next-minor` row that warns when the installed Next.js is inside the range but not one of the minors covered by the official compatibility suite (`16.3`), or is outside the range.
