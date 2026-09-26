---
"@getknext/core": patch
---

Image optimization for the vinext × node target (`runtime: 'node'`, not the default single
executable) now actually resizes images instead of silently serving originals. Two fixes,
both needed: `kn-next build` restages sharp's package and its platform addon into the image's
build output on every build — nitro's own trace previously copied an incomplete package and the
build host's addon rather than the image's `linuxmusl-x64` one — and the scaffolded
`knext-node-entry.mjs` now passes sharp directly to knext's image optimizer, the same way the Bun
single-executable entry already does, instead of a runtime resolve that can never find
`.output/server/node_modules` from the image's working directory. An app scaffolded before this
behaviour existed has an older `knext-node-entry.mjs` — rebuilding is not enough on its own, since
that file's old resolve strategy keeps serving originals regardless; replace it with the one from
a freshly created app to pick this up.
