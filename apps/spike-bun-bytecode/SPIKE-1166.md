# Spike #1166 — can the Next standalone output `bun --compile --bytecode`?

Minimal repro: home (SSR force-dynamic), `/item/[id]` (dynamic route), `/api/health`.

## Reproduce
```
npx next build                                 # -> .next/standalone
cd .next/standalone/apps/spike-bun-bytecode
bun ../../../../spike-compile.mjs              # compiles server.js -> single exec
bun ../../../../spike-probe.mjs "$PWD"         # boots the exec + probes (currently 500s)
bun ../../../../spike-probe-uncompiled.mjs "$PWD"  # UNCOMPILED bun run server.js -> all 200
```

## Result: uncompiled works; compiled hits Next's externalRequire architecture

- **UNCOMPILED `bun run server.js`: all 3 routes 200.** The bun-standalone axis works today. This is
  ADR-0054's safety-valve fallback — proven solid on this app.
- **COMPILED: compiles (91 MB), boots, READY, and the app route chunks LOAD from disk** — so embedding
  the app's own dynamic route chunks is NOT the blocker (they ship in `.next/` next to the binary).
  The recipe that gets this far (in `spike-compile.mjs`): a Bun.build resolve plugin that STUBS Next's
  dev-only requires + `define`s `NODE_ENV=production` (DCE the dev branches) + REDIRECTS the RSC
  export-condition specifiers (`react-dom/server`, `react-server-dom-webpack/{server,client}`) to
  concrete `.node.js` files.

## The real wall (characterized precisely)
Routes 500 on: `Failed to load external module .../app-page-turbo.runtime.prod.js: Cannot find module
'next/dist/compiled/source-map'`.

Next's turbopack standalone loads its OWN server runtime (`app-page-turbo.runtime.prod.js`) via
`externalRequire` — a deliberate escape hatch — from disk. That disk module then `require()`s bare
specifiers (`next/dist/compiled/source-map`, present on disk). **bun's compiled binary does not do
disk `node_modules` resolution for bare-specifier requires inside externalRequire'd disk modules** —
verified: a top-level `node_modules/next` symlink and `NODE_PATH` both fail; `next` has no `exports`
restriction and the file exists. So this is architectural: externalRequire escapes both bundling and
the compiled resolver.

## Narrowed solution paths (for continuation)
1. **Defeat/patch `externalRequire`** so the server runtime + its bare deps come from the embedded
   bundle instead of disk (an nft-driven barrel that statically imports the runtime files, or a
   require-shim the compiled entry installs).
2. **Pre-bundle** server.js + the turbopack server runtime into one statically-analyzable file
   (following what externalRequire hides), THEN `--compile`.
3. Confirm whether embedding the specific `next/dist/compiled/*` externals makes the disk module's
   bare require resolve from the bundle.

## Verdict for ADR-0054
The decision structure holds: **ship UNCOMPILED bun-standalone as v1.0 (proven 200s here), make the
bytecode-exec packaging the fast-follow.** The compile is feasible up to Next's externalRequire
runtime layer; solving that (paths above) is real but bounded R&D, not a v1.0 blocker.
