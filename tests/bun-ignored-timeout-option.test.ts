/**
 * bun SILENTLY IGNORES `describe(name, { timeout }, fn)`.
 *
 * ## What was measured
 *
 * bun accepts the three-argument form without complaint and drops the options
 * object on the floor. Reproduced in isolation:
 *
 *   describe('x', { timeout: 50 }, () => {
 *     it('sleeps 400ms', async () => { await sleep(400); });
 *   });
 *   // 1 pass, 0 fail — the 50ms timeout was never applied.
 *
 * Compare the form bun DOES honour:
 *
 *   setDefaultTimeout(50);
 *   it('sleeps 400ms', ...)   // (fail) this test timed out after 50ms
 *
 * ## Why this is not a style rule
 *
 * The form is vitest's, so it survived the migration looking correct. Nine
 * sites across five files declared 30s or 60s suite timeouts — the e2e deploy
 * contract, the bytecode build, the compile-cache health check, all of them
 * slow by nature — and every one was actually running under bun's 5s default.
 *
 * A test suite whose declared timeout is silently a twelfth of what it says is
 * the worst kind of flake: it passes on a fast machine and fails in CI for a
 * reason the source flatly contradicts. Nothing else in the suite reports it,
 * because from bun's point of view nothing is wrong.
 *
 * TypeScript catches this ONLY since `@types/bun` was added to the typecheck
 * config — it reads `Expected 1-2 arguments, but got 3`. That is worth having,
 * but it is not sufficient: the typecheck config's `include` covers `tests/`
 * and not `packages/**` or `apps/**`, and three of the nine sites were in
 * `packages/`. This guard scans every bun test file regardless of which
 * tsconfig claims it.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import { importsFrom } from '../scripts/lib/test-framework-import.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `describe|it|test( <string literal>, { … timeout … }` — the options object
 * passed where bun expects the body.
 *
 * Anchored on the string-literal title so it cannot match `describe.each(...)`
 * or a call whose second argument is a legitimate object. Scans blanked source
 * so the example in this file's own header — which contains the exact bad
 * shape — cannot be reported as a finding.
 */
const IGNORED_OPTIONS =
  /\b(?:describe|it|test)\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*,\s*\{[^{}]*\btimeout\b/g;

/** Every tracked test file that runs under bun. vitest honours the form. */
function bunTestFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
    .filter((f) => importsFrom(readFileSync(resolve(repoRoot, f), 'utf8'), 'bun:test'));
}

function ignoredTimeoutOptions(source: string): number {
  // The regex spans newlines only through `\s*`, which is what the real sites
  // look like after formatting — the title and the object land on their own
  // lines.
  return [...blankNonCode(source).matchAll(IGNORED_OPTIONS)].length;
}

describe('bun silently ignores `describe(name, { timeout }, fn)`', () => {
  it('finds bun test files at all — the guard must not pass vacuously', () => {
    expect(bunTestFiles().length).toBeGreaterThan(100);
  });

  it('no bun test passes a timeout bun will drop', () => {
    const offenders = bunTestFiles()
      .map((f) => ({ f, n: ignoredTimeoutOptions(readFileSync(resolve(repoRoot, f), 'utf8')) }))
      .filter(({ n }) => n > 0)
      .map(({ f, n }) => `${f} (${n} site${n === 1 ? '' : 's'})`)
      .sort();
    expect(
      offenders,
      'bun ACCEPTS this vitest form and drops the options object, so the suite runs ' +
        "under bun's 5s default rather than the timeout it declares. Use " +
        '`setDefaultTimeout(ms)` at module scope — and put the call BELOW the `const` ' +
        'it reads, because a `const` is not hoisted.',
    ).toEqual([]);
  });

  it('recognises the ignored shape when it is present', () => {
    // Self-proving: without this, a regex that matched nothing would satisfy
    // the assertion above forever.
    expect(
      ignoredTimeoutOptions("describe(\n  'x',\n  { timeout: 30_000 },\n  () => {},\n);"),
    ).toBe(1);
    expect(ignoredTimeoutOptions("it('x', { timeout: 5 }, () => {});")).toBe(1);
  });

  it('accepts the forms bun actually honours', () => {
    // `setDefaultTimeout` at module scope, and bun's positional per-test
    // timeout — neither is a finding.
    expect(ignoredTimeoutOptions('setDefaultTimeout(30_000);')).toBe(0);
    expect(ignoredTimeoutOptions("it('x', async () => {}, 30_000);")).toBe(0);
    // A second argument that is an object but carries no timeout is unrelated.
    expect(ignoredTimeoutOptions("describe('x', { each: 1 }, () => {});")).toBe(0);
  });
});
