import { defineConfig } from 'tsup';

/**
 * `@getknext/db` ships ESM, for the same reason `@getknext/lib` does.
 *
 * Its `exports` map already advertised every entry under the `import`
 * condition while `"type": "commonjs"` made the emitted `.js` files CJS. Beyond
 * being a mismatch, it broke test isolation under `bun test`: `mock.module`
 * cannot intercept a CJS `require()` reached through a package boundary, so a
 * test mocking `pg` silently exercised the real driver.
 *
 * tsup rather than tsc because Node's ESM wants explicit `.js` extensions on
 * relative imports and this source has none; bundling each entry makes the
 * question moot. Dependencies (drizzle-orm, @getknext/lib) stay external.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    schema: 'src/schema.ts',
    migrate: 'src/migrate.ts',
  },
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  target: 'node20',
});
