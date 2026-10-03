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

**Note:** `@vercel/og` 1.0.0–1.0.3 — the version `vinext` 1.0.1 installs by
default — is itself published without one of its WebAssembly files, so
`next/og` fails on every runtime (compiled or not, Bun or Node) until that
is fixed upstream. Until then, add an override pinning `@vercel/og` to
`0.11.1`:

```json
{
  "overrides": {
    "@vercel/og": "0.11.1"
  }
}
```
