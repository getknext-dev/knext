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
 * `;`, `&&`, `||`, a lone (non-redirect) `&` or `|`, and the CONTENTS of any
 * `$( ... )` command substitution — ported/adapted from #1415's quote-aware
 * statement splitter, extended per round-3 review (jev 0.90 gap: a bare `&`
 * backgrounds a command, a bare `|` pipes into a new one, and a command
 * substitution runs its contents as an independent word-expansion step —
 * none of the three inherits an outer prefix-assignment like
 * `npm_config_build_from_source=true`, so each must be scored as its OWN
 * statement, not folded into the one that happens to precede it textually).
 *
 * The lone `&`/`|` split deliberately excludes REDIRECT forms (`2>&1`,
 * `&>out`) — those are not job-control operators, and this script's real
 * invocations end in `2>&1`. A `&` is treated as a redirect, not a split
 * point, when the character immediately before or after it is `>` (`>&`,
 * `&>`, or the digit-prefixed `2>&1`); a `|` is always a real pipe once
 * `||` has already been ruled out above it.
 *
 * `$( ... )` contents are extracted (recursively, so a nested substitution
 * is scored as its own statement too) and BLANKED OUT of the outer text
 * (same length, so indices stay aligned) before the outer text is split —
 * so an outer statement's own scan can never re-match an invocation that
 * actually lives inside the substitution's independent scope.
 *
 * Returns [{ original, masked }] pairs so callers can regex-match on the
 * masked (quote-blind) text while still reporting the real source text.
 */
function splitUnquotedStatements(codeOriginal: string): { original: string; masked: string }[] {
  const statements: { original: string; masked: string }[] = [];

  // Extract `$( ... )` spans first — matching depth against the MASKED text
  // (quote interiors already blanked, so a `(`/`)` inside a quoted string
  // never perturbs paren counting), recursing into their contents, then
  // blanking the whole span (same length) out of the working text.
  let workingOriginal = codeOriginal;
  let workingMasked = maskQuotedSpans(codeOriginal);
  {
    let i = 0;
    while (i < workingMasked.length - 1) {
      if (workingMasked[i] === '$' && workingMasked[i + 1] === '(') {
        let depth = 1;
        let j = i + 2;
        while (j < workingMasked.length && depth > 0) {
          if (workingMasked[j] === '(') depth += 1;
          else if (workingMasked[j] === ')') depth -= 1;
          j += 1;
        }
        const innerOriginal = workingOriginal.slice(i + 2, depth === 0 ? j - 1 : j);
        statements.push(...splitUnquotedStatements(innerOriginal));
        const blankLen = (depth === 0 ? j : j) - i;
        const blank = ' '.repeat(blankLen);
        workingOriginal = workingOriginal.slice(0, i) + blank + workingOriginal.slice(i + blankLen);
        workingMasked = workingMasked.slice(0, i) + blank + workingMasked.slice(i + blankLen);
        i += blankLen;
        continue;
      }
      i += 1;
    }
  }

  const isRedirectAmpersand = (masked: string, idx: number): boolean =>
    masked[idx - 1] === '>' || masked[idx + 1] === '>';

  let start = 0;
  let i = 0;
  while (i < workingMasked.length) {
    const ch = workingMasked[i];
    if (ch === ';') {
      statements.push({
        original: workingOriginal.slice(start, i),
        masked: workingMasked.slice(start, i),
      });
      i += 1;
      start = i;
      continue;
    }
    if (
      (ch === '&' && workingMasked[i + 1] === '&') ||
      (ch === '|' && workingMasked[i + 1] === '|')
    ) {
      statements.push({
        original: workingOriginal.slice(start, i),
        masked: workingMasked.slice(start, i),
      });
      i += 2;
      start = i;
      continue;
    }
    if (ch === '&' && !isRedirectAmpersand(workingMasked, i)) {
      statements.push({
        original: workingOriginal.slice(start, i),
        masked: workingMasked.slice(start, i),
      });
      i += 1;
      start = i;
      continue;
    }
    if (ch === '|') {
      statements.push({
        original: workingOriginal.slice(start, i),
        masked: workingMasked.slice(start, i),
      });
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  statements.push({ original: workingOriginal.slice(start), masked: workingMasked.slice(start) });
  return statements;
}

/**
 * Matches an `npm` invocation of the `ci` subcommand under ANY of its
 * aliases (`ci`, `ic`, `cit`, `clean-install`, `install-clean`) — round-3
 * gap (:116): the previous `(ci|clean-install|install-clean)` alternation
 * required the subcommand to sit DIRECTLY after `npm`, so an option
 * inserted between them (`npm --prefix x ci`) was never counted as an
 * invocation at all. `(?:\s+\S+)*?` (non-greedy) absorbs any number of
 * npm-level options/values before the subcommand word, so the subcommand
 * can appear anywhere later in the same statement.
 */
const NPM_CI_RE = /\bnpm\b(?:\s+\S+)*?\s+(ci|ic|cit|clean-install|install-clean)\b/;

/** Every STATEMENT that actually INVOKES `npm ci` or one of its aliases
 * (`ic`, `cit`, `clean-install`, `install-clean`), optionally with npm-level
 * options ahead of the subcommand (`npm --prefix x ci`) — not prose
 * mentioning it in a comment or inside a quoted echo message, and not a
 * sibling statement on the same line that merely sets an env var for a
 * DIFFERENT command — e.g. `npm_config_build_from_source=true true &&
 * run_as_builder npm ci`). */
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
      if (NPM_CI_RE.test(masked)) {
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
 *
 * The flag match requires an EXACT `=true` token (:137 gap): a trailing
 * `\b` word boundary after `true` is satisfied by ANY non-word character —
 * including `-`, so `npm_config_build_from_source=true-ish` (a different,
 * truthy-looking but not-actually-`true` value) used to read as flagged.
 * The lookahead below requires whatever follows `true` (if anything) to be
 * whitespace or a shell statement/redirect terminator, never a value byte.
 */
function setsBuildFromSource(text: string): boolean {
  const masked = maskQuotedSpans(text);
  const flagMatch = masked.match(/\bnpm_config_build_from_source=true(?=[\s;&|)"']|$)/);
  if (!flagMatch || flagMatch.index === undefined) return false;
  const invocationMatch = masked.match(NPM_CI_RE);
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

  /**
   * Round-3 review — three MORE distinct bypasses of the (now jev-0.90-fixed)
   * scan, each mutation-proved against its own single anchor: reverting just
   * that one fix reds exactly its fixture below, restoring the file greens
   * it again. One fixture per rule, per workflow.md's mutation-proof rule.
   */
  describe('round-3 bypasses (npm-ci-build-from-source review)', () => {
    it('"npm --prefix x ci" — an npm-level option inserted between `npm` and the subcommand defeated the direct-adjacency regex (:116)', () => {
      const line = 'npm --prefix x ci';
      expect(npmCiInvocationLines(line).length).toBe(1);
      const offenders = npmCiInvocationLines(line).filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });

    it('"npm ic" and "npm cit" — the `ic`/`cit` aliases of `npm ci` were never in the subcommand alternation (:116)', () => {
      for (const line of ['npm ic', 'npm cit']) {
        expect(npmCiInvocationLines(line).length).toBe(1);
        const offenders = npmCiInvocationLines(line).filter(
          ({ text }) => !setsBuildFromSource(text),
        );
        expect(offenders.length).toBe(1);
      }
    });

    it('an npm-level option AND an alias together are still correctly recognized as FLAGGED when the assignment leads', () => {
      const line = 'npm_config_build_from_source=true npm --prefix x ic';
      const invocations = npmCiInvocationLines(line);
      expect(invocations.length).toBe(1);
      expect(setsBuildFromSource(invocations[0].text)).toBe(true);
    });

    it('"FLAG=true true | npm ci" — a real pipe was not a split point, so the flag on the PIPED-FROM command leaked onto npm ci (:80)', () => {
      const line = 'npm_config_build_from_source=true true | npm ci';
      const invocations = npmCiInvocationLines(line);
      expect(invocations.length).toBe(1);
      expect(invocations[0].text.trim()).toBe('npm ci');
      const offenders = invocations.filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });

    it('"FLAG=true sleep 1 & npm ci" — a bare backgrounding `&` was not a split point, so the flag on the BACKGROUNDED command leaked onto npm ci (:80)', () => {
      const line = 'npm_config_build_from_source=true sleep 1 & npm ci';
      const invocations = npmCiInvocationLines(line);
      expect(invocations.length).toBe(1);
      expect(invocations[0].text.trim()).toBe('npm ci');
      const offenders = invocations.filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });

    it('"FLAG=true echo $(npm ci)" — a command substitution does not inherit the enclosing command\'s prefix assignment, but was never split into its own scope (:80)', () => {
      const line = 'npm_config_build_from_source=true echo $(npm ci)';
      const invocations = npmCiInvocationLines(line);
      expect(invocations.length).toBe(1);
      expect(invocations[0].text.trim()).toBe('npm ci');
      const offenders = invocations.filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });

    it('a real `2>&1` redirect at the end of a genuinely flagged line is NOT mistaken for a background `&` split (regression guard for the :80 fix)', () => {
      const line =
        'run_as_builder env npm_config_build_from_source=true npm ci --no-audit >out.log 2>&1';
      const invocations = npmCiInvocationLines(line);
      expect(invocations.length).toBe(1);
      expect(setsBuildFromSource(invocations[0].text)).toBe(true);
    });

    it('"npm_config_build_from_source=true-ish npm ci" — a trailing word-boundary let a truthy-LOOKING, not-actually-`true` value read as flagged (:137)', () => {
      const line = 'npm_config_build_from_source=true-ish npm ci';
      const invocations = npmCiInvocationLines(line);
      expect(invocations.length).toBe(1);
      const offenders = invocations.filter(({ text }) => !setsBuildFromSource(text));
      expect(offenders.length).toBe(1);
    });
  });
});
