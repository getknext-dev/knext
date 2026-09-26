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

/**
 * Replace every character INSIDE a quoted span (single or double) with a
 * space, keeping the delimiters and the string length unchanged — so an
 * operator or the phrase "npm ci" mentioned inside an echo message's quotes
 * cannot be mistaken for real shell syntax, while every index in the masked
 * string still lines up with the same index in the original.
 */
function maskQuotedSpans(text: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (const ch of text) {
    if (quote) {
      out += ch === quote ? ch : ' ';
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Split a line's CODE portion into individual shell statements on unquoted
 * `;`, `&&`, and `||` — ported/adapted from #1415's quote-aware statement
 * splitter. A lone `&` or `|` is deliberately NOT a split point here: this
 * script's real invocations end in `2>&1` (a redirect, not a background
 * operator), and splitting on a bare `&` would sever the
 * `npm_config_build_from_source=true` prefix from the `npm ci` it guards on
 * every real call site. Returns [{ original, masked }] pairs so callers can
 * regex-match on the masked (quote-blind) text while still reporting the
 * real source text.
 */
function splitUnquotedStatements(codeOriginal: string): { original: string; masked: string }[] {
  const codeMasked = maskQuotedSpans(codeOriginal);
  const statements: { original: string; masked: string }[] = [];
  let start = 0;
  let i = 0;
  while (i < codeMasked.length) {
    const ch = codeMasked[i];
    if (ch === ';') {
      statements.push({
        original: codeOriginal.slice(start, i),
        masked: codeMasked.slice(start, i),
      });
      i += 1;
      start = i;
      continue;
    }
    if ((ch === '&' && codeMasked[i + 1] === '&') || (ch === '|' && codeMasked[i + 1] === '|')) {
      statements.push({
        original: codeOriginal.slice(start, i),
        masked: codeMasked.slice(start, i),
      });
      i += 2;
      start = i;
      continue;
    }
    i += 1;
  }
  statements.push({ original: codeOriginal.slice(start), masked: codeMasked.slice(start) });
  return statements;
}

/** Every STATEMENT that actually INVOKES `npm ci`/`npm clean-install`/`npm install-clean`
 * (not prose mentioning it in a comment or inside a quoted echo message, and not a
 * sibling statement on the same line that merely sets an env var for a DIFFERENT
 * command — e.g. `npm_config_build_from_source=true true && run_as_builder npm ci`). */
function npmCiInvocationLines(source: string): { line: number; text: string }[] {
  const results: { line: number; text: string }[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('#')) continue; // comment/prose

    // Drop a trailing `#...` comment, but only an UNQUOTED one.
    const maskedLine = maskQuotedSpans(rawLine);
    const hashIdx = maskedLine.indexOf('#');
    const codeOriginal = hashIdx === -1 ? rawLine : rawLine.slice(0, hashIdx);

    for (const { original, masked } of splitUnquotedStatements(codeOriginal)) {
      // Must actually invoke npm ci/clean-install as a command word, not
      // merely mention the phrase inside a quoted string — matched against
      // the MASKED statement so quoted content can never satisfy this.
      if (/\bnpm\s+(ci|clean-install|install-clean)\b/.test(masked)) {
        results.push({ line: i + 1, text: original });
      }
    }
  }
  return results;
}

/**
 * Whether an `npm ci` invocation STATEMENT sets `npm_config_build_from_source=true`
 * as an assignment PREFIX of that same statement's `npm` command — checked
 * against the masked (quote-blind) text, so a comment or quoted string that
 * merely NAMES the flag cannot make an unset statement read as set, and a
 * flag set on a different statement (split on `;`/`&&`/`||`) never leaks
 * across the boundary. Position-checked, not just substring-present: a shell
 * env assignment only takes effect when it PRECEDES the command word, so
 * `npm ci npm_config_build_from_source=true` (the flag trailing as a bare
 * argument, not a leading assignment) must not read as flagged.
 */
function setsBuildFromSource(text: string): boolean {
  const masked = maskQuotedSpans(text);
  const flagMatch = masked.match(/\bnpm_config_build_from_source=true\b/);
  if (!flagMatch || flagMatch.index === undefined) return false;
  const invocationMatch = masked.match(/\bnpm\s+(ci|clean-install|install-clean)\b/);
  if (!invocationMatch || invocationMatch.index === undefined) return true;
  return flagMatch.index < invocationMatch.index;
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

  /**
   * jev 0.90 — the OLD regex only matched `npm ci` after `^`, `[&;(]`, or
   * `run_as_builder`, so each of these five bypasses invoked `npm ci`
   * (or an alias of it) WITHOUT the flag and stayed green: the scan never
   * even counted them as invocations, so they never reached the offender
   * check at all. One fixture per distinct gap, each proven as BOTH "this is
   * counted as an invocation" and "this is correctly flagged as an offender"
   * — a scan that silently drops these back to zero invocations would pass
   * the old (wrong) test again.
   */
  describe('bypasses that the old anchored regex missed entirely (jev 0.90)', () => {
    it('"if ! npm ci" — no [&;(]/run_as_builder prefix immediately before npm', () => {
      const line = 'if ! npm ci';
      expect(npmCiInvocationLines(line).length).toBe(1);
      const offenders = npmCiInvocationLines(line).filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });

    it('"su-exec builder:builder npm ci" — a raw su-exec invocation, not the run_as_builder wrapper word', () => {
      const line = 'su-exec builder:builder npm ci';
      expect(npmCiInvocationLines(line).length).toBe(1);
      const offenders = npmCiInvocationLines(line).filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });

    it('"npm clean-install" — the long-form alias of `npm ci` never matched the `ci`-only regex', () => {
      const line = 'npm clean-install';
      expect(npmCiInvocationLines(line).length).toBe(1);
      const offenders = npmCiInvocationLines(line).filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });

    it('"env HOME=/x A=1 npm ci" — more than one env assignment before npm defeated the single-assignment env group', () => {
      const line = 'env HOME=/x A=1 npm ci';
      expect(npmCiInvocationLines(line).length).toBe(1);
      const offenders = npmCiInvocationLines(line).filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });

    it('"npm_config_build_from_source=true true && run_as_builder npm ci" — the flag is an assignment prefix of a DIFFERENT statement\'s command', () => {
      const line = 'npm_config_build_from_source=true true && run_as_builder npm ci';
      const invocations = npmCiInvocationLines(line);
      expect(invocations.length).toBe(1);
      // The one invocation found must be the `run_as_builder npm ci` statement,
      // not the `npm_config_build_from_source=true true` statement — proving
      // the flag-bearing statement is not itself mistaken for an invocation.
      expect(invocations[0].text).toMatch(/run_as_builder npm ci/);
      const offenders = invocations.filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });

    it('"npm ci npm_config_build_from_source=true" — the flag TRAILS the command, so it is a bare argument, not a leading env assignment', () => {
      const line = 'npm ci npm_config_build_from_source=true';
      const invocations = npmCiInvocationLines(line);
      expect(invocations.length).toBe(1);
      const offenders = invocations.filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });
  });
});
