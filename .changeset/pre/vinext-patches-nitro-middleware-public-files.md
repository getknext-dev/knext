---
"@getknext/core": patch
---

On the vinext target, with both runtimes, middleware now runs before a file in `public/` that its `matcher` covers, as with `next start`. The file is served only if the middleware lets the request continue. Middleware without a `matcher` now runs for every file in `public/`. Before this, the server returned such files directly and middleware never saw the request.
