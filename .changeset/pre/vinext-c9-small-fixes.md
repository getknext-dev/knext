---
"@getknext/core": patch
---

Bundles 4 small vinext fixes ahead of their upstream release, each ported as its own
upstream PR against `cloudflare/vinext`:

- `experimental.lightningCssFeatures.include`'s `custom-media-queries` entry now also
  turns on lightningcss's `drafts.customMedia` parser flag, so a stylesheet using
  `@custom-media` builds instead of failing to parse (`cloudflare/vinext#3681`).
- App Router: a GET/HEAD request for an unmatched path whose `Sec-Fetch-Dest` is a
  non-HTML subresource destination (image, font, script, manifest, ...) now gets the
  same plain-text 404 an invalid `_next/static/*` request already gets, instead of
  compiling and rendering the full custom not-found page
  (`cloudflare/vinext#3682`).
- A route whose resolved `runtime` is `edge`/`experimental-edge` now prints the "Edge
  Runtime is deprecated" warning once per build/dev session, matching Next.js
  (`cloudflare/vinext#3683`).
- A bare `//` (literal or percent-encoded, with nothing after it) in a request path is
  no longer treated as an open-redirect shape and 404'd; it now serves the index route,
  matching Next.js (`cloudflare/vinext#3684`).

All 4 patches are runtime-agnostic (they also help a future vinext x node lane, not
just vinext x bun) and ship with their own behaviour test against the patched dist.
