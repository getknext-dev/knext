---
"@getknext/core": patch
---

`knext build`, `knext deploy` and `knext preview` now refuse `experimental.turbopackModuleFragments` when the runtime is Bun and the build is Turbopack, and `knext doctor` reports the same condition. With that flag on, Next 16.4 Turbopack emits chunks that assign to a `const` in code that never runs; Bun's parser rejects those when the chunk loads, so the app would fail at runtime. Turn the flag off in your `next.config`, set `runtime: 'node'`, or use a webpack build. If `next.config` exists but cannot be read, the Bun build refuses rather than assuming it is clean. The check reads the flag literally from `next.config`, so a flag computed at runtime is not detected, and `knext deploy --skip-build` ships an already-built artifact without re-checking it.
