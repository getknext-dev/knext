---
"@getknext/core": patch
---

`kn-next build` on the vinext target now prints the compile step's informational output (e.g. which server externals load from `.output/server/node_modules` vs. stay bundled — the lines `docs/build-pipeline.mdx` quotes verbatim) instead of silently discarding it. `WARNING:` lines were already visible (they print via `console.warn`, to stderr); the discarded lines were the ones the compile step prints via `console.log`, to stdout. Normal build output stays quiet; only lines starting with `[knext compile]` are surfaced.
