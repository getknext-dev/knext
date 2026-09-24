---
"@getknext/core": patch
---

`kn-next doctor` now checks whether a scaffolded `knext-node-entry.mjs` (used
by `build: 'vinext'` + `runtime: 'node'` apps) is behind the version shipped
in the installed `@getknext/core` package, and warns with the exact fix when
it is stale — the entry is written once by `kn-next create` and never
re-rendered by later builds or deploys, so an app scaffolded before a runtime
fix keeps running the old behavior silently.

The deployed Cache-Control normalization (both the `vinext`-on-Node middleware
and the compiled executable's `Bun.serve` seam share one implementation) now
falls back to rebuilding the `Response` when its headers are immutable — a
proxied `fetch()` response or `Response.redirect()` — instead of silently
skipping the rewrite and shipping the origin `s-maxage=…` value to clients.
