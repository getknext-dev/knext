---
"@getknext/core": patch
---

Fix `next/image` serving unoptimized originals on the standalone target. On the compiled Bun executable (`build: 'turbopack'` or `'webpack'` with `runtime: 'bun'`, the default) and in both standalone images, `/_next/image` answered with the source image instead of the negotiated format (for example `image/png` where the browser asked for `image/webp`). Next.js does not report this as an error: when it cannot load `sharp` it serves the original file.

Two causes, both fixed. The compiled executable bundled `sharp`, and its native addon could not find `libvips` from inside the executable; `sharp` now loads from the standalone tree beside the executable. And the standalone images are Alpine (musl), but the tree they copy carried only the build machine's `sharp` addon; `knext build`, `knext deploy` and `knext preview` now add the image's own addon (`@img/sharp-linuxmusl-x64` and its `libvips`) next to the traced `sharp`, from your install when it is there and otherwise fetched at the version your lockfile pins and checked against its integrity hash. A build on a machine without that package therefore needs registry access and a lockfile (`bun.lock` or `package-lock.json`) that pins it; without either, the build stops and names the missing package rather than shipping an image that cannot optimize. Self-contained mode is unchanged.
