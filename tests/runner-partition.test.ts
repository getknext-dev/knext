/**
 * Every test file runs under the ONE runner (#871).
 *
 * The bun migration is finished: vitest is gone, and the whole suite runs under
 * `bun test` via `scripts/bun-test.mjs`. There is no partition left to police —
 * but the failure this guard was written for still exists in a subtler form. A
 * test file that imports NEITHER `bun:test` nor `vitest` (a botched migration, a
 * stray copy) runs nothing when `bun test` loads it, yet nothing else reports
 * that it is empty. And a file that still imports `vitest` cannot run under bun
 * at all — it fails loudly, but with an error that looks like a missing module
 * rather than "this file was never ported".
 *
 * So the invariant is now one-sided and simpler than the old partition: EVERY
 * tracked test file imports `bun:test`, and NONE imports `vitest`.
 *
 * This calls the SAME `importsFrom` the runner (`scripts/bun-test.mjs`, via
 * `needsDom`) and the coverage denominator share — a guard carrying its own copy
 * of the rule passes while the runner disagrees with it, which is the shape of
 * the bug it exists for. Neither a raw scan nor a blanked one works on its own:
 * a raw scan is fooled by a fixture string like `import vitest from "vitest"`
 * (`ts-import-extension-guard.test.ts` still builds one), and a blanked scan
 * never matches because a module specifier IS a string. `importsFrom` handles
 * both by finding candidates in the original and confirming them against the
 * position-preserving blanked copy.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsFrom } from '../scripts/lib/test-framework-import.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every tracked test file, exactly as the runner enumerates them. */
function testFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

interface Claim {
  file: string;
  bun: boolean;
  vitest: boolean;
}

function claims(): Claim[] {
  return testFiles().map((file) => {
    const src = readFileSync(resolve(repoRoot, file), 'utf8');
    return {
      file,
      bun: importsFrom(src, 'bun:test'),
      vitest: importsFrom(src, 'vitest'),
    };
  });
}

describe('every test file runs under bun:test (#871)', () => {
  it('finds test files at all — the guard must not pass vacuously', () => {
    expect(testFiles().length).toBeGreaterThan(100);
  });

  it('every tracked test file imports bun:test', () => {
    // A file that imports neither runner runs nowhere and nothing else notices;
    // this is the silent case the guard exists for.
    const notBun = claims()
      .filter((c) => !c.bun)
      .map((c) => c.file);
    expect(
      notBun,
      'these do not import `bun:test`, so the bun runner collects nothing from them — ' +
        'a migration was left half-done and the file is silently uncovered',
    ).toEqual([]);
  });

  it('no test file still imports vitest', () => {
    // vitest is gone (#871). A file that still imports it cannot run under bun —
    // it fails with a module-resolution error that reads as an environment
    // problem rather than "this was never ported". Catch it here where the
    // message says what it actually is.
    const stillVitest = claims()
      .filter((c) => c.vitest)
      .map((c) => c.file);
    expect(
      stillVitest,
      'these still import `vitest`, which no longer exists in the tree — port them to `bun:test`',
    ).toEqual([]);
  });

  it('the runner reads the shared importsFrom, not a private copy of the rule', () => {
    // A guard carrying its own COPY of the rule passes while the runner disagrees
    // with it. Assert the runner CALLS the shared helper — the same helper this
    // file calls — so the two cannot drift. `scripts/bun-test.mjs` uses it in
    // `needsDom` to decide which files get a DOM preload.
    const bunRunner = readFileSync(resolve(repoRoot, 'scripts/bun-test.mjs'), 'utf8');
    expect(
      bunRunner,
      'scripts/bun-test.mjs must use the shared `importsFrom` rather than its own regex',
    ).toMatch(/importsFrom\(/);
  });
});
