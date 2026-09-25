---
"@getknext/core": patch
---

The compiled Bun standalone build now reports how many computed
`require`/`import` call sites its bundled server code contains. These specifiers
resolve from disk at runtime, where the build's module-sharing scan cannot see
them. Set `KNEXT_STANDALONE_COMPILE_VERBOSE=1` to list them. This is
informational only and does not change the build output.
