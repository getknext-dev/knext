---
"@getknext/core": minor
---

`kn-next create` now scaffolds the **standalone target** by default (matching the CLI's own
default build, `build: 'turbopack'`): plain `next build`, `output: 'standalone'` in
`next.config.ts`, and the official Next.js Deployment Adapter wired through `adapterPath` via a
generated `next-adapter.ts`. `kn-next build`/`deploy` stage the matching runtime image
automatically, so the scaffold ships no `Dockerfile` for this target.

Pass `--builder vinext` to scaffold the previous shape instead — the compiled single-executable
target, with its own `Dockerfile`, `vite.config.ts`, and `build: 'vinext'` pinned explicitly in
`kn-next.config.ts`. That shape is unchanged.

This only affects apps scaffolded from here on; an existing app's own files are never rewritten.
