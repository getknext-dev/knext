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

**Note:** `vinext` 1.0.1 installs `@vercel/og` 1.0.3, whose published
package is missing one of its WebAssembly files. `vinext` works around that
itself, but in this build Nitro keeps `@vercel/og` as an external package,
which bypasses that workaround, so `next/og` answers a 500 error (compiled or
not). Apps created with `knext create --builder vinext` now pin `@vercel/og`
to `0.11.1` through an `overrides` entry in `package.json`. An existing app
adds the same entry by hand:

```json
{
  "overrides": {
    "@vercel/og": "0.11.1"
  }
}
```

`package.json` is plain JSON and cannot carry a comment, so the reason for the
pin lives here and in the build-pipeline docs. Remove the entry once a `vinext`
release ships a working `@vercel/og`.
