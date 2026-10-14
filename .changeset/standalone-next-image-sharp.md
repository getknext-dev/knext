---
"@getknext/core": patch
---

Fix `next/image` serving unoptimized originals on the default standalone build. `/_next/image` answered with the source image instead of the negotiated format (for example `image/png` where the browser asked for `image/webp`); Next.js does not report this as an error, because when it cannot load `sharp` it serves the original file.

Who was affected, on 1.0.0, 1.0.0-rc.6, 1.3.0 and 1.3.1 (and very likely earlier prereleases):

- `build: 'turbopack'` or `'webpack'` with `runtime: 'bun'` (the default, disk mode) never optimized images, wherever it was built: the compiled executable bundled `sharp`, whose native addon could not find `libvips` from inside the executable. `sharp` now loads from the standalone tree beside the executable.
- The same builds with `runtime: 'node'` lost image optimization whenever the build machine had no `@img/sharp-linuxmusl-*` package installed — npm on a glibc Linux host (a typical CI runner) or any macOS host — because the image is Alpine (musl) and the tree only carried the build machine's addon. `knext build`, `knext deploy` and `knext preview` now add the image's own addon (`@img/sharp-linuxmusl-x64` and its `libvips`) beside the traced `sharp`.
- Self-contained mode and the vinext build targets were not affected.

The image's addon is copied from your install when it is there at the exact version the traced `sharp` expects, and is otherwise downloaded at that version as pinned in your lockfile and checked against the lockfile's sha512 integrity hash. Supported lockfiles: `bun.lock`, `package-lock.json`, `pnpm-lock.yaml` (v6 and v9) and Yarn 1's `yarn.lock`. When the addon has to be downloaded and there is no lockfile, the lockfile does not pin it, or its entry has no sha512 hash (always the case for Yarn 2 and later, whose checksum covers Yarn's own cache archive), the build stops and names the lockfile and the package rather than shipping an image that cannot optimize. The image optimization docs list the ways past it. An app with `images: { unoptimized: true }` skips this step entirely and needs neither a lockfile nor registry access for it.

The same lockfile support, and the same version check on a copied addon, now also apply to the vinext build targets.
