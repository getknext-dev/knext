---
"@getknext/core": patch
---

Apps created with `knext create --builder vinext` now pin `vinext` `1.1.0`, and the vinext fixes knext bundles are re-validated against it. Five bundled fixes are dropped because vinext 1.1.0 already includes them: `/_next/data/…` requests reaching `getServerSideProps` with the original URL, custom-media drafts in `lightningCssFeatures`, the `308` redirect for repeated slashes and backslashes, a function-form `next.config` receiving the real default `pageExtensions`, and `x-nextjs-cache: MISS` on `/_next/image` success responses. The remaining bundled fixes apply only to vinext `1.1.0`; an app that pins another vinext version skips them with a message saying so.

The vinext cache adapters (`@getknext/core/internal/vinext-cache-adapter`, `-node`, `-bun`) keep a plain-function default export, so they work with both vinext 1.0.1 and 1.1.0 and existing apps keep sharing ISR through Redis. The cache handler also accepts vinext's `{ env, options }` argument, and each adapter module exports its handler class as `KnextCacheHandler` for vinext 1.1.0, which can construct a class directly.
