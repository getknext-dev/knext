import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * scripts/e2e-native-rebuild-musl.sh (#1257 round 7) — every REAL
 * package-manager invocation (npm/npx/pnpm/yarn/bun) in this script must
 * run as the unprivileged `run_as_builder` wrapper, not root — that is the
 * whole point of round 7's non-root fix (see the script's own header).
 *
 * Round-3 review finding (techdebt-4): the ORIGINAL scan only matched
 * `npm ci`/`npm install` immediately after a narrow set of preceding
 * syntax (start of line, `&&`, `;`, `(`, or `run_as_builder`), which missed
 * every one of:
 *   - an invocation after `||`, `then`, or `do`;
 *   - a leading env assignment (`FOO=1 npm ci`, `env A=1 npm install`);
 *   - `npm --prefix x install`, `npm rebuild`, `npm clean-install`, `npm in`;
 *   - an invocation behind `command`/`exec`;
 *   - pnpm, yarn, `bun install`, npx.
 *
 * Fixed structurally rather than patched shape-by-shape: this now flags
 * ANY non-comment line containing `\b(npm|npx|pnpm|yarn|bun)\b` as a real
 * token, regardless of what precedes it. Scanning this broadly needs an
 * explicit exclusion for the lines that legitimately mention one of these
 * words without invoking it — an `echo`/log line (a message string, never
 * a real invocation in this script — excluded by a GENERAL rule, not
 * enumerated per message) and the one line that installs `npm` itself as
 * an apk PACKAGE NAME (an explicit, named allowlist entry, asserted to
 * appear in the real script EXACTLY ONCE so it cannot silently drift).
 *
 * This is a SCAN, not an enumerated list of line numbers (workflow.md's
 * "prefer scanning to enumerating" rule) — a NEW invocation added later
 * without `run_as_builder`, in ANY shape, must fail this test.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');

const PACKAGE_MANAGER_WORD_RE = /\b(npm|npx|pnpm|yarn|bun)\b/;

/**
 * Lines KNOWN not to be a real package-manager invocation despite
 * containing one of the words above. Each entry is asserted, against the
 * REAL script, to occur EXACTLY ONCE — a stale, duplicated, or since-removed
 * allowlist entry fails this test loudly rather than silently widening (or
 * narrowing) what the scan excludes.
 *
 * #1415 finding (jev 0.59): this used to be matched via `text.includes(entry)`
 * — a SUBSTRING test — so a line that merely STARTED WITH this exact text,
 * with a real invocation chained after it (e.g. via `;`), was excused too:
 * `<this line>; npm ci` still `.includes()`-matched. Matched EXACTLY against
 * a single, already-split STATEMENT now (see `isAllowlistedNonInvocation`),
 * never as a substring of a longer one.
 */
const NON_INVOCATION_ALLOWLIST = [
  // The apk TOOLCHAIN install — "npm" here is an apk PACKAGE NAME (the
  // pinned Alpine base ships bun only, no npm binary at all — see the
  // script's own header), never a package-manager invocation.
  'apk add --no-cache python3 make g++ npm su-exec >/dev/null',
];

function isAllowlistedNonInvocation(text: string): boolean {
  return NON_INVOCATION_ALLOWLIST.includes(text);
}

/**
 * Whether `text` contains one of `;`, `&&`, `||`, `|`, `$(`, or a backtick
 * OUTSIDE single quotes (#1415 jev 0.59 finding). Single quotes make
 * everything inside them fully inert in real shell semantics, so a token
 * inside single quotes is never a real chain/substitution. Double quotes
 * are NOT inert for `$(...)`/backticks — real shell still expands command
 * substitution inside a double-quoted string — so those two are still
 * detected even while "inside quotes"; only `;`/`&&`/`||`/`|` are treated
 * as literal while double-quoted, matching real shell parsing.
 */
function hasUnquotedControlToken(text: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      if (ch === '$' && text[i + 1] === '(') return true;
      if (ch === '`') return true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === ';') return true;
    if (ch === '&' && text[i + 1] === '&') return true;
    if (ch === '|') return true; // covers a bare `|` and `||`
    if (ch === '$' && text[i + 1] === '(') return true;
    if (ch === '`') return true;
  }
  return false;
}

/**
 * Splits a raw script LINE into individual shell statements on `;`, `&&`,
 * and `||` that occur OUTSIDE single/double quotes (#1415 low finding: the
 * guard previously checked `run_as_builder` presence against the WHOLE
 * LINE, so `run_as_builder true; npm ci` read as guarded because the
 * wrapper's name appeared SOMEWHERE on the line, even though it only wraps
 * `true` — a different statement than the unguarded `npm ci` after it).
 * Each statement is classified and guard-checked independently below.
 */
function splitUnquotedStatements(text: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      statements.push(current);
      current = '';
      continue;
    }
    if (ch === '&' && text[i + 1] === '&') {
      statements.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === '|' && text[i + 1] === '|') {
      statements.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
  }
  statements.push(current);
  return statements;
}

/**
 * Whether a single, already-split STATEMENT (never a raw multi-statement
 * line) is a real package-manager invocation — every exclusion rule
 * (comment, pure-echo-message, exact-match allowlist) is applied against
 * that statement alone, and the word check itself runs against the CODE
 * portion only (before an unquoted trailing `#`), so a trailing comment
 * mentioning a package manager can't manufacture a false mention.
 */
function isRealInvocationStatement(statement: string): boolean {
  const trimmed = statement.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return false; // comment/prose
  if (trimmed.startsWith('echo ') && !hasUnquotedControlToken(trimmed)) return false; // a pure message string, never a real invocation
  if (isAllowlistedNonInvocation(trimmed)) return false;
  const codePortion = trimmed.split('#')[0] ?? trimmed;
  return PACKAGE_MANAGER_WORD_RE.test(codePortion);
}

/** Every source LINE that has at least one real package-manager invocation statement on it. */
function packageManagerMentionLines(source: string): { line: number; text: string }[] {
  const lines = source.split('\n');
  const mentionLineNumbers = new Set<number>();
  lines.forEach((lineText, i) => {
    for (const statement of splitUnquotedStatements(lineText)) {
      if (isRealInvocationStatement(statement)) {
        mentionLineNumbers.add(i + 1);
        break;
      }
    }
  });
  return [...mentionLineNumbers]
    .sort((a, b) => a - b)
    .map((line) => ({ line, text: lines[line - 1] }));
}

/**
 * Whether a single STATEMENT is wrapped by `run_as_builder` — checked
 * against the CODE portion of THAT STATEMENT only (everything before an
 * unquoted trailing `#`), never the whole line (#1415 low finding), so a
 * comment that merely NAMES the wrapper after the command cannot make an
 * unguarded command read as guarded, and `run_as_builder` guarding an
 * EARLIER statement on the same line cannot guard a later, unrelated one.
 */
function isGuardedByRunAsBuilder(text: string): boolean {
  const codePortion = text.split('#')[0] ?? text;
  return /\brun_as_builder\b/.test(codePortion);
}

function offendersOf(source: string): { line: number; text: string }[] {
  const offenders: { line: number; text: string }[] = [];
  source.split('\n').forEach((lineText, i) => {
    for (const statement of splitUnquotedStatements(lineText)) {
      if (isRealInvocationStatement(statement) && !isGuardedByRunAsBuilder(statement)) {
        offenders.push({ line: i + 1, text: statement.trim() });
      }
    }
  });
  return offenders;
}

describe('every real package-manager invocation runs via run_as_builder — broad word-boundary scan (#1257 round 7, review round 3)', () => {
  it('finds package-manager mention lines at all — the scan must not pass vacuously', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(packageManagerMentionLines(source).length).toBeGreaterThan(0);
  });

  it('every package-manager mention line in the real script contains run_as_builder', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(offendersOf(source)).toEqual([]);
  });

  it('every allowlist entry appears in the real script EXACTLY ONCE', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    for (const entry of NON_INVOCATION_ALLOWLIST) {
      const count = source.split(entry).length - 1;
      expect(count).toBe(1);
    }
  });

  it('catches an npm invocation after `||`', () => {
    expect(offendersOf('true || npm ci --no-audit').length).toBe(1);
  });

  it('catches an npm invocation after `then`/`do`', () => {
    expect(offendersOf('if true; then npm ci --no-audit; fi').length).toBe(1);
    expect(offendersOf('for x in 1; do npm ci --no-audit; done').length).toBe(1);
  });

  it('catches a leading env-assignment npm invocation (FOO=1 npm ci / env A=1 npm install)', () => {
    expect(offendersOf('FOO=1 npm ci --no-audit').length).toBe(1);
    expect(offendersOf('env A=1 npm install --no-save').length).toBe(1);
  });

  it('catches npm subcommands other than ci/install (--prefix, rebuild, clean-install, in)', () => {
    for (const line of [
      'npm --prefix x install',
      'npm rebuild',
      'npm clean-install',
      'npm in --no-audit',
    ]) {
      expect(offendersOf(line).length).toBe(1);
    }
  });

  it('catches an invocation behind `command`/`exec`', () => {
    expect(offendersOf('command npm ci --no-audit').length).toBe(1);
    expect(offendersOf('exec npm ci --no-audit').length).toBe(1);
  });

  it('catches pnpm, yarn, bun install, and npx invocations too, not just npm', () => {
    for (const line of ['pnpm install', 'yarn install', 'bun install', 'npx something']) {
      expect(offendersOf(line).length).toBe(1);
    }
  });

  it('the scan correctly distinguishes a guarded line from an unguarded one (fixture proof)', () => {
    const guarded = 'if ! (cd x && run_as_builder npm ci --no-audit); then';
    const unguarded = 'if ! (cd x && npm ci --no-audit); then';
    expect(packageManagerMentionLines(guarded).length).toBe(1);
    expect(packageManagerMentionLines(unguarded).length).toBe(1);
    expect(offendersOf(guarded).length).toBe(0);
    expect(offendersOf(unguarded).length).toBe(1);
  });

  it('a comment mentioning "npm install" in prose is not counted as an invocation', () => {
    const prose = "  # every `npm install`/`npm ci` call is su-exec'd to that user";
    expect(packageManagerMentionLines(prose)).toEqual([]);
  });

  it('an echo/log line mentioning npm in its message is not counted as an invocation', () => {
    const echoLine =
      '      echo "[native-rebuild] WARNING: reproducible \'npm ci\' of \\${_spec} failed"';
    expect(packageManagerMentionLines(echoLine)).toEqual([]);
  });

  it('the allowlisted apk-toolchain-install line is not counted as an invocation (npm is an apk PACKAGE NAME there)', () => {
    const line = 'apk add --no-cache python3 make g++ npm su-exec >/dev/null';
    expect(packageManagerMentionLines(line)).toEqual([]);
  });

  it('a trailing "# run_as_builder" comment on an otherwise-unguarded line does NOT count as guarding it', () => {
    const trickLine = 'if ! (cd x && npm ci --no-audit); then # run_as_builder';
    expect(offendersOf(trickLine).length).toBe(1);
  });

  it('a genuinely guarded line with an UNRELATED trailing comment is still recognized as guarded', () => {
    const guardedWithComment = 'if ! (cd x && run_as_builder npm ci --no-audit); then # some note';
    expect(offendersOf(guardedWithComment).length).toBe(0);
  });

  /**
   * #1415 round finding (jev 0.59): the echo exclusion was
   * `trimmed.startsWith('echo ')` — the WHOLE line was excluded the moment
   * it began with "echo ", even when the rest of the line chains a REAL,
   * unguarded invocation onto it via `;`, `&&`, a command substitution
   * (`$(...)` or backticks), or a pipe. All four shapes below are real
   * invocations of `npm ci` that a shell actually executes, and must be
   * caught, not waved through because the line happens to start with the
   * word "echo".
   */
  describe('an echo-prefixed line that actually CHAINS a real invocation is not waved through (jev 0.59 finding)', () => {
    it('echo x; npm ci — chained via ;', () => {
      expect(offendersOf('echo x; npm ci --no-audit').length).toBe(1);
    });

    it('echo "$(npm ci)" — command substitution inside a double-quoted echo message', () => {
      expect(offendersOf('echo "$(npm ci --no-audit)"').length).toBe(1);
    });

    it('echo `npm ci` — backtick command substitution', () => {
      expect(offendersOf('echo `npm ci --no-audit`').length).toBe(1);
    });

    it('echo hi && npm ci — chained via &&', () => {
      expect(offendersOf('echo hi && npm ci --no-audit').length).toBe(1);
    });

    it('a genuinely pure echo message (no chaining, no substitution) is still excluded, unaffected — see the pre-existing "an echo/log line..." test above for the exact fixture', () => {
      expect(
        offendersOf('echo "a plain message with no operators or substitution in it"').length,
      ).toBe(0);
    });
  });

  /**
   * #1415 round finding (jev 0.59): `isAllowlistedNonInvocation` used
   * `text.includes(entry)` — a SUBSTRING test — so any statement that
   * merely STARTS WITH the allowlisted apk-toolchain-install text, with
   * extra content (including a real invocation) appended in the SAME
   * statement, still matched and was excluded wholesale. The allowlist is
   * for that ONE exact statement, not a prefix any other statement can
   * borrow. Deliberately NOT separated by `;`/`&&`/`||` here — a
   * `;`-separated variant would already be caught by the per-statement
   * splitting alone (a different fix), so it wouldn't isolate THIS
   * specific defect; a `$(...)` command substitution appended directly
   * onto the same statement is not a split boundary, so only the
   * exact-match fix (not the splitting fix) can catch it.
   */
  it('a statement that only STARTS WITH the allowlisted apk line, with a real invocation appended in the SAME statement, is NOT excused by the allowlist (jev 0.59 finding)', () => {
    const trojan =
      'apk add --no-cache python3 make g++ npm su-exec >/dev/null $(npm ci --no-audit)';
    expect(offendersOf(trojan).length).toBe(1);
  });

  /**
   * Low finding: the guard check was PER LINE, not per shell command — a
   * line like `run_as_builder true; npm ci` contains the literal string
   * `run_as_builder` somewhere on the line, so the old whole-line check
   * read the unrelated, unguarded `npm ci` after the `;` as guarded too.
   * `run_as_builder` only wraps the command it actually precedes.
   */
  it('run_as_builder wrapping an UNRELATED command does not guard a different command chained after it (low finding)', () => {
    expect(offendersOf('run_as_builder true; npm ci --no-audit').length).toBe(1);
    expect(offendersOf('run_as_builder true && npm ci --no-audit').length).toBe(1);
  });

  it('run_as_builder genuinely wrapping the SAME statement still guards it, even with other statements on the line', () => {
    expect(offendersOf('true; run_as_builder npm ci --no-audit').length).toBe(0);
    expect(offendersOf('cd x && run_as_builder npm ci --no-audit').length).toBe(0);
  });
});
