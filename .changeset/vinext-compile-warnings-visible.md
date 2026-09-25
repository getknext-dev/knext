---
"@getknext/core": patch
---

`kn-next build` on the vinext target now prints the compile step's build warnings (e.g. createRequire-staticize warnings, native-addon warnings — the lines `docs/build-pipeline.mdx` quotes verbatim) instead of silently discarding them. Normal build output stays quiet; only lines starting with `[knext compile]` are surfaced.
