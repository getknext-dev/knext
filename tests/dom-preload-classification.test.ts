/**
 * A server-side test must not be handed browser globals (`needsDom`).
 *
 * ## What happened
 *
 * `scripts/bun-test.mjs` gives a test file a DOM preload when it looks like it
 * renders components. The check scanned RAW source, so in
 * `asset-prune.test.ts` — a pure server-side test — it matched a COMMENT:
 *
 *   // deny-list, carries no marker. Aged out of every window.
 *
 * The trailing period made `\bwindow\.` match prose. The file got browser
 * globals; under bun 1.4 that makes pino take its browser branch and throw at
 * first use, failing 22 of 23 tests with a stack inside pino and nothing
 * pointing at the real cause. Fifteen files were misclassified.
 *
 * The runner's own docstring already warned about the outcome — "giving a
 * server-side test a browser global would let a `typeof document` probe take the
 * browser branch, which is exactly the kind of pass that means nothing". A
 * warning is not a guard, which is what this file is for.
 *
 * ## Why both probes, and why neither alone works
 *
 * - Scanning RAW source matches prose. That is the bug above.
 * - Scanning BLANKED source alone breaks the opposite way: `blankNonCode`
 *   blanks string CONTENTS, and a module specifier IS a string, so
 *   `from '@testing-library/react'` stops matching and the real React component
 *   tests silently lose the DOM they need — a failure that looks like a
 *   component bug.
 *
 * So the import is matched with `importsFrom` and the globals against blanked
 * code. This guard asserts both directions, because fixing either one alone
 * reintroduces the other.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import { importsFrom } from '../scripts/lib/test-framework-import.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The runner's rule, restated only so this guard can compare against it. */
function classify(src: string): boolean {
  if (importsFrom(src, '@testing-library/react')) return true;
  return /\bdocument\.|\bwindow\./.test(blankNonCode(src));
}

function testFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

describe('DOM preload classification (`needsDom`)', () => {
  it('the runner uses the two-probe rule, not a raw scan', () => {
    // Asserted against the RUNNER rather than restated here alone: a guard
    // carrying only its own copy of the rule passes while the runner disagrees
    // with it, which is the shape of the bug it exists for.
    const runner = readFileSync(resolve(repoRoot, 'scripts/bun-test.mjs'), 'utf8');
    expect(
      runner,
      'needsDom must match the @testing-library import via `importsFrom` — a raw ' +
        'scan matches prose, and a blanked scan erases the specifier',
    ).toMatch(/importsFrom\(src, '@testing-library\/react'\)/);
    expect(
      runner,
      'needsDom must test document./window. against BLANKED code, so a comment ' +
        'cannot hand a server-side test browser globals',
    ).toMatch(/blankNonCode\(src\)/);
  });

  it('no server-side test is classified as needing the DOM by prose alone', () => {
    // The regression, stated directly: a file whose ONLY `document.`/`window.`
    // is in a comment or a string must not be given browser globals.
    const misled = testFiles()
      .filter((f) => {
        const src = readFileSync(resolve(repoRoot, f), 'utf8');
        if (importsFrom(src, '@testing-library/react')) return false;
        const rawHit = /\bdocument\.|\bwindow\./.test(src);
        const codeHit = /\bdocument\.|\bwindow\./.test(blankNonCode(src));
        return rawHit && !codeHit && classify(src);
      })
      .sort();
    expect(misled, 'these would receive a DOM preload because of prose').toEqual([]);
  });

  it('every React component test still gets the DOM', () => {
    // The other direction, and the reason a blanked-only scan is wrong. A file
    // importing @testing-library/react MUST classify true; if this list ever
    // empties, the assertion is vacuous and the count check below fails first.
    const reactTests = testFiles().filter((f) =>
      importsFrom(readFileSync(resolve(repoRoot, f), 'utf8'), '@testing-library/react'),
    );
    expect(reactTests.length, 'no React component tests found — guard is vacuous').toBeGreaterThan(
      0,
    );
    const lost = reactTests.filter((f) => !classify(readFileSync(resolve(repoRoot, f), 'utf8')));
    expect(
      lost,
      'these import @testing-library/react but would NOT get a DOM preload — the ' +
        'specifier is a string, so a blanked scan erases it',
    ).toEqual([]);
  });

  it('recognises both traps on fixtures', () => {
    // Self-proving, in both directions.
    expect(classify('// Aged out of every window.\nconst x = 1;')).toBe(false);
    expect(classify("import { render } from '@testing-library/react';")).toBe(true);
    expect(classify('document.querySelector("a");')).toBe(true);
  });
});
