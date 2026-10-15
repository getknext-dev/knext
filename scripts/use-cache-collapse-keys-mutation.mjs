#!/usr/bin/env node
/**
 * TEETH CHECK for the `'use cache'` two-pod kind e2e, not a mode of the product.
 *
 *   node scripts/use-cache-collapse-keys-mutation.mjs <dir>
 *
 * Rewrites knext's `'use cache'` entry key so every entry of a kind lands on ONE
 * Redis key, whatever Next's cache key (function id + serialized arguments) is:
 *
 *   `${core.keyPrefix()}:uc:${kind}:${cacheKey}`  ->  `${core.keyPrefix()}:uc:${kind}:collapsed`
 *
 * The lane runs it over the staged app's `node_modules/@getknext/core/dist` (the
 * bytes `npm publish` ships), builds and deploys that app, and requires the
 * two-user assertion to go red: user B served user A's entry.
 *
 * Fail-closed: the anchor must occur EXACTLY ONCE across every `.js` file under
 * <dir> (source maps are not code and are skipped). Zero means the handler moved
 * and the leg would go "red" for some unrelated reason; two means a second copy
 * would keep serving correct keys. Either exits 2 without writing anything.
 * tsup renames the parameter when it bundles (`cacheKey` -> `cacheKey2`), so the
 * identifier is matched, not assumed.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ANCHOR =
  /(const entryKey = \((\w+)\) => `\$\{core\.keyPrefix\(\)\}:uc:\$\{kind\}:)\$\{\2\}(`;)/g;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: use-cache-collapse-keys-mutation.mjs <dir>');
  process.exit(2);
}

/** @param {string} d @returns {string[]} */
function jsFiles(d) {
  const out = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.isFile() && /\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of jsFiles(dir)) {
  const text = readFileSync(file, 'utf8');
  const n = [...text.matchAll(ANCHOR)].length;
  for (let i = 0; i < n; i++) hits.push(file);
}

if (hits.length !== 1) {
  console.error(
    `use-cache-collapse-keys-mutation: expected the entry-key anchor exactly once under ${dir}, found ${hits.length}` +
      (hits.length ? ` (${hits.join(', ')})` : ''),
  );
  process.exit(2);
}

const [file] = hits;
const before = readFileSync(file, 'utf8');
const after = before.replace(ANCHOR, '$1collapsed$3');
if (after === before || [...after.matchAll(ANCHOR)].length !== 0) {
  console.error(`use-cache-collapse-keys-mutation: the substitution did not apply in ${file}`);
  process.exit(2);
}
writeFileSync(file, after);
console.log(`use-cache-collapse-keys-mutation: collapsed the 'use cache' entry key in ${file}`);
