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
import { blankNonCode } from './lib/blank-non-code.mjs';

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

  // vi.hoisted(fn) -> (fn)() — bun evaluates in place, so hoisting is moot.
  //
  // The previous version replaced `vi.hoisted(` with `(` and stopped, which left
  // the ARROW rather than its result: `vi.hoisted(() => ({ a: 1 }))` became
  // `(() => ({ a: 1 }))`, so every read of `x.a` was `undefined` on a function
  // object. It failed far from here, as a TypeError inside an event handler.
  // Appending the call needs the matching close paren, which a regex cannot find.
  src = callHoisted(src);

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
    // Probe CODE only, and require the identifier to be CALLED or dereferenced.
    //
    // A bare `\\bjest\\b` over the raw source matched `@testing-library/jest-dom`
    // — an import path — and added an unused `jest` import to every file that
    // merely mentioned it, which biome then failed. Two separate mistakes, both
    // of the kind this repo keeps re-learning: probing prose as if it were code,
    // and matching a name where only a usage counts.
    const code = blankNonCode(src);
    for (const needed of ['mock', 'spyOn', 'jest', 'setSystemTime']) {
      const used = new RegExp(`\\b${needed}\\s*[.(]`).test(code);
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

/**
 * Rewrite every `vi.hoisted(<expr>)` to `(<expr>)()`.
 *
 * Scans for the matching close paren rather than pattern-matching the argument,
 * because the argument is an arbitrary expression — arrow bodies here contain
 * parens, braces, generics and strings. Depth counting over a
 * comment-and-string-blanked copy is enough, and it is the same technique the
 * repo's other scanners use rather than a fourth hand-rolled tokenizer.
 */
export function callHoisted(src) {
  const NEEDLE = 'vi.hoisted(';
  let out = src;
  for (;;) {
    const blanked = blankNonCode(out);
    const start = blanked.indexOf(NEEDLE);
    if (start === -1) return out;
    const open = start + NEEDLE.length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < blanked.length; i++) {
      const ch = blanked[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) {
      // Unbalanced source: leave it alone rather than emit something broken.
      // Refusing loudly beats a silent half-transform.
      throw new Error(`unbalanced vi.hoisted( at offset ${start}`);
    }
    out = `${out.slice(0, start)}(${out.slice(open + 1, close)})()${out.slice(close + 1)}`;
  }
}
