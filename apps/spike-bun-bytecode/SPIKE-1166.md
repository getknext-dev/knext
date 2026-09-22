# Spike #1166 — can the Next standalone output `bun --compile --bytecode`?

Minimal repro: home (SSR force-dynamic), `/item/[id]` (dynamic route), `/api/health`.

## Reproduce
```
npx next build                                 # -> .next/standalone
cd .next/standalone/apps/spike-bun-bytecode
bun ../../../../spike-compile.mjs              # compiles server.js -> single exec
bun ../../../../spike-probe.mjs "$PWD"         # boots the exec + probes the 3 routes
```

## Result: STRONGLY POSITIVE — feasible, one resolution gap left

Peeling the layers (see issue #1166 for the full trail):
1. Naive `bun build --compile server.js` fails on Next's DEV-only dynamic requires. FIX: a Bun.build
   resolve plugin that STUBS them (dev-server, dev-bundler, dev-tools, hot-reloader, `*.development.js`,
   critters) to a real empty module, plus `define process.env.NODE_ENV=production` so react/next take
   production paths and the dev branches dead-code-eliminate.
2. RSC export-condition wall: `react-dom/server` picks the `bun` condition -> `server.bun.js` (react-dom
   19.2 ships none), and `react-server-dom-webpack/server` is only exported under the `react-server`
   condition. FIX: REDIRECT those specifiers to the concrete `.node.js` files. (turbopack RSC variant
   is unused here -> stubbed.)
3. **The exec COMPILES (91 MB), BOOTS, and the server goes READY. The app route chunks LOAD from disk**
   (`.next/server/chunks/[turbopack]_runtime.js` + the app-page template) — i.e. the "dynamic imports"
   worry is handled: the chunks are read from the shipped `.next` tree, not embedded.
4. REMAINING (one gap): routes 500 because turbopack's `externalRequire` of
   `next/dist/compiled/next-server/app-page-turbo.runtime.prod.js` -> `Cannot find module
   'next/dist/compiled/source-map'`. The file IS present on disk; the failure is RESOLUTION — bun's
   compiled-binary `require` for externals resolves relative to the `/$bunfs/root/` virtual fs, not the
   on-disk file's node_modules. Next step: a require shim / resolution base for next's own compiled
   externals (nft/heal territory), then the 778 suite.

**Verdict: the compile is not blocked by a fundamental "can't embed dynamic imports" wall.** It
compiles, boots, and loads route chunks; the last mile is resolving next's compiled externals from the
binary. bun-standalone-bytecode looks achievable for v1.0.
