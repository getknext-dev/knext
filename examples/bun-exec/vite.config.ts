import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// vinext (Vite/rolldown Next.js reimpl) → Nitro `bun` preset, with the standard
// bun server entry REPLACED by our bespoke `knext-bun-entry.mjs` so the emitted
// `.output/server/index.mjs` wraps vinext's handler with the RuntimeContract
// (metrics / drain / auth). `build.sh` then `bun --compile --bytecode`s it.
//
// SELF-CONTAINMENT (#460 bug 1, re-established on current pins by ADR-0042 A1):
// `bun --compile` embeds every route from `.output/server/index.mjs`, so the
// binary ships as binary + `.output/public` and serves from any directory.
//
// The old note here said the newer betas emit a runtime-CHUNKED server that
// `--compile` cannot embed. That was true of `vinext@1.0.0-beta.2` and is NOT
// true of `1.0.0-beta.4` (+ vite 8): its `.output/server/` is still visibly
// chunked (`_ssr/rsc.mjs`, `_ssr/ssr.mjs`) and `bun build` bundles and embeds it
// anyway — chunked-on-disk no longer implies not-embeddable. That is what
// retired the abandoned `vinext@^0.0.19` / `nitro@3.0.1-alpha.2` pin.
// `test/alpine-image.docker-e2e.test.ts` is what keeps this claim honest.
export default defineConfig({
  plugins: [vinext(), nitro({ preset: 'bun', entry: './knext-bun-entry.mjs' })],
});
