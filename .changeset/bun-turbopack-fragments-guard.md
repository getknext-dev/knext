---
"@getknext/core": patch
---

`knext build` now refuses `experimental.turbopackModuleFragments` when the runtime is Bun, and `knext doctor` reports the same condition. With that flag on, Next 16.4 Turbopack emits chunks that assign to a `const` in code that never runs; Bun's parser rejects those when the chunk loads, so the app would fail at runtime. Turn the flag off in your `next.config`, or set `runtime: 'node'`. If `next.config` exists but cannot be read, the Bun build refuses rather than assuming it is clean.
