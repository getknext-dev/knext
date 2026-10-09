---
"@getknext/core": patch
---

Apps created with `knext create --builder vinext` now pin `vinext` `1.1.0`, and the vinext fixes knext bundles are re-validated against it. Five bundled fixes are dropped because vinext 1.1.0 already includes them: `/_next/data/…` requests reaching `getServerSideProps` with the original URL, custom-media drafts in `lightningCssFeatures`, the `308` redirect for repeated slashes and backslashes, a function-form `next.config` receiving the real default `pageExtensions`, and `x-nextjs-cache: MISS` on `/_next/image` success responses. The remaining bundled fixes apply only to vinext `1.1.0`; an app that pins another vinext version skips them with a message saying so.

The vinext cache-adapter factory wrappers are removed: vinext 1.1.0 constructs a class default export with `{ env, options }`, so the `@getknext/core/internal/vinext-cache-adapter`, `-node` and `-bun` subpaths now export the cache-handler classes directly (the subpath names are unchanged). The cache handler accepts both vinext's `{ env, options }` and Next.js's bare options. Requires vinext 1.1.0 or later; on an older vinext a class adapter is silently replaced by the in-memory cache.
