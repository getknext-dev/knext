// Spike (#1166): compile the Next standalone server.js to a single exec.
// Run from the standalone app dir (.next/standalone/apps/<app>).
//
// Two plugin duties:
//  1. STUB Next's dev-only / optional dynamic requires (dead in production).
//  2. REDIRECT the RSC export-condition specifiers to concrete real files —
//     bun --compile applies target=bun, which picks react-dom's "bun" condition
//     (-> server.bun.js, which react-dom 19.2 does not ship) and cannot satisfy
//     react-server-dom-webpack/server (only exported under the "react-server"
//     condition). Redirecting to the real .node.js files bypasses the exports map.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT =
  '/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad/spike-plugin';

const STUB_PATTERNS = [
  /next-dev-server/,
  /setup-dev-bundler/,
  /router-utils\/setup-dev-bundler/,
  /next-devtools/,
  /hot-reloader/,
  /\.development\.js$/,
  /^critters$/,
  // the app uses react-server-dom-webpack; turbopack variant is a dead conditional
  /^react-server-dom-turbopack/,
  // force-dynamic app never prerenders -> no static RSC entry ships
  /react-server-dom-webpack\/static/,
];

// The standalone hoists deps into <standalone>/node_modules/.bun/<name>@<ver>/node_modules/<name>.
const NM = join(process.cwd(), '..', '..', 'node_modules');
function pkgDir(name) {
  const store = join(NM, '.bun');
  const entry = readdirSync(store).find((d) => d.startsWith(`${name}@`));
  if (entry) return join(store, entry, 'node_modules', name);
  return join(NM, name); // fallback: flat layout
}
const RD = pkgDir('react-dom');
const RSW = pkgDir('react-server-dom-webpack');

// specifier -> concrete file (bypasses the broken/condition-gated exports map)
const REDIRECTS = new Map([
  ['react-dom/server', join(RD, 'server.node.js')],
  ['react-dom/server.edge', join(RD, 'server.edge.js')],
  ['react-dom/server.browser', join(RD, 'server.browser.js')],
  ['react-dom/server.node', join(RD, 'server.node.js')],
  ['react-server-dom-webpack/server', join(RSW, 'server.node.js')],
  ['react-server-dom-webpack/server.edge', join(RSW, 'server.node.js')],
  ['react-server-dom-webpack/server.node', join(RSW, 'server.node.js')],
  ['react-server-dom-webpack/client', join(RSW, 'client.node.js')],
  ['react-server-dom-webpack/client.edge', join(RSW, 'client.node.js')],
]);

// A real on-disk empty module — redirecting stubs to a real file avoids the
// virtual-namespace binding quirk ("module_X is not defined") when a dev module
// is imported as a namespace.
import { writeFileSync } from 'node:fs';
const EMPTY =
  '/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad/spike-empty.cjs';
writeFileSync(EMPTY, 'module.exports = new Proxy({}, { get: () => undefined });\n');

const plugin = {
  name: 'spike-next-compile',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const redirect = REDIRECTS.get(args.path);
      if (redirect) return { path: redirect };
      if (STUB_PATTERNS.some((p) => p.test(args.path))) return { path: EMPTY };
      return undefined;
    });
  },
};

const result = await Bun.build({
  entrypoints: ['./server.js'],
  target: 'bun',
  // Pick react/next PRODUCTION code paths at build time so the *.development.js
  // branches are dead-code-eliminated (otherwise the bundler embeds the dev
  // branch and then references the stubbed-out dev module at runtime).
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_RUNTIME': '"nodejs"',
  },
  compile: { outfile: OUT },
  plugins: [plugin],
});

if (!result.success) {
  console.log('BUILD FAILED:');
  for (const m of result.logs) console.log(String(m));
  process.exit(1);
}
console.log('BUILD OK:', result.outputs.map((o) => o.path).join(', '));
