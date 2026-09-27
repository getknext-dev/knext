---
"@getknext/core": minor
---

Self-contained mode (experimental) now does something on the compiled
standalone-on-Bun target: with `selfContained: true` / `--self-contained`, the
executable embeds the app's server build output, Next.js's server modules and
the build manifests, and starts from a directory holding only itself,
`public/` and `.next/static/`. Every embedded route chunk is verified to carry
bytecode. With the flag off, the build is unchanged.
