# Spike #1166 — can the Next standalone output `bun --compile --bytecode`?

Minimal repro: home (SSR force-dynamic), `/item/[id]` (dynamic route), `/api/health`.

## Reproduce
```
npx next build                      # produces .next/standalone
cd .next/standalone/apps/spike-bun-bytecode
bun ../../../../spike-compile.mjs   # attempts the compile with the dev-stub plugin
```

## Findings (see issue #1166 for detail)
- Naive `bun build --compile server.js` fails on Next's DEV-only dynamic requires
  (`./dev/next-dev-server`, `setup-dev-bundler`) — conditional requires bun can't prove dead.
- `spike-compile.mjs` stubs the dev-only set via a Bun.build resolve plugin. It then peels down to
  a SINGLE wall: `react-dom/server` + `react-server-dom-{turbopack,webpack}/*` — the nft-omission /
  bun-export-condition layer that `packages/kn-next/src/adapters/standalone-bun-exports.ts` heals.
- Next step: resolve that RSC layer via the nft trace + the bun-exports heal, then the app route
  chunks, then boot + probe + the 778 compat suite.
