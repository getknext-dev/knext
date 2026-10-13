import { defineConfig } from 'tsup';

/**
 * `@getknext/grpc` ships ESM, one file per public entry:
 *
 * - `cli`     — the `knext generate` / `knext add function` verbs core loads lazily;
 * - `runtime` — what the generated clients import (server-only);
 * - `skew`    — the contract skew rule.
 *
 * Dependencies (buf, protobuf-es, Connect) stay external and resolve from the
 * package's own `dependencies`. `cli.js` reads `../package.json` and
 * `../proto/` at run time, so both sit beside `dist/` in the tarball.
 */
export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    runtime: 'src/runtime.ts',
    skew: 'src/skew.ts',
  },
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  target: 'node22',
});
