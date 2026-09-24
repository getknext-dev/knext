---
"@getknext/core": patch
---

The compiled Bun single executable now works for apps that depend on `@opentelemetry/*` packages. vinext keeps those packages external to the server bundle, which loads them at runtime from `.output/server/node_modules`. The compiled executable has no such directory next to it, so every request failed with `Cannot find module '@opentelemetry/api'`. `kn-next build` now bundles every package the server entry loads that way into the executable. A package that cannot be resolved at build time is left as a runtime load, and the build prints a warning naming it.
