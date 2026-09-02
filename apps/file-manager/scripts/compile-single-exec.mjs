/**
 * Compile the vinext bundle into a single executable, WITH `--bytecode`, and
 * with a working `sharp`.
 *
 * This exists because two independent things break a plain
 * `bun build --compile --bytecode .output/server/index.mjs`, and neither is
 * fixable with a CLI flag. `bun build` has no `--plugin`, so the build moves
 * into a script.
 *
 * ## 1. `--bytecode` cannot compile `import.meta`
 *
 * Bytecode emission targets CommonJS, where `import.meta` is a syntax error. The
 * nitro bundle uses `import.meta.url`, `.filename` and `.dirname` (9 sites),
 * so the build fails with `Failed to generate bytecode for ./index.js`.
 *
 * They are rewritten to the executable's own path. That is the right anchor
 * rather than a convenient one: once the server IS the binary, "this file" is
 * the binary. An earlier attempt used `__filename`, which is undefined in that
 * scope — the binary built and then died at boot inside
 * `pathToFileURL(undefined)`.
 *
 * ## 2. `--compile` cannot resolve `sharp`, and no flag makes it
 *
 * Measured on bun 1.4.0, every resolution route fails inside the binary:
 *
 *   - sharp's own `require('@img/sharp-<platform>/sharp.node')` throws
 *     `Could not load the "sharp" module`;
 *   - `--external sharp` resolves from `/$bunfs/root/`, which has no
 *     `node_modules` above it;
 *   - `--asset=` embeds the `.node` and it is still unusable — the OS cannot
 *     `dlopen` a path inside the binary's virtual filesystem;
 *   - `createRequire(cwd)('sharp')` fails even with sharp and all of its
 *     dependencies top-level in a flat `node_modules` beside the executable,
 *     while the identical call succeeds uncompiled.
 *
 * What works is `process.dlopen` on an absolute real path. So sharp's JavaScript
 * is bundled normally and only its addon stays on disk, loaded by path. The
 * interception happens HERE rather than in `vite.config.ts` because nitro
 * externalizes sharp — `import sharp from "sharp"` survives into
 * `.output/server/index.mjs`, so sharp only enters a module graph at this step.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const APP_DIR = resolve(dirname(new URL(import.meta.url).pathname), '..');
const ENTRY = join(APP_DIR, '.output/server/index.mjs');
const OUTFILE = process.env.KNEXT_EXEC_OUTFILE ?? join(APP_DIR, 'knext-exec');

if (!existsSync(ENTRY)) {
  console.error(`[compile] no vinext bundle at ${ENTRY} — run \`vite build\` first`);
  process.exit(1);
}

/** Rewrites `import.meta.*` so `--bytecode`'s CommonJS output can hold it. */
const importMetaToCjs = {
  name: 'knext-import-meta-to-cjs',
  setup(build) {
    build.onLoad({ filter: /\.output[\\/]server[\\/]index\.mjs$/ }, async (args) => {
      const src = await Bun.file(args.path).text();
      const before = (src.match(/import\.meta\.(url|filename|dirname)/g) ?? []).length;
      const out = src
        .replaceAll('import.meta.filename', 'process.execPath')
        .replaceAll('import.meta.dirname', '(require("node:path").dirname(process.execPath))')
        .replaceAll(
          'import.meta.url',
          '(require("node:url").pathToFileURL(process.execPath).href)',
        );
      const after = (out.match(/import\.meta/g) ?? []).length;
      if (after > 0) {
        // Bytecode would fail anyway; failing here says WHY, and names
        // the form that was not handled.
        const sample = out.match(/import\.meta\.\w+/)?.[0] ?? 'import.meta';
        throw new Error(
          `[compile] ${after} import.meta use(s) survived the rewrite ` +
            `(e.g. ${sample}); --bytecode cannot compile them`,
        );
      }
      console.log(`[compile] rewrote ${before} import.meta use(s) for bytecode`);
      return { contents: out, loader: 'js' };
    });
  },
};

/** Replaces sharp's addon loader with knext's `process.dlopen` shim. */
const sharpAddonDlopen = {
  name: 'knext-sharp-addon-dlopen',
  setup(build) {
    const require = createRequire(import.meta.url);
    // Derived from an EXPORTED sibling: the package's `exports` map does not
    // expose raw `./dist/...` paths, and widening it is a public-surface
    // change this does not need.
    const shim = join(
      dirname(require.resolve('@getknext/core/internal/vinext-image-optimizer')),
      'sharp-addon-dlopen.js',
    );
    if (!existsSync(shim)) {
      throw new Error(`[compile] sharp dlopen shim missing at ${shim}`);
    }
    let replaced = 0;
    build.onLoad({ filter: /[\\/]sharp[\\/]dist[\\/]sharp\.(m|c)?js$/ }, async () => {
      replaced += 1;
      return { contents: await Bun.file(shim).text(), loader: 'js' };
    });
    build.onEnd?.(() => {
      if (replaced === 0) {
        // Silence here would ship a binary whose image optimization is
        // dead — the exact regression this whole path exists to fix.
        throw new Error(
          "[compile] sharp's addon loader was never intercepted; the binary " +
            'would build and then serve unoptimized images',
        );
      }
    });
  },
};

// The compile target must match the RUNTIME image's libc AND architecture.
// Passed in rather than inferred, so the Dockerfile keeps deriving it from
// buildx's TARGETARCH — a default here would be right on exactly one machine,
// which is the bug that shipped an arm64 binary to an amd64 runner.
const compileTarget = process.env.KNEXT_BUN_TARGET?.trim();

const result = await Bun.build({
  entrypoints: [ENTRY],
  target: 'bun',
  plugins: [importMetaToCjs, sharpAddonDlopen],
  minify: true,
  bytecode: true,
  compile: {
    outfile: OUTFILE,
    ...(compileTarget ? { target: compileTarget } : {}),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
console.log(
  `[compile] wrote ${OUTFILE} (bytecode: on, sharp: dlopen shim` +
    `${compileTarget ? `, target: ${compileTarget}` : ''})`,
);
