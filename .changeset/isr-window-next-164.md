---
"@getknext/core": patch
---

On Next.js 16.4, a previous build's revalidate window is no longer honoured after a deploy. Next 16.4 applies the window a cache handler returns directly, so a cached page written by an earlier build (or by a legacy entry, or under a build id shared across deploys) could be served as fresh for its whole old window after a redeploy, and forever for `revalidate: false`. The handler now hands Next a stored window only for pages the current build wrote; the others are re-rendered. Next 16.0 to 16.3 behave as before.
