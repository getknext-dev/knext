/**
 * The vinext single-executable build for file-manager (ADR-0048).
 *
 * file-manager is knext's reference app: it is the one that talks to
 * scale-to-zero Postgres, and it is the app the cluster runs. ADR-0048 makes
 * vinext + Bun the only supported target, so the reference app has to be able
 * to produce that artifact — otherwise the sole supported path has no working
 * reference build.
 *
 * `preset: 'bun'` is not a preference. Measured: the bun-preset entry calls
 * that runtime's global `serve()` at module top level, so the artifact is
 * bun-only by construction — `node .output/server/index.mjs` exits 1 with a
 * missing-global error. There is no node-preset arm to fall back to.
 *
 * `entry` points at knext's own Nitro server entry rather than Nitro's default.
 * vinext is Vite/rolldown and ignores knext's webpack adapter hooks, so it
 * cannot re-provide the RuntimeContract (health, `:9091` metrics, SIGTERM
 * drain, mutating-endpoint auth) the node supervisor gives. A Nitro server
 * entry is a replaceable template, so the wrapper goes there instead of hooking
 * the pipeline.
 *
 * This sits ALONGSIDE `next build` (still in `package.json`'s `build` script)
 * during the migration. The turbopack path is retired as a user-selectable
 * target, but file-manager's node arm is what the existing compat and e2e
 * gates run against, and removing it before those move would delete the
 * evidence rather than the target.
 */

import tailwindcss from '@tailwindcss/vite';
import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // Tailwind 4 ships a first-class Vite plugin, and under Vite it is the
    // supported path. The app keeps `postcss.config.mjs` for the Next/webpack
    // arm; leaving postcss to handle Tailwind here makes it resolve
    // `tailwindcss` as a relative PATH and fail with ENOENT.
    tailwindcss(),
    // NOTE: `images: { optimizer }` is NOT passed here. vinext reads that
    // option only on its Cloudflare init path; on the node platform it is
    // ignored. knext registers the optimizer directly in knext-bun-entry.mjs.
    vinext(),
    nitro({
      preset: 'bun',
      entry: './knext-bun-entry.mjs',
      // Disable code splitting for the server bundle.
      //
      // Nitro on rolldown keys this off `output.codeSplitting`, NOT rollup's
      // `manualChunks` — which is why every earlier attempt was silently
      // ignored. Setting `inlineDynamicImports` makes nitro set
      // `codeSplitting = false` (nitro/dist/vite.mjs).
      //
      // Required, not an optimisation: when the server bundle splits, vinext's
      // Next-compat shims land in a second chunk that re-exports
      // `rsc_exports` — the first chunk's namespace — which it never imports
      // and which is declared in no emitted module. One chunk, no cycle.
      rollupConfig: { output: { inlineDynamicImports: true } },
    }),
  ],
});
