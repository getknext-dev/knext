/**
 * The vinext build for the docs site (ADR-0048).
 *
 * docs was the LAST app on `next build --webpack` + `output: 'standalone'` +
 * a shared `NODE_COMPILE_CACHE` volume. While it stayed there, the compile-cache
 * machinery (`scripts/warm-compile-cache.sh` and its harnesses) could not be
 * deleted, because deleting a thing with a live consumer is how a migration
 * breaks the app nobody was looking at.
 *
 * The open question was fumadocs: `next.config.ts` wraps the config with
 * `createMDX()` from `fumadocs-mdx/next`, which hooks the WEBPACK/turbopack
 * pipeline that vinext does not run. What makes the migration possible is that
 * fumadocs-mdx's codegen (`postinstall: fumadocs-mdx`) is bundler-independent:
 * it emits `.source/` as ordinary TypeScript, and the app imports THAT. The
 * config wrapper only matters for compiling raw `.mdx` through a loader, and
 * fumadocs ships one for Vite (`fumadocs-mdx/vite`) alongside the webpack one.
 */
import tailwindcss from '@tailwindcss/vite';
import mdx from 'fumadocs-mdx/vite';
import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

/**
 * This one app has three deployment targets, and only one of them can run bun.
 *
 *   - knext/Knative (`Dockerfile`) — the dogfood target, `oven/bun` image
 *   - Vercel (`vercel.json`)       — a `nodejs24.x` function
 *   - plain k8s on OKE (`Dockerfile.oke`) — a `node:22-alpine` image
 *
 * `knext-bun-entry.mjs` serves through `Bun.serve`/`srvx/bun`, so carrying it
 * into a Node target produces something that COMPILES and then fails at
 * runtime — the worst shape of failure available. Overriding only the preset
 * does exactly that, which is why the entry is conditional too: nitro's own
 * default entry is what makes a Node build runnable.
 *
 * `NITRO_PRESET` passes through rather than being special-cased per target. An
 * earlier version matched `=== 'vercel'` alone, so `NITRO_PRESET=node` silently
 * produced a bun build — the env var was accepted and ignored, which is the
 * same silent-success shape this app's deployment has already produced twice.
 *
 * `bun` remains the default with no env set, so the dogfood path is unchanged.
 */
const preset = process.env.NITRO_PRESET ?? 'bun';
const usesBunEntry = preset === 'bun';

export default defineConfig({
  plugins: [
    // Tailwind through the VITE plugin, not postcss. With the postcss route
    // the plugin resolves `tailwindcss` as a relative PATH and dies with
    // `ENOENT: ... /apps/docs/tailwindcss` — measured here, and the same
    // failure file-manager's config already records.
    tailwindcss(),
    // fumadocs' MDX loader for THIS bundler. `next.config.ts` wraps the config
    // with `createMDX()` from `fumadocs-mdx/next`, which installs a loader for
    // webpack/turbopack only — vinext runs neither, so without this plugin the
    // raw `.mdx` reached vinext's RSC scanner and es-module-lexer tried to
    // parse Markdown as JavaScript (44 `Parse error` failures, one per doc).
    mdx(),
    vinext(),
    nitro({
      preset,
      // Only the bun target gets the bespoke entry; see the note above.
      ...(usesBunEntry ? { entry: './knext-bun-entry.mjs' } : {}),
      // Single chunk. nitro-on-rolldown reads `output.codeSplitting`, NOT
      // rollup's `manualChunks` — nine attempts went into that discovery.
      rollupConfig: { output: { inlineDynamicImports: true } },
    }),
  ],
});
