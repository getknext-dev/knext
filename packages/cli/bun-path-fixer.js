import fs from 'node:fs';
import path from 'node:path';
/**
 * Bun Path Fixer Plugin
 *
 * This plugin fixes the paths[1] error that occurs when Bun compiles a binary.
 * The error happens because createRequire(import.meta.url) embeds the compile-time
 * path (e.g., file:///build/bun-runner.ts) instead of resolving at runtime.
 *
 * Solution: Rewrite the bun-runner.ts at build time to use process.cwd() for
 * module resolution instead of import.meta.url.
 */
import { plugin } from 'bun';

console.info('DEBUG: bun-path-fixer plugin loaded');

// Get the runtime app directory from environment (set in Dockerfile)
const _RUNTIME_APP_DIR = process.env.RUNTIME_APP_DIR || '/app';

plugin({
  name: 'path-fixer',
  setup(build) {
    console.info('DEBUG: path-fixer plugin setup called');

    // Transform the bun-runner.ts to use runtime paths
    build.onLoad({ filter: /bun-runner\.ts$/ }, async (args) => {
      console.info('DEBUG: Transforming bun-runner.ts:', args.path);

      let contents = await Bun.file(args.path).text();

      // Replace createRequire(import.meta.url) with createRequire that uses cwd
      // The key insight: at runtime, the server binary runs from /app with WORKDIR /app
      // So process.cwd() + '/package.json' will give us a valid module resolution base
      contents = contents.replace(
        /const require = createRequire\(import\.meta\.url\);/g,
        `// Patched by bun-path-fixer plugin for runtime path resolution
const require = createRequire(process.cwd() + '/package.json');`,
      );

      // Also patch the dir resolution to use absolute path from env
      // Original: const dir = path.join(process.cwd(), relativeAppDir);
      // This should already work since process.cwd() is /app at runtime

      console.info('DEBUG: bun-runner.ts transformed successfully');

      return {
        contents,
        loader: 'ts',
      };
    });

    // Also resolve react-server-dom-webpack modules that cause issues
    const findNextDist = () => {
      const cwd = process.cwd();
      const candidates = [
        path.join(cwd, 'node_modules', 'next', 'dist'),
        path.resolve(cwd, '../../node_modules', 'next', 'dist'),
      ];
      for (const loc of candidates) {
        if (fs.existsSync(loc)) {
          return loc;
        }
      }
      return null;
    };

    const NEXT_DIST = findNextDist();
    if (NEXT_DIST) {
      const FLIGHT_DIR = path.join(NEXT_DIST, 'compiled/react-server-dom-webpack-experimental/cjs');

      if (fs.existsSync(FLIGHT_DIR)) {
        build.onResolve({ filter: /^react-server-dom-webpack\// }, (args) => {
          console.info('DEBUG: Resolving react-server-dom-webpack:', args.path);
          const baseName = args.path.replace('react-server-dom-webpack/', '');
          const resolved = path.join(
            FLIGHT_DIR,
            `react-server-dom-webpack-${baseName}.production.min.js`,
          );
          if (fs.existsSync(resolved)) {
            return { path: resolved };
          }
          // Fallback to server.node
          return {
            path: path.join(FLIGHT_DIR, 'react-server-dom-webpack-server.node.production.min.js'),
          };
        });
      }
    }
  },
});
