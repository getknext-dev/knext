---
"@getknext/core": patch
---

On the vinext target, a `next.config` rewrite (or a middleware rewrite) whose destination is a file in `public/` now serves that file instead of the 404 page. This covers the Pages Router in all three rewrite phases (`beforeFiles`, `afterFiles`, `fallback`) and the App Router's `beforeFiles` and middleware rewrites. Delivered as a bundled vinext fix until vinext ships it. Middleware still does not run for a direct request to a file in `public/` on this target.
