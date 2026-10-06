---
"@getknext/core": patch
---

`next/og` `ImageResponse` now works on the vinext target with `@vercel/og` 1.x (the version vinext pins), on both the Bun compiled executable and Node.js, in pages API routes, app route handlers (Edge or Node.js runtime) and middleware. The build ships the HarfBuzz `hb.wasm` binary from the exact `satori` → `harfbuzzjs` versions `@vercel/og` was built against: it is embedded in the Bun executable, and staged into `.output/server` with its MIT licence for Node.js. OG image routes no longer answer 500 or drop the connection with `ENOENT … hb.wasm`. When those versions do not match, the build prints a `WARNING: next/og will fail at runtime` line, and fails instead under `KNEXT_COMPILE_STRICT_REQUIRES=1` on either runtime (or a `--self-contained` Bun build).
