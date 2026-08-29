#!/usr/bin/env node

/**
 * Port test files from vitest to `bun:test`.
 *
 * Mechanical only, and deliberately conservative: anything it cannot convert
 * with confidence it REFUSES and reports, rather than guessing. A codemod that
 * half-converts a mock is worse than one that skips the file, because the
 * result still runs — against the real module.
 *
 * Mapping (bun's own API, not a compatibility layer):
 *
 *   vi.fn                     -> mock
 *   vi.spyOn                  -> spyOn
 *   vi.mock / vi.doMock       -> mock.module
 *   vi.clearAllMocks          -> jest.clearAllMocks
 *   vi.restoreAllMocks        -> jest.restoreAllMocks
 *   vi.useFakeTimers          -> jest.useFakeTimers
 *   vi.useRealTimers          -> jest.useRealTimers
 *   vi.setSystemTime          -> setSystemTime
 *   vi.hoisted(fn)            -> fn()          (bun does not hoist)
 *   vi.stubEnv/unstubAllEnvs  -> helpers
 *   vi.waitFor                -> helper
 *   vi.advanceTimersByTimeAsync / runAllTimersAsync -> helpers
 *
 * REFUSED (needs a human):
 *   vi.resetModules  — bun has no module-registry reset. Tests relying on a
 *                      fresh module per case need an explicit reset export.
 *   vi.doUnmock      — no equivalent.
 *
 * Usage: node scripts/codemod-vitest-to-bun.mjs <path...> [--write]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const targets = args.filter((a) => !a.startsWith('--'));

const files = execFileSync('git', ['ls-files', ...(targets.length ? targets : ['.'])], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((f) => /\.test\.tsx?$/.test(f));

/** Direct identifier swaps, applied to `vi.<name>` call sites. */
const DIRECT = new Map([
  ['fn', 'mock'],
  ['spyOn', 'spyOn'],
  ['clearAllMocks', 'jest.clearAllMocks'],
  ['resetAllMocks', 'jest.restoreAllMocks'],
  ['restoreAllMocks', 'jest.restoreAllMocks'],
  ['useFakeTimers', 'jest.useFakeTimers'],
  ['useRealTimers', 'jest.useRealTimers'],
  ['setSystemTime', 'setSystemTime'],
  ['advanceTimersByTime', 'jest.advanceTimersByTime'],
  ['runAllTimers', 'jest.runAllTimers'],
]);

/** Provided by tests/helpers/bun-test-helpers.ts. */
const HELPERS = new Map([
  ['stubEnv', 'stubEnv'],
  ['unstubAllEnvs', 'unstubAllEnvs'],
  ['waitFor', 'waitFor'],
  ['advanceTimersByTimeAsync', 'advanceTimersByTimeAsync'],
  ['runAllTimersAsync', 'runAllTimersAsync'],
]);

/** No bun equivalent — the codemod will not pretend otherwise. */
const REFUSE = new Set(['resetModules', 'doUnmock']);

const report = { converted: [], refused: [], untouched: [] };

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  // Strip comments before looking for blockers. A file that merely MENTIONS
  // `vi.resetModules` in prose — several do, explaining what survives it — was
  // being refused as if it called it, and then silently stayed on vitest. Under
  // `bun test` that means `vi.mock` never registers and the test dials the real
  // dependency: one such file spent 8 seconds per case talking to a real
  // Postgres before failing.
  const code = original.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (!/from ['"]vitest['"]/.test(original)) {
    report.untouched.push(file);
    continue;
  }

  const blockers = [...new Set([...code.matchAll(/vi\.([a-zA-Z]+)/g)].map((m) => m[1]))].filter(
    (name) => REFUSE.has(name),
  );
  if (blockers.length > 0) {
    report.refused.push({ file, blockers });
    continue;
  }

  let src = original;
  const helpersUsed = new Set();

  // vi.hoisted(fn) -> fn() — bun evaluates in place, so hoisting is moot.
  src = src.replace(/vi\.hoisted\(/g, '(');

  // Module mocks.
  src = src.replace(/\bvi\.mock\(/g, 'mock.module(').replace(/\bvi\.doMock\(/g, 'mock.module(');

  // Helper-backed calls.
  for (const [from, to] of HELPERS) {
    const re = new RegExp(`\\bvi\\.${from}\\(`, 'g');
    if (re.test(src)) {
      helpersUsed.add(to);
      src = src.replace(re, `${to}(`);
    }
  }

  // Direct swaps.
  for (const [from, to] of DIRECT) {
    src = src.replace(new RegExp(`\\bvi\\.${from}\\b`, 'g'), to);
  }

  // Anything still spelled `vi.` was not in any table — refuse rather than ship
  // a file with a dangling reference.
  const leftoverCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const leftovers = [...new Set([...leftoverCode.matchAll(/vi\.([a-zA-Z]+)/g)].map((m) => m[1]))];
  if (leftovers.length > 0) {
    report.refused.push({ file, blockers: leftovers });
    continue;
  }

  // Rewrite the import. `vi` is dropped; whatever bun primitives the file now
  // uses are added.
  src = src.replace(/import\s*\{([^}]*)\}\s*from\s*['"]vitest['"];?/, (_match, names) => {
    const kept = names
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n && n !== 'vi');
    for (const needed of ['mock', 'spyOn', 'jest', 'setSystemTime']) {
      const used = new RegExp(`\\b${needed}\\b`).test(src);
      if (used && !kept.includes(needed)) kept.push(needed);
    }
    return `import { ${kept.sort().join(', ')} } from 'bun:test';`;
  });

  if (helpersUsed.size > 0) {
    const rel = relativeHelperPath(file);
    src = src.replace(
      /(import \{[^}]*\} from 'bun:test';)/,
      `$1\nimport { ${[...helpersUsed].sort().join(', ')} } from '${rel}';`,
    );
  }

  if (src !== original) {
    if (write) writeFileSync(file, src);
    report.converted.push(file);
  } else {
    report.untouched.push(file);
  }
}

/** Path from a test file back to tests/helpers/bun-test-helpers. */
function relativeHelperPath(file) {
  const depth = file.split('/').length - 1;
  return `${'../'.repeat(depth)}tests/helpers/bun-test-helpers`;
}

console.log(`${write ? 'CONVERTED' : 'WOULD CONVERT'}: ${report.converted.length}`);
console.log(`REFUSED (need a human): ${report.refused.length}`);
console.log(`untouched: ${report.untouched.length}\n`);

const byBlocker = new Map();
for (const { blockers } of report.refused) {
  for (const b of blockers) byBlocker.set(b, (byBlocker.get(b) ?? 0) + 1);
}
for (const [name, count] of [...byBlocker].sort((a, b) => b[1] - a[1])) {
  console.log(`  vi.${name}: ${count} file(s)`);
}
