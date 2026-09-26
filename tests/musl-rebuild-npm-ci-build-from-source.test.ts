import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #1426 — the committed `sqlite3-5.0.2` lockfile now makes
 * `pinned_lockfile_dir_for sqlite3 5.0.2` non-empty, which routes sqlite3
 * through the `run_as_builder npm ci` branch (scripts/e2e-native-rebuild-musl.sh
 * ~:434 and, for the sharp/libvips sibling installer, ~:263) instead of the
 * `npm install` fresh-install fallback. That `npm ci` branch never set
 * `npm_config_build_from_source=true`. CI run 35862123588 (see the script's
 * own ~:457-470 comment) showed why that matters: without the flag, npm's
 * old node-pre-gyp tries a PREBUILT download FIRST and does not check libc
 * at all when picking one — on a network-connected runner it "succeeds" by
 * downloading the GLIBC prebuilt, and `ERR_DLOPEN_FAILED` resurfaces at
 * runtime, unmasked.
 *
 * This is a SCAN, not an enumerated line-number list — workflow.md's own
 * "prefer scanning to enumerating" rule: a NEW `npm ci` invocation added to
 * this script later, for another native corpus package, must fail this test
 * if it lacks the flag, not silently pass because nobody updated a
 * hand-maintained list of line numbers.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');

/** Every line that actually INVOKES `npm ci` (not prose mentioning it in a comment or echo message). */
function npmCiInvocationLines(source: string): { line: number; text: string }[] {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      if (trimmed.startsWith('#')) return false; // comment/prose
      const codePortion = trimmed.split('#')[0] ?? trimmed;
      // Must actually invoke `npm ci` as a command word, not merely mention
      // the phrase inside a quoted string (e.g. an echo message).
      return /(?:^|[&;(]|\brun_as_builder\b.*?)\s*(?:env\s+\S+=\S+\s+)?npm\s+ci\b/.test(
        codePortion,
      );
    });
}

/**
 * Whether an `npm ci` invocation line sets `npm_config_build_from_source=true`
 * — checked against the CODE portion only (everything before an unquoted
 * trailing `#`), so a comment that merely NAMES the flag cannot make an
 * unset line read as set.
 */
function setsBuildFromSource(text: string): boolean {
  const codePortion = text.split('#')[0] ?? text;
  return /\bnpm_config_build_from_source=true\b/.test(codePortion);
}

describe('every npm ci invocation for a native corpus package sets npm_config_build_from_source=true (#1426)', () => {
  it('finds npm ci invocation lines at all — the scan must not pass vacuously', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(npmCiInvocationLines(source).length).toBeGreaterThan(0);
  });

  it('every npm ci invocation line sets npm_config_build_from_source=true', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const offenders = npmCiInvocationLines(source).filter(({ text }) => !setsBuildFromSource(text));
    expect(offenders).toEqual([]);
  });

  it('the scan itself correctly distinguishes a flagged line from an unflagged one (fixture proof)', () => {
    const flagged =
      'if ! (cd x && run_as_builder env npm_config_build_from_source=true npm ci --no-audit); then';
    const unflagged = 'if ! (cd x && run_as_builder npm ci --no-audit); then';
    expect(npmCiInvocationLines(flagged).length).toBe(1);
    expect(npmCiInvocationLines(unflagged).length).toBe(1);
    expect(setsBuildFromSource(npmCiInvocationLines(flagged)[0].text)).toBe(true);
    expect(setsBuildFromSource(npmCiInvocationLines(unflagged)[0].text)).toBe(false);
  });

  it('a comment mentioning "npm ci" in prose is not counted as an invocation', () => {
    const prose = "  # this script runs 'npm ci' against a committed lockfile";
    expect(npmCiInvocationLines(prose)).toEqual([]);
  });

  it('a trailing "# npm_config_build_from_source=true" comment on an otherwise-unflagged line does NOT count as setting it', () => {
    const trickLine =
      'if ! (cd x && run_as_builder npm ci --no-audit); then # npm_config_build_from_source=true';
    const offenders = npmCiInvocationLines(trickLine).filter(
      ({ text }) => !setsBuildFromSource(text),
    );
    expect(offenders.length).toBe(1);
  });

  it('a genuinely flagged line with an UNRELATED trailing comment is still recognized as flagged', () => {
    const flaggedWithComment =
      'if ! (cd x && run_as_builder env npm_config_build_from_source=true npm ci --no-audit); then # some note';
    const offenders = npmCiInvocationLines(flaggedWithComment).filter(
      ({ text }) => !setsBuildFromSource(text),
    );
    expect(offenders.length).toBe(0);
  });
});
