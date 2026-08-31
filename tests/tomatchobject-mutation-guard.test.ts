/**
 * `toMatchObject` + an asymmetric matcher must not be used on a value the test
 * reads afterwards (#881).
 *
 * ## The defect
 *
 * bun's `toMatchObject` MUTATES the received object when the expectation uses an
 * asymmetric matcher. Reproduced in isolation:
 *
 *   const err = Object.assign(new Error('please run npm install first'), { code: 'X' });
 *   typeof err.message;                                     // "string"
 *   expect(err).toMatchObject({ code: 'X', message: expect.stringContaining('npm install') });
 *   typeof err.message;                                     // "object"
 *   String(err.message);                                    // "[object ExpectStringContaining]"
 *
 * The assertion passes. The object under test is then corrupted, so every later
 * assertion on it is meaningless.
 *
 * It failed in the most misleading direction available: in
 * `project-build.test.ts` the next line read `.message.toLowerCase()` and threw,
 * pointing at the code under test when the code was fine and the PREVIOUS
 * assertion had broken it. The silent case is worse — a later `toBe` on the same
 * object compares against a matcher instance and can pass for the wrong reason.
 *
 * ## Why this rule and not a dataflow analysis
 *
 * "Is this object read after the call" needs real dataflow, which #881 said was
 * probably not tractable and which I agree is not worth building here. But the
 * SAFE shape is syntactic and exact: if the received value is an inline
 * expression rather than a variable —
 *
 *   await expect(validateMain(['--zzz'])).rejects.toMatchObject({ … })
 *
 * — then nothing holds a reference to it, so nothing can read it afterwards. The
 * mutation still happens and is harmless. The dangerous shape is the one that
 * binds it first:
 *
 *   const caught = …;
 *   expect(caught).toMatchObject({ message: expect.stringContaining('…') });
 *   caught.message.toLowerCase();   // now a matcher instance
 *
 * So the rule is: with an asymmetric matcher, the receiver must not be a bare
 * identifier. That is checkable, admits every safe use, and rejects exactly the
 * shape that bit.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import { importsFrom } from '../scripts/lib/test-framework-import.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ASYMMETRIC =
  /expect\.(stringContaining|stringMatching|objectContaining|arrayContaining|any|anything)\b/;

/** Every tracked test file that runs under bun — vitest is unaffected. */
function bunTestFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
    .filter((f) => {
      const src = readFileSync(resolve(repoRoot, f), 'utf8');
      return importsFrom(src, 'bun:test');
    });
}

/**
 * `expect(<receiver>)…toMatchObject(` occurrences whose expectation uses an
 * asymmetric matcher AND whose receiver is a bare identifier.
 *
 * Scans blanked source so a matcher name inside a comment or a fixture string
 * cannot produce a finding — the mistake this repo has made in four other
 * scanners.
 */
function unsafeUses(file: string): string[] {
  const code = blankNonCode(readFileSync(resolve(repoRoot, file), 'utf8'));
  const found: string[] = [];

  for (const m of code.matchAll(
    /expect\(\s*([A-Za-z_$][\w$]*)\s*\)([^;]{0,200}?)toMatchObject\(/g,
  )) {
    // The expectation body: from the call to the end of the statement. Bounded
    // rather than paren-matched — an asymmetric matcher appears near the top of
    // the object literal, and an unbounded scan would reach into the NEXT
    // assertion and report a use that is not this one.
    const start = m.index + m[0].length;
    const body = code.slice(start, start + 400);
    if (ASYMMETRIC.test(body)) found.push(m[1]);
  }
  return found;
}

describe('toMatchObject + asymmetric matcher must not bind the receiver (#881)', () => {
  it('finds bun test files at all — the guard must not pass vacuously', () => {
    expect(bunTestFiles().length).toBeGreaterThan(100);
  });

  it('no bun test binds a receiver it then passes to toMatchObject with a matcher', () => {
    const offenders = bunTestFiles()
      .flatMap((f) => unsafeUses(f).map((name) => `${f}: expect(${name})`))
      .sort();
    expect(
      offenders,
      "bun's `toMatchObject` REPLACES a property checked with an asymmetric matcher " +
        'on the RECEIVED object, so anything read from that variable afterwards is a ' +
        'matcher instance rather than the value. Either read what you need BEFORE ' +
        'the call, or pass the value inline — `expect(fn()).toMatchObject(…)` cannot ' +
        'be read afterwards and is safe.',
    ).toEqual([]);
  });

  it('recognises the unsafe shape when it is present', () => {
    // The guard's own subject, proved rather than assumed: without this, a
    // regex that matched nothing would satisfy the assertion above forever.
    const sample = [
      'const caught = boom();',
      "expect(caught).toMatchObject({ message: expect.stringContaining('x') });",
    ].join('\n');
    const tmp = resolve(repoRoot, 'tests/.tomatchobject-guard-sample.tmp.ts');
    try {
      execFileSync('node', [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(tmp)}, ${JSON.stringify(sample)})`,
      ]);
      expect(unsafeUses('tests/.tomatchobject-guard-sample.tmp.ts')).toEqual(['caught']);
    } finally {
      execFileSync('node', ['-e', `try{require('fs').unlinkSync(${JSON.stringify(tmp)})}catch{}`]);
    }
  });

  it('accepts the inline shape, which cannot be read afterwards', () => {
    const sample =
      "await expect(validateMain(['--zzz'])).rejects.toMatchObject({ message: expect.stringContaining('--zzz') });";
    const tmp = resolve(repoRoot, 'tests/.tomatchobject-guard-safe.tmp.ts');
    try {
      execFileSync('node', [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(tmp)}, ${JSON.stringify(sample)})`,
      ]);
      expect(unsafeUses('tests/.tomatchobject-guard-safe.tmp.ts')).toEqual([]);
    } finally {
      execFileSync('node', ['-e', `try{require('fs').unlinkSync(${JSON.stringify(tmp)})}catch{}`]);
    }
  });
});
