---
"@getknext/core": patch
---

`knext doctor` now warns when your app's source uses the `'use cache'` directive. On this release line nothing shares `'use cache'` entries between pods: each server process keeps its own copy in memory, and the copy is lost on scale-to-zero. If your `next.config` sets `cacheMaxMemorySize: 0`, as scaffolded apps do, the directive keeps nothing at all, and the warning says it is effectively a no-op. The warning names the first file that uses the directive and never fails the preflight. Apps that only enable `cacheComponents`, without writing `'use cache'`, get no warning. The scan skips dependencies, build output and symlinks. In a very large directory it stops early and says so. The ISR & caching docs page describes both cases.
