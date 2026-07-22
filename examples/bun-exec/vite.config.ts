import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// vinext (Vite/rolldown Next.js reimpl) → Nitro `bun` preset, with the standard
// bun server entry REPLACED by our bespoke `knext-bun-entry.mjs` so the emitted
// `.output/server/index.mjs` wraps vinext's handler with the RuntimeContract
// (metrics / drain / auth). `build.sh` then `bun --compile --bytecode`s it.
//
// SELF-CONTAINMENT (#460 bug 1): the version combo in package.json — nitro
// 3.0.1-alpha.2 / vinext 0.0.19 / vite 7 / @vitejs/plugin-rsc 0.5.x — emits a
// server BUNDLED into `.output/server/index.mjs`, so `bun --compile` embeds all
// routes and the binary is self-contained (ships as binary + `.output/public`).
// The newer betas (nitro 3.0.260610-beta / vinext 1.0.0-beta.2) instead emit a
// runtime-CHUNKED server that loads routes from `.output/server/` at runtime,
// which `--compile` cannot embed → the binary 404s outside its build dir.
export default defineConfig({
  plugins: [vinext(), nitro({ preset: 'bun', entry: './knext-bun-entry.mjs' })],
});
