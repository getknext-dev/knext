import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
import vinext from 'vinext';

// vinext (Vite/rolldown Next.js reimpl) → Nitro `bun` preset, with the standard
// bun server entry REPLACED by our bespoke `knext-bun-entry.mjs` so the emitted
// `.output/server/index.mjs` wraps vinext's handler with the RuntimeContract
// (metrics / drain / auth). `build.sh` then `bun --compile --bytecode`s it.
//
// The exact pins in package.json are load-bearing: vinext 1.0.0-beta.2 is locked
// to nitro 3.0.260610-beta and @vitejs/plugin-rsc 0.5.28 (exact-pinned, matching
// the committed bun.lock). Stable nitro/rsc break the build (see README
// "beta-on-beta toolchain risk").
export default defineConfig({
  plugins: [vinext(), nitro({ preset: 'bun', entry: './knext-bun-entry.mjs' })],
});
