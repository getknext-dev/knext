import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * `@getknext/lib` ships ESM.
 *
 * It used to build with plain `tsc` and `"type": "commonjs"`, which made every
 * emitted `.js` a CommonJS module — while the `exports` map advertised them
 * under the `import` condition. That mismatch was not merely untidy:
 *
 *   Bun's `mock.module` cannot intercept a CJS `require()` reached through a
 *   package boundary. So any test that mocked `pg` got the REAL module the
 *   moment the call went through `@getknext/lib`'s dist, and asserted against
 *   nothing — observed as an empty list of constructed pools, with no part of
 *   the failure naming the cause. Verified both ways: interception works across
 *   an ESM package boundary, and does not across a CJS one.
 *
 * vitest hid this by aliasing the package to source. Bun offers no equivalent —
 * a tsconfig `paths` alias resolves the module but ALSO stops `mock.module`
 * from intercepting it, measured directly. Shipping real ESM is what removes
 * the need for an alias at all.
 *
 * **tsup rather than tsc** because Node's ESM requires explicit `.js`
 * extensions on relative imports, and this package's source has none. tsup
 * bundles each entry, so the relative graph is inlined and the question does
 * not arise. `packages/kn-next` already builds this way with `format: ['esm']`.
 *
 * Runtime dependencies stay EXTERNAL (tsup's default for `dependencies`), which
 * is what keeps `pg`/`ioredis` interceptable and keeps the tarball small.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    clients: 'src/clients.ts',
    'logger/index': 'src/logger/index.ts',
    'context/index': 'src/context/index.ts',
    'health/index': 'src/health/index.ts',
  },
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  // Node 20+ is the floor the CLI already assumes.
  target: 'node20',
  // `clients.ts`'s lazy `require('minio')` / `require('@cerbos/grpc')`
  // loaders live in `src/lazy-sdk-loaders.mjs`, a hand-written, UNPROCESSED
  // plain-JS file — marked external here so esbuild never reads its
  // contents (see `clients.ts`'s block comment above `CERBOS_CLIENT_KEY`
  // for why: esbuild unconditionally rewrites any free `require` reference
  // it bundles into ESM output into its own `__require` shim, which defeats
  // webpack's/`@vercel/nft`'s static require-call tracing just as a
  // renamed local binding would). `onSuccess` copies the untouched file
  // into `dist/`, a flat sibling of the chunk that imports it, so the
  // relative specifier `./lazy-sdk-loaders.mjs` resolves the same way at
  // runtime as it does in `src/`.
  external: ['./lazy-sdk-loaders.mjs'],
  onSuccess: async () => {
    copyFileSync('src/lazy-sdk-loaders.mjs', 'dist/lazy-sdk-loaders.mjs');
  },
});
