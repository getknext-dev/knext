---
"@getknext/core": patch
---

`experimental.inlineCss` now works for App Router apps on the vinext target, on both runtimes. Pages render their stylesheets inline in `<style>` tags instead of `<link rel="stylesheet">`, as they do with `next start`. Before this, the build looked for the stylesheets in a directory that the knext build never writes, so the setting had no effect.
