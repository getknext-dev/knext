---
"@getknext/core": patch
---

`kn-next build` now stages sharp correctly for the vinext × node image: nitro's own trace into `.output/server/node_modules` copied an incomplete `sharp` package and the BUILD HOST's native addon rather than the image's (`linuxmusl-x64`) — so `/_next/image` was silently serving unoptimized originals. The scaffolded `knext-node-entry.mjs` also now passes `sharp` directly to the image optimizer, the same way the Bun single-executable entry already does, instead of a runtime resolve that can never find `.output/server/node_modules` from the image's working directory. An app created before this change has an older `knext-node-entry.mjs`; replace it with the one from a freshly created app (or re-run `kn-next build`, which restages the correct sharp on every build) to pick this up.
