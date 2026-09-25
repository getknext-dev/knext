import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * scripts/e2e-native-rebuild-musl.sh (#1257 round 7, techdebt-3 fix) —
 * every REAL `npm ci`/`npm install` invocation in this script must run as
 * the unprivileged `run_as_builder` wrapper, not root — that is the whole
 * point of round 7's non-root fix (see the script's own header). This is a
 * SCAN, not an enumerated list of line numbers: an enumerated list is
 * exactly how the next unguarded call site gets missed (workflow.md's own
 * "prefer scanning to enumerating" rule) — a NEW `npm install`/`npm ci`
 * added later without `run_as_builder` must fail this test, not silently
 * pass because nobody updated a hand-maintained line list.
 *
 * Definitional lines (the function's own docstring/comments mentioning
 * "npm install"/"npm ci" in prose, and the `run_as_builder()` function
 * definition itself) are excluded — only a line that actually INVOKES npm
 * counts.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');

/** Every line that actually INVOKES `npm ci`/`npm install` (not prose mentioning it in a comment, and not the string embedded in run_as_builder's own definition/echo). */
function npmInvocationLines(source: string): { line: number; text: string }[] {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      if (trimmed.startsWith('#')) return false; // comment/prose
      // Must actually invoke `npm ci` or `npm install` as a command word,
      // not merely mention the phrase inside a quoted string (e.g. an echo
      // message) — require it to appear after a command-starting boundary
      // (start of line, `&&`, `;`, `(`, or whitespace) with no quote
      // character immediately before it.
      return /(?:^|[&;(]|\brun_as_builder\b.*?)\s*(?:env\s+\S+=\S+\s+)?npm\s+(ci|install)\b/.test(
        trimmed,
      );
    });
}

describe('every real npm ci/npm install invocation runs via run_as_builder (#1257 round 7)', () => {
  it('finds npm invocation lines at all — the scan must not pass vacuously', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(npmInvocationLines(source).length).toBeGreaterThan(0);
  });

  it('every npm ci/npm install invocation line contains run_as_builder', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const offenders = npmInvocationLines(source).filter(
      ({ text }) => !/\brun_as_builder\b/.test(text),
    );
    expect(offenders).toEqual([]);
  });

  it('the scan itself correctly distinguishes a guarded line from an unguarded one (fixture proof)', () => {
    const guarded = 'if ! (cd x && run_as_builder npm ci --no-audit); then';
    const unguarded = 'if ! (cd x && npm ci --no-audit); then';
    expect(npmInvocationLines(guarded).length).toBe(1);
    expect(npmInvocationLines(unguarded).length).toBe(1);
    expect(npmInvocationLines(guarded)[0].text).toMatch(/run_as_builder/);
    expect(npmInvocationLines(unguarded)[0].text).not.toMatch(/run_as_builder/);
  });

  it('a comment mentioning "npm install" in prose is not counted as an invocation', () => {
    const prose = "  # every `npm install`/`npm ci` call is su-exec'd to that user";
    expect(npmInvocationLines(prose)).toEqual([]);
  });
});
