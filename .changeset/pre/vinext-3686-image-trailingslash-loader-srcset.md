---
"@getknext/core": patch
---

Bundles a fix for `next/image` ahead of its upstream vinext release
(`cloudflare/vinext#3686`): the image optimization endpoint now honours
`trailingSlash: true` (previously always `/_next/image?...`, never
`/_next/image/?...`), and a custom `loader` prop now gets the same
per-breakpoint `srcSet` treatment as the built-in loader — the loader is
called once per responsive width instead of once at the raw intrinsic
width, and `quality` is passed through as given instead of being forced
to 75.

Not yet bundled: the upstream fix also wires up `images.loaderFile`
(previously silently ignored); that part needs vinext's own build
pipeline to resolve and isn't a knext-side patch, so `images.loaderFile`
remains ignored until the upstream release.
