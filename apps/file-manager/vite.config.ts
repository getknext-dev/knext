// SPIKE ONLY — vinext build of file-manager (ADR-0042 Phase 3 evidence).
//
// Purpose: find out what a FULLY DEVELOPED app hits on the vinext + bun-exec
// target. Everything measured on that target so far has been the 5-route
// examples/bun-exec toy. file-manager is 24 pages + 8 API routes and uses
// middleware, next/image, next/font, next/cache and Server Actions — several of
// which ADR-0036 lists as making an app bun-exec-INELIGIBLE. The expected
// outcome is therefore failure; the VALUE is knowing exactly where and why.
//
// Uses knext's BESPOKE entry, not nitro's default bun entry. This is not
// optional: nitro anchors static assets on `globalThis.__nitro_main__ =
// import.meta.url`, and `bun --compile` BAKES that to the build-host absolute
// path, so every asset 500s in a container while `GET /` still returns correct
// SSR HTML (#657). knext-bun-entry.mjs re-anchors the asset root on
// process.execPath. Measured here: with nitro's default entry, 0 of 14
// referenced assets served -- CSS, every JS chunk, and both next/font woff2s.
//
// Not a proposal to ship file-manager on this target.
import tailwindcss from '@tailwindcss/vite';
import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  // Tailwind v4 must come through its VITE plugin here, not PostCSS. The app's
  // postcss.config.mjs (`@tailwindcss/postcss`) is what `next build` uses, but
  // under vite the bare `@import "tailwindcss"` reaches postcss-import first,
  // which tries to resolve it as a FILE and dies with ENOENT. Adaptation #1 that
  // a real migration would have to make.
  plugins: [tailwindcss(), vinext(), nitro({ preset: 'bun', entry: './knext-bun-entry.mjs' })],
});
