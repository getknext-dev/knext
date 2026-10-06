---
"@getknext/core": patch
---

`next/og` `ImageResponse` now works in the compiled single executable built for the vinext target with `@vercel/og` 1.x (the version vinext pins). The build embeds the HarfBuzz `hb.wasm` binary from the exact `satori` → `harfbuzzjs` versions `@vercel/og` was built against, so OG image routes, route handlers and middleware no longer answer 500 or drop the connection with `ENOENT … hb.wasm`.
