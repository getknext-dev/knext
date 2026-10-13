---
"@getknext/core": patch
---

`knext doctor` now warns when your app's source uses the `'use cache'` directive. On this release line nothing shares `'use cache'` entries between pods: each server process keeps its own copy in memory, and the copy is lost on scale-to-zero. If your `next.config` sets `cacheMaxMemorySize: 0`, as scaffolded apps do, the directive keeps nothing at all, and the warning says it is effectively a no-op. The check used to look for the `cacheComponents` flag, so it also warned apps that enable that flag without ever writing `'use cache'`. It now looks for the directive itself, names the first file that uses it, and never fails the preflight. The ISR & caching docs page describes both cases.
