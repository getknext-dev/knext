import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitSourceIntoStatements } from './helpers/shell-statements';

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
 * Every npm command name that runs a clean install, taken from npm 11.9.0's
 * `lib/utils/cmd-list.js` (`aliases` entries resolving to `ci` or
 * `install-ci-test`, plus those two names). Re-derive on an npm bump.
 */
const CI_ALIASES = new Set([
  'ci',
  'ic',
  'clean-install',
  'install-clean',
  'isntall-clean',
  'install-ci-test',
  'cit',
  'clean-install-test',
  'sit',
]);
const FLAG = 'npm_config_build_from_source';
/** Words that may legitimately sit BEFORE the program word (wrappers, keywords, env plumbing). */
const WRAPPERS = new Set([
  'run_as_builder',
  'su-exec',
  'sudo',
  'env',
  'command',
  'exec',
  'time',
  '!',
  'if',
  'then',
  'do',
  'else',
  'elif',
  'while',
  'until',
  '(',
  '{',
]);

/**
 * Split ONE already-lexed statement into shell words: whitespace separates,
 * quotes (`'..'`, `".."`) and `${...}` keep their contents inside one word.
 * Leading `(` and trailing `)` (subshell punctuation) are peeled off.
 */
function shellWords(statement: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let brace = 0;
  const push = () => {
    if (cur !== '') words.push(cur);
    cur = '';
  };
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < statement.length) cur += statement[++i];
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '$' && statement[i + 1] === '{') {
      brace++;
      cur += '${';
      i++;
    } else if (brace > 0) {
      cur += c;
      if (c === '}') brace--;
    } else if (/\s/.test(c)) push();
    else cur += c;
  }
  push();
  return words
    .map((w) => (w.startsWith('(') && w.length > 1 ? w.slice(1) : w))
    .map((w) => (/[^$]\)+$/.test(w) && !w.includes('$(') ? w.replace(/\)+$/, '') : w))
    .filter((w) => w !== '');
}

const unquote = (w: string): string => w.replace(/^(['"])(.*)\1$/, '$2');
/** A word whose value the scan cannot know statically (expansion or substitution). */
const isUnresolvable = (w: string): boolean => /[$`]/.test(w);
const isNpmWord = (w: string): boolean => /(^|\/)npm$/.test(unquote(w));
const isPreProgramFiller = (w: string): boolean =>
  WRAPPERS.has(w) ||
  /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) ||
  /^-/.test(w) ||
  /^[\w-]+:[\w-]+$/.test(w);

type Program = { npmIdx: number; ciIdx: number };

/**
 * Locate the `npm ... ci` program in a statement. A LITERAL `npm` word counts
 * anywhere; an UNRESOLVABLE word (`${NPM:-npm}`, `$NPM`) counts when it sits
 * in command position — we cannot tell it is not npm, so it FAILS CLOSED
 * (treated as npm) rather than hiding the invocation.
 */
function findNpmCi(words: string[]): Program | null {
  for (let i = 0; i < words.length; i++) {
    const isProgram =
      isNpmWord(words[i]) ||
      (isUnresolvable(words[i]) && words.slice(0, i).every((w) => isPreProgramFiller(w)));
    if (!isProgram) continue;
    for (let j = i + 1; j < words.length; j++) {
      if (CI_ALIASES.has(unquote(words[j]))) return { npmIdx: i, ciIdx: j };
    }
  }
  return null;
}

/** Every STATEMENT (per the shared shell lexer) that invokes `npm ci` or an alias — comments,
 * line continuations, `${v#x}`, heredocs and nested substitutions are the lexer's problem. */
function npmCiInvocationLines(source: string): { line: number; text: string }[] {
  return splitSourceIntoStatements(source)
    .filter(({ text }) => findNpmCi(shellWords(text)) !== null)
    .map(({ text, line }) => ({ line, text }));
}

/**
 * Whether the invocation's EFFECTIVE `npm_config_build_from_source` is exactly
 * `true`. Env phase (words BEFORE the npm word): the LAST event wins — a bare
 * `FLAG=value` assignment, `env FLAG=value`, `env -u FLAG` / `--unset` /
 * `-i` (unset). CLI phase (words AFTER the npm word): `--build-from-source[=true]`
 * sets, `--build-from-source=<other>` / `--no-build-from-source` unset; if any
 * CLI event exists the last one overrides the env phase (npm CLI flags beat env).
 * A FLAG mention after the program is a bare argument, never an assignment.
 */
function setsBuildFromSource(text: string): boolean {
  const words = shellWords(text);
  const prog = findNpmCi(words);
  if (!prog) return false;
  let effective = false;
  for (let i = 0; i < prog.npmIdx; i++) {
    const w = words[i];
    const m = w.match(new RegExp(`^${FLAG}=(.*)$`, 's'));
    if (m) effective = unquote(m[1]) === 'true';
    else if (w === '-i' || w === '--ignore-environment') effective = false;
    else if (w === '-u' || w === '--unset') {
      if (unquote(words[i + 1] ?? '') === FLAG) effective = false;
    } else if (w === `-u${FLAG}` || w === `--unset=${FLAG}`) effective = false;
  }
  for (let j = prog.npmIdx + 1; j < words.length; j++) {
    const w = unquote(words[j]);
    if (w === '--build-from-source') {
      // nopt consumes a FOLLOWING `true`/`false` word as the flag's value.
      const next = unquote(words[j + 1] ?? '');
      if (next === 'true' || next === 'false') {
        effective = next === 'true';
        j++;
      } else effective = true;
    } else if (w === '--build-from-source=true') effective = true;
    else if (w.startsWith('--build-from-source=') || w === '--no-build-from-source')
      effective = false;
  }
  return effective;
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

    const offends = (src: string) =>
      npmCiInvocationLines(src).filter(({ text }) => !setsBuildFromSource(text));

    it('a `npm` and `ci` split across a line continuation is still ONE invocation and an offender (:184)', () => {
      const src = 'run_as_builder npm \\\n  ci --no-audit';
      expect(npmCiInvocationLines(src).length).toBe(1);
      expect(offends(src).length).toBe(1);
    });

    it('a `${y#z}` parameter expansion earlier on the line is not a comment that hides the invocation (:192)', () => {
      const src = 'x=${y#z}; run_as_builder npm ci';
      expect(npmCiInvocationLines(src).length).toBe(1);
      expect(offends(src).length).toBe(1);
    });

    it('an unresolvable program token (`${NPM:-npm}`, `$NPM`) FAILS CLOSED as an offender (:175)', () => {
      for (const src of ['${NPM:-npm} ci', 'run_as_builder $NPM ci --no-audit']) {
        expect(npmCiInvocationLines(src).length).toBe(1);
        expect(offends(src).length).toBe(1);
      }
    });

    it('an assignment that is overridden back to false / unset / a false CLI flag is NOT flagged (:227)', () => {
      for (const src of [
        'env npm_config_build_from_source=true npm_config_build_from_source=false npm ci',
        'env npm_config_build_from_source=true npm ci --build-from-source=false',
        'env npm_config_build_from_source=true env -u npm_config_build_from_source npm ci',
      ]) {
        expect(npmCiInvocationLines(src).length).toBe(1);
        expect(offends(src).length).toBe(1);
      }
    });

    it('the last assignment being `=true` (after an earlier false) IS flagged, and quoted "true" counts', () => {
      for (const src of [
        'env npm_config_build_from_source=false npm_config_build_from_source=true npm ci',
        'env npm_config_build_from_source="true" npm ci',
      ]) {
        expect(offends(src).length).toBe(0);
      }
    });

    it('`--build-from-source false` (space-separated value) overrides the env flag; `--build-from-source true` keeps it', () => {
      const off = 'env npm_config_build_from_source=true npm ci --build-from-source false';
      expect(npmCiInvocationLines(off).length).toBe(1);
      expect(offends(off).length).toBe(1);
      expect(offends('npm ci --build-from-source true').length).toBe(0);
      expect(offends('npm ci --build-from-source').length).toBe(0);
    });

    it('every npm alias that runs a clean install is an invocation (install-ci-test, sit, isntall-clean, clean-install-test, …)', () => {
      for (const alias of [
        'install-ci-test',
        'sit',
        'isntall-clean',
        'clean-install-test',
        'cit',
        'ic',
      ]) {
        const src = `run_as_builder npm ${alias} --no-audit`;
        expect(npmCiInvocationLines(src).length, alias).toBe(1);
        expect(offends(src).length, alias).toBe(1);
      }
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
