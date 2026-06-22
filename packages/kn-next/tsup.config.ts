import { defineConfig } from "tsup";

/**
 * tsup build for the kn-next CLI (issue #68).
 *
 * Produces runnable, Node-only JS for the three CLI entries so an outside user
 * with no Bun installed can `npx kn-next`. The `bin.kn-next` in package.json
 * points at the bundled `dist/cli/kn-next.js` (the deploy entry — unchanged
 * behavior; deploy is what `kn-next` has always run).
 *
 * Runtime + workspace deps are EXTERNALIZED so they resolve from the published
 * package's own `dependencies` at install time rather than being inlined.
 */
export default defineConfig({
    entry: {
        // dist/cli/kn-next.js — the bin (deploy entry)
        "cli/kn-next": "src/cli/deploy.ts",
        // also ship runnable build/cleanup/rollback entries
        "cli/build": "src/cli/build.ts",
        "cli/cleanup": "src/cli/cleanup.ts",
        "cli/rollback": "src/cli/rollback.ts",
    },
    format: ["esm"],
    platform: "node",
    target: "node20",
    outDir: "dist",
    // The source CLI entries carry `#!/usr/bin/env node`; esbuild preserves it on
    // the entry output. We deliberately do NOT add a banner shebang here — doing
    // so would (a) duplicate the entry shebang and (b) wrongly prepend `#!` to the
    // shared chunk files. Entry shebang only is exactly what a Node bin needs.
    clean: true,
    sourcemap: true,
    // Do not bundle these — resolve from the package's deps at install time.
    external: [
        "@knext/lib",
        "ioredis",
        "yaml",
        "pino",
        "pino-pretty",
        "prom-client",
        "kafkajs",
        "@google-cloud/storage",
    ],
});
