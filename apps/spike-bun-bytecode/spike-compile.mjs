// Spike (#1166): compile the Next standalone server.js to a single exec,
// stubbing Next's dev-only / optional dynamic requires that bun --compile can't
// prove dead. Run from the standalone app dir.
// Pure dev / optional modules that production never executes — safe to stub so
// bun --compile stops trying to resolve them. NOT react-server-dom/* or
// react-dom/server: those are real production RSC deps (the nft/bun-condition
// layer), left to resolve so we can see if THEY are the remaining wall.
const STUB_PATTERNS = [
  /next-dev-server/,
  /setup-dev-bundler/,
  /router-utils\/setup-dev-bundler/,
  /next-devtools/,
  /\.development\.js$/,
  /^critters$/,
];

const stubPlugin = {
  name: 'stub-next-dev',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (STUB_PATTERNS.some((p) => p.test(args.path))) {
        return { path: args.path, namespace: 'stub' };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'module.exports = {}; export default {};',
      loader: 'js',
    }));
  },
};

const result = await Bun.build({
  entrypoints: ['./server.js'],
  target: 'bun',
  compile: {
    outfile:
      '/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad/spike-plugin',
  },
  plugins: [stubPlugin],
});

if (!result.success) {
  console.log('BUILD FAILED:');
  for (const m of result.logs) console.log(String(m));
  process.exit(1);
}
console.log('BUILD OK:', result.outputs.map((o) => o.path).join(', '));
