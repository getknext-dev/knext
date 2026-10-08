#!/usr/bin/env node
/**
 * Mutation-prove both `nextRoute` branches in cache-handler.js by EXIT CODE.
 *   1. older-Next branch: `key.replace(...) || '/'` -> `return key;`
 *   2. 16.3.7+ branch:    `if (key.startsWith('/route-cache/')) return key;` removed
 * Each anchor must occur exactly once or the script aborts. The source is
 * always restored. Exit 0 only when baseline is green and every mutant is red.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'packages/kn-next/src/adapters/cache-handler.js';
const TEST = 'packages/kn-next/src/__tests__/cache-handler-next-stale-after-wake.test.ts';
const MUTANTS = [
  {
    name: 'older-Next toRoute branch',
    anchor: "  return key.replace(/(?:\\/index)?\\/?$/, '') || '/';",
    replacement: '  return key;',
  },
  {
    name: '/route-cache/ verbatim branch',
    anchor: "  if (key.startsWith('/route-cache/')) return key;",
    replacement: '',
  },
];

const run = () => spawnSync('bun', ['test', TEST], { stdio: 'ignore' }).status;
const original = readFileSync(SRC, 'utf8');
let failed = false;
try {
  const base = run();
  console.log(`baseline exit=${base}`);
  if (base !== 0) throw new Error('baseline not green');
  for (const m of MUTANTS) {
    const n = original.split(m.anchor).length - 1;
    if (n !== 1) throw new Error(`anchor for "${m.name}" occurs ${n}x, expected 1`);
    writeFileSync(
      SRC,
      original.replace(m.anchor, () => m.replacement),
    );
    const code = run();
    writeFileSync(SRC, original);
    const caught = code !== 0;
    console.log(`${caught ? 'CAUGHT' : 'DECORATIVE'} ${m.name} exit=${code}`);
    if (!caught) failed = true;
  }
} catch (e) {
  console.error(String(e));
  failed = true;
} finally {
  writeFileSync(SRC, original);
}
process.exit(failed ? 1 : 0);
