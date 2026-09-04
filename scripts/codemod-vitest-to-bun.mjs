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

/**
 * `vi.<member>`, tolerating whitespace and newlines between the parts.
 *
 * A formatter breaks long chains — `const stderr = vi\n  .spyOn(…)` is what
 * biome produces — and a `vi\.` pattern silently skips those. The file then
 * converts "cleanly" and fails at runtime with `ReferenceError: vi is not
 * defined`, which names the symptom and not the tool that left it there.
 *
 * Global and stateful (`g` flag): callers must not share the object across
 * loops without resetting `lastIndex`; every use here is a single `matchAll`.
 */
const VI_MEMBER = /\bvi\s*\.\s*([a-zA-Z]+)/g;

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
  // Verified present on bun's `jest` object by probing it directly, not assumed
  // from the jest docs — bun implements a subset and the gaps are the whole
  // reason this table exists.
  ['getTimerCount', 'jest.getTimerCount'],
  ['advanceTimersToNextTimer', 'jest.advanceTimersToNextTimer'],
  ['runOnlyPendingTimers', 'jest.runOnlyPendingTimers'],
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
  // `blankNonCode`, not a hand-rolled comment stripper.
  //
  // The stripper removed comments but left STRING LITERALS, so a file whose
  // strings contain `vi.hoisted(...)` — `tests/codemod-hoisted.test.ts`, which
  // exists to test that very transform — was refused as if it CALLED it, and
  // then silently stayed on vitest. Same defect as the prose case above, one
  // level in. This repo keeps ONE blanker precisely so a fourth hand-rolled
  // tokenizer does not get this wrong again.
  const code = blankNonCode(original);
  if (!/from ['"]vitest['"]/.test(original)) {
    report.untouched.push(file);
    continue;
  }

  const blockers = [...new Set([...code.matchAll(VI_MEMBER)].map((m) => m[1]))].filter((name) =>
    REFUSE.has(name),
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
  src = src
    .replace(/\bvi\s*\.\s*mock\(/g, 'mock.module(')
    .replace(/\bvi\s*\.\s*doMock\(/g, 'mock.module(');

  // AFTER the rename above, not before: this searches for `mock.module(`, and
  // running it first found nothing at all — the files converted "cleanly" and
  // then failed at runtime with "importOriginal is not a function", which is
  // the same symptom as not having the transform.
  src = liftImportOriginal(src);

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
    src = src.replace(new RegExp(`\\bvi\\s*\\.\\s*${from}\\b`, 'g'), to);
  }

  // Anything still spelled `vi.` was not in any table — refuse rather than ship
  // a file with a dangling reference.
  const leftoverCode = blankNonCode(src);
  const leftovers = [...new Set([...leftoverCode.matchAll(VI_MEMBER)].map((m) => m[1]))];
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
      const used = new RegExp(`\\b${needed}\\s*[.(<]`).test(code);
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

/**
 * Port `vi.mock(spec, async (importOriginal) => …)` to bun.
 *
 * bun's `mock.module` factory receives NO arguments, so `importOriginal` is
 * simply undefined and every such file dies with "importOriginal is not a
 * function". The three obvious fixes are all wrong, and each fails differently
 * — which is why this is a codemod rather than a note telling people to do it
 * by hand:
 *
 *  - `await import(spec)` INSIDE the factory DEADLOCKS. The mock is registered
 *    by the time the factory runs, so the import re-enters it and waits on
 *    itself: the file hangs with no output and the runner reports a timeout.
 *  - Capturing the namespace outside and spreading it INSIDE recurses or copies
 *    the mock, because bun mutates the module namespace IN PLACE — by the time
 *    the factory runs, the namespace IS the replacement.
 *  - Spreading eagerly but keeping a live reference has the same problem one
 *    level down.
 *
 * So the real module is imported AND spread into a plain object before
 * `mock.module` is called, and the factory only hands back what is already
 * built.
 */
export function liftImportOriginal(src) {
  const NEEDLE = 'mock.module(';
  let out = src;
  let seq = 0;

  for (;;) {
    const blanked = blankNonCode(out);
    // Find a `mock.module(` whose factory takes `importOriginal`.
    let start = -1;
    for (const m of blanked.matchAll(/mock\.module\(/g)) {
      const open = m.index + NEEDLE.length - 1;
      const close = matchParen(blanked, open);
      if (close === -1) continue;
      // Test the BLANKED text. A string or comment mentioning
      // `(importOriginal)` otherwise selects a call this transform cannot
      // change, and the outer loop re-selects it forever — found by the test
      // for exactly that case, which HUNG rather than failing.
      const call = blanked.slice(m.index, close + 1);
      if (/\(\s*importOriginal\s*\)/.test(call)) {
        start = m.index;
        break;
      }
    }
    if (start === -1) return out;

    const open = start + NEEDLE.length - 1;
    const close = matchParen(blankNonCode(out), open);
    const call = out.slice(start, close + 1);

    const specMatch = call.match(/^mock\.module\(\s*(['"][^'"]+['"])/);
    if (specMatch === null) {
      throw new Error('mock.module with importOriginal but no literal specifier');
    }
    const spec = specMatch[1];

    seq += 1;
    const binding = `__knextReal${seq}`;

    const rewritten = call
      // Consume the wrapping parens of the common spread form so the output
      // reads `...binding` rather than `...(binding)`.
      .replace(/\(\s*await\s+importOriginal\s*(?:<[^>]*>)?\s*\(\s*\)\s*\)/g, binding)
      // …and the bare form, for factories that assign it to a local first.
      .replace(/await\s+importOriginal\s*(?:<[^>]*>)?\s*\(\s*\)/g, binding)
      // Keep `async`. Dropping it saved nothing and broke every factory whose
      // body still awaits something else — `await import("node:module")` inside
      // one of these is common — with `"await" can only be used inside an
      // "async" function`, an error about the transform pointing at the test.
      .replace(/async\s*\(\s*importOriginal\s*\)/, 'async ()');

    // Spread at CAPTURE time, not in the factory: a live namespace reference
    // would resolve to the mock once it is registered.
    if (rewritten === call) {
      // Selected but unchanged means the next iteration selects it again.
      // Refusing loudly beats an infinite loop, which presents as a hung
      // process with no output — the worst thing to diagnose.
      throw new Error(
        `liftImportOriginal selected a mock.module call it could not rewrite: ${call.slice(0, 120)}`,
      );
    }

    const capture = `const ${binding} = { ...(await import(${spec})) };\n`;
    out = out.slice(0, start) + capture + rewritten + out.slice(close + 1);
  }
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchParen(blanked, open) {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === '(') depth++;
    else if (blanked[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
