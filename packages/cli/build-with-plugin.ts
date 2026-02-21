// Usage: bun run build-with-plugin.ts <entrypoint> <output-filename>
const args = Bun.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: bun run build-with-plugin.ts <entrypoint> <output-filename>');
  process.exit(1);
}

const entrypoint = args[0];
const outputFilename = args[1]; // e.g., "server"

console.info(`🔨 Building and Bundling ${entrypoint} -> ${outputFilename}...`);

// Plugin to wildcard externalize webpack/build dependencies
const ExternalizeWebpack = {
  name: 'ExternalizeWebpack',
  setup(build: any) {
    // Filter for webpack related imports or next build internals
    build.onResolve({ filter: /webpack|next\/dist\/build|critters|loader-utils/ }, (args: any) => {
      // console.info(`   ⛔ Externalizing: ${args.path}`);
      return {
        path: args.path,
        external: true,
      };
    });
  },
};

await Bun.build({
  entrypoints: [entrypoint],
  outdir: './', // Output to current directory
  naming: outputFilename, // "server"
  compile: true, // Single Executable
  target: 'bun-linux-x64', // Cross-compile for Docker (Debian/Linux)
  format: 'esm',
  minify: true, // Minify to reduce size
  sourcemap: 'none',
  plugins: [ExternalizeWebpack],
  // We kept explicit list for non-regex matches if needed, but plugin covers most
  external: [
    'sass',
    'react-server-dom-turbopack',
    'react-server-dom-webpack',
    '@vercel/turbopack-ecmascript-runtime',
    'postcss',
    'sharp',
  ],
  loader: {
    '.js': 'js',
    '.ts': 'ts',
  },
});

console.info(`✅ Build Complete: ${outputFilename}`);
