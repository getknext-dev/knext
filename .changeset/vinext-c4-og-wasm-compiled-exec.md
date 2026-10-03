---
"@getknext/core": patch
---

Fixes `next/og`'s `ImageResponse` (e.g. a dynamic `opengraph-image` route)
answering a 500 error when built as a `bun build --compile --bytecode`
single executable (the `vinext` build target's compiled-binary shape). It
previously failed every time with `ENOENT`, because the compiled binary
looked for the image renderer's WASM and fallback-font files at a path that
only ever existed on the machine that built it. `ImageResponse` now works
the same way in the compiled binary as it does uncompiled.
