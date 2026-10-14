import { existsSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * `@getknext/ffi` ships ESM, one file per public entry:
 *
 * - `cli`    — the `knext ffi …` verbs core loads lazily;
 * - `render` — `renderModule`, the pure renderer the image build's drift
 *              check calls.
 *
 * `build` (`knext ffi build`) is its own entry so `cli.ts` can load it at run
 * time without the two sharing a file; it is listed only once `src/build.ts`
 * exists. `cli.js` reads `../package.json` and `../templates/` at run time, so
 * both sit beside `dist/` in the tarball.
 */
const entry: Record<string, string> = {
  cli: 'src/cli.ts',
  render: 'src/render.ts',
};
if (existsSync('src/build.ts')) entry.build = 'src/build.ts';

export default defineConfig({
  entry,
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  target: 'node22',
});
