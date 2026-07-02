import { defineConfig } from 'tsup';

/**
 * tsup build for the kn-next CLI AND the @knext/core library surface (#68, #114).
 *
 * Produces runnable, Node-only JS for the CLI entries so an outside user with no
 * Bun installed can `npx kn-next`. The `bin.kn-next` in package.json points at
 * the bundled `dist/cli/kn-next.js` (the deploy entry — unchanged behavior).
 *
 * PK1 (#114): the package also publishes a LIBRARY surface that apps import on
 * plain Node — config (`KnativeNextConfig`), the official Next.js adapter,
 * node-server, cache-handler, otel-config, loader, and the logger. These were
 * previously advertised as raw `./src/*.ts` with no dist output, breaking any
 * consumer on Node. They are now built here so every `exports` subpath resolves
 * to compiled JS + `.d.ts` (the `.js` cache-handler is untyped, so no `.d.ts`).
 *
 * Runtime + workspace deps are EXTERNALIZED so they resolve from the published
 * package's own `dependencies` at install time rather than being inlined.
 */
export default defineConfig([
  {
    entry: {
      // --- CLI entries -----------------------------------------------------
      // dist/cli/kn-next.js — the bin (deploy entry)
      'cli/kn-next': 'src/cli/deploy.ts',
      // also ship runnable build/cleanup/rollback entries
      'cli/build': 'src/cli/build.ts',
      'cli/cleanup': 'src/cli/cleanup.ts',
      'cli/rollback': 'src/cli/rollback.ts',
      // #91 per-PR preview environments (deploy/destroy)
      'cli/preview': 'src/cli/preview.ts',
      // #30: k6 load-test entry (manual/nightly runbook, not a PR gate)
      'cli/loadtest': 'src/cli/loadtest.ts',
      // CLI helpers exported as library subpaths (./cli/validate, ./cli/shared)
      'cli/validate': 'src/cli/validate.ts',
      'cli/shared': 'src/cli/shared.ts',
      // --- Library surface (#114) -----------------------------------------
      // dist/config.js — the `.` export (KnativeNextConfig type + helpers)
      config: 'src/config.ts',
      loader: 'src/loader.ts',
      'adapters/next-adapter': 'src/adapters/next-adapter.ts',
      'adapters/node-server': 'src/adapters/node-server.ts',
      // #188 round 3 — own dist entry so e2e-deploy.sh can import the heal
      // POST-build (onBuildComplete fires before .next/standalone exists).
      'adapters/standalone-bun-exports': 'src/adapters/standalone-bun-exports.ts',
      // cache-handler is plain JS (untyped) — bundled to dist, no .d.ts emitted
      'adapters/cache-handler': 'src/adapters/cache-handler.js',
      'adapters/otel-config': 'src/adapters/otel-config.ts',
      'utils/logger': 'src/utils/logger.ts',
    },
    // Emit `.d.ts` declarations for the TS library entries so typed consumers
    // (e.g. `import type { KnativeNextConfig } from '@knext/core'`) work. The
    // cache-handler is plain untyped JS, so it is omitted from the DTS pass
    // (TS6504) — its `exports` subpath is a bare `.js` with no `.d.ts`.
    dts: {
      entry: {
        'cli/kn-next': 'src/cli/deploy.ts',
        'cli/build': 'src/cli/build.ts',
        'cli/cleanup': 'src/cli/cleanup.ts',
        'cli/rollback': 'src/cli/rollback.ts',
        'cli/preview': 'src/cli/preview.ts',
        'cli/loadtest': 'src/cli/loadtest.ts',
        'cli/validate': 'src/cli/validate.ts',
        'cli/shared': 'src/cli/shared.ts',
        config: 'src/config.ts',
        loader: 'src/loader.ts',
        'adapters/next-adapter': 'src/adapters/next-adapter.ts',
        'adapters/node-server': 'src/adapters/node-server.ts',
        'adapters/standalone-bun-exports': 'src/adapters/standalone-bun-exports.ts',
        'adapters/otel-config': 'src/adapters/otel-config.ts',
        'utils/logger': 'src/utils/logger.ts',
      },
    },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    outDir: 'dist',
    // The source CLI entries carry `#!/usr/bin/env node`; esbuild preserves it on
    // the entry output. We deliberately do NOT add a banner shebang here — doing
    // so would (a) duplicate the entry shebang and (b) wrongly prepend `#!` to the
    // shared chunk files. Entry shebang only is exactly what a Node bin needs.
    clean: true,
    sourcemap: true,
    // Do not bundle these — resolve from the package's deps at install time.
    external: [
      '@knext/lib',
      'ioredis',
      'yaml',
      'pino',
      'pino-pretty',
      'prom-client',
      'kafkajs',
      '@google-cloud/storage',
    ],
  },
  // #175 — the deployed-platform Cache-Control preload. It is loaded with
  // `node --require` / `bun -r` into the standalone server process, so it MUST
  // be CommonJS (tsup emits `.cjs` for format:cjs under `"type": "module"`).
  // Dependency-free by design; `clean: false` so this pass does not wipe the
  // ESM output above.
  {
    entry: {
      'adapters/cache-control-normalize': 'src/adapters/cache-control-normalize.cjs',
      // #188 — Bun ≤1.3.x keep-alive mitigation (bun lane only; Node-inert).
      'adapters/bun-keepalive-guard': 'src/adapters/bun-keepalive-guard.cjs',
    },
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    outDir: 'dist',
    clean: false,
    sourcemap: true,
  },
]);
