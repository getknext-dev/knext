// e1-rewrite.mjs <dist-dir>
// Post-build rewrite of vinext's emitted dist/server/index.js:
// convert BOTH lazy `import(`./ssr/index.js`)` call sites into a MODULE-SCOPE
// top-level static import in that same file, with the loaders returning the
// already-bound namespace.
// Asserts every anchor occurs EXACTLY once and aborts otherwise (no silent
// no-op substitutions -- workflow.md "never mutate with perl" rule).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2];
const file = join(dist, 'server', 'index.js');
let src = readFileSync(file, 'utf8');

const count = (s, needle) => s.split(needle).length - 1;

const anchors = [
  {
    name: 'ssrLoader',
    from: 'ssrLoader(){return import(`./ssr/index.js`)}',
    to: 'ssrLoader(){return Promise.resolve(__knext_ssr_ns)}',
  },
  {
    name: 'loadSsrHandler',
    from: 'loadSsrHandler(){return import(`./ssr/index.js`)}',
    to: 'loadSsrHandler(){return Promise.resolve(__knext_ssr_ns)}',
  },
];

for (const a of anchors) {
  const n = count(src, a.from);
  if (n !== 1) throw new Error(`anchor ${a.name}: expected exactly 1 occurrence, found ${n}`);
  src = src.replace(a.from, a.to);
}

const marker = '/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */\n';
const nm = count(src, marker);
if (nm !== 1) throw new Error(`insertion marker: expected exactly 1 occurrence, found ${nm}`);
src = src.replace(marker, `${marker}import * as __knext_ssr_ns from "./ssr/index.js";\n`);

// post-conditions
if (count(src, 'import(`./ssr/index.js`)') !== 0)
  throw new Error('a lazy import of ./ssr/index.js survived the rewrite');
if (count(src, 'import * as __knext_ssr_ns from "./ssr/index.js";') !== 1)
  throw new Error('static import not inserted exactly once');

writeFileSync(file, src);
console.log(`rewrote ${file}`);
console.log(`  lazy import() call sites remaining : 0`);
console.log(`  top-level static imports inserted  : 1`);
