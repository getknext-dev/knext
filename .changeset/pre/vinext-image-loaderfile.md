---
"@getknext/core": patch
---

`images.loaderFile` in `next.config` now works on the vinext target: `next/image` renders through your custom loader instead of silently using the built-in `/_next/image` endpoint. A missing loader file, or a `loader` other than `default`/`custom` set next to it, fails the build as in Next.js, and `images.loader: 'custom'` without a loader throws Next.js's missing-loader error. Delivered as a bundled vinext fix on top of the earlier `next/image` one, so apps that already carry that fix pick it up without reinstalling.
