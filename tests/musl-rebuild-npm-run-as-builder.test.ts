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
 * FOLLOW-UP (jev 0.94): a second round of bypasses in the STATEMENT
 * splitter/guard-check itself, on top of #1415's own earlier fixes (the
 * jev 0.59 findings below):
 *   - the splitter only recognized `;`/`&&`/`||` as statement boundaries —
 *     a bare `|` (pipe) or bare `&` (background) never split a statement,
 *     so `run_as_builder true | npm ci` / `run_as_builder true & npm ci`
 *     stayed guarded by a wrapper that only ever wrapped `true`;
 *   - the echo-message exclusion's own control-token scan missed a bare
 *     `&` and process substitution (`>(...)`/`<(...)`);
 *   - NEITHER the splitter nor the control-token scan handled a backslash
 *     escape — an escaped quote character (`\"`) was read as a REAL quote
 *     toggle, so everything after it (including a genuine unescaped `;`)
 *     was swallowed into a phantom "quoted" region for the rest of the
 *     statement;
 *   - the trailing-comment strip (`text.split('#')[0]`) was not
 *     quote-aware, so a literal `#` inside a quoted argument
 *     (`FOO="#" npm ci`) truncated the statement mid-command;
 *   - the guard check matched `run_as_builder` ANYWHERE in the statement,
 *     not just as the command word — `npm ci --tag run_as_builder` read as
 *     guarded because the wrapper's NAME appeared as a flag VALUE.
 * Fixed by scanning the WHOLE source in one quote-and-escape-aware pass
 * (never pre-split by raw `\n` first, which cannot see a real separator
 * hidden behind an escaped quote on the same physical line), splitting on
 * `;`/`&`/`&&`/`||`/`|`/newline, and requiring `run_as_builder` as the
 * FIRST word of a statement (after any leading `VAR=value` env
 * assignments) rather than a mere substring.
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
 * Strips a trailing `#...` comment, but only an UNQUOTED, UNESCAPED one
 * (jev 0.94 finding: `FOO="#" npm ci` used to be truncated at the `#`
 * INSIDE the quotes by a naive `text.split('#')[0]`, silently deleting
 * `npm ci` from what the scan ever looked at).
 */
function stripUnquotedComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && !inSingle && i + 1 < text.length) {
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
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
    if (ch === '#') return text.slice(0, i);
  }
  return text;
}

/**
 * Whether `text` contains one of `;`, `&`, `&&`, `||`, `|`, `$(`, a
 * backtick, or a process substitution (`>(`/`<(`) OUTSIDE single quotes and
 * not escaped by a preceding unquoted backslash (jev 0.94: added the bare
 * `&` and process-substitution cases, and backslash-escape awareness, on
 * top of #1415's jev 0.59 fix below). Single quotes make everything inside
 * them fully inert in real shell semantics, so a token inside single quotes
 * is never a real chain/substitution. Double quotes are NOT inert for
 * `$(...)`/backticks — real shell still expands command substitution
 * inside a double-quoted string — so those two are still detected even
 * while "inside quotes"; only the plain separator characters are treated as
 * literal while double-quoted, matching real shell parsing.
 */
function hasUnquotedControlToken(text: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && !inSingle && i + 1 < text.length) {
      i++; // the escaped character can never itself be a control token
      continue;
    }
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
    if (ch === '&') return true; // covers a bare `&` (background) and `&&`
    if (ch === '|') return true; // covers a bare `|` and `||`
    if (ch === '$' && text[i + 1] === '(') return true;
    if (ch === '`') return true;
    if ((ch === '>' || ch === '<') && text[i + 1] === '(') return true; // process substitution
  }
  return false;
}

type Statement = { text: string; line: number };

/**
 * Splits the ENTIRE source into individual shell statements on `;`, `&`,
 * `&&`, `||`, `|`, and newlines that occur OUTSIDE single/double quotes and
 * are not escaped by a preceding unquoted backslash (jev 0.94 follow-up to
 * #1415's own jev 0.59 fix, see the file header). Operating over the WHOLE
 * source in one pass — rather than pre-splitting on raw `\n` and only then
 * quote-tracking each line independently — matters for two reasons: (1) a
 * backslash-escaped quote character on one line must not leak a phantom
 * "still inside a quote" state past that line's own boundary the way a
 * naive per-line re-scan implicitly resets it every line regardless
 * (masking the bug rather than fixing it), and (2) a genuinely multi-line
 * quoted string's embedded newline must not be mistaken for a statement
 * separator. Each returned statement carries the 1-based LINE NUMBER it
 * started on, for reporting.
 */
function splitSourceIntoStatements(source: string): Statement[] {
  const statements: Statement[] = [];
  let current = '';
  let line = 1;
  let startLine: number | null = null;
  let inSingle = false;
  let inDouble = false;

  const append = (ch: string) => {
    if (startLine === null) startLine = line;
    current += ch;
  };
  const push = () => {
    statements.push({ text: current, line: startLine ?? line });
    current = '';
    startLine = null;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    // Backslash escape: consumes the NEXT character literally — it can
    // never itself open/close a quote or act as a statement separator.
    // Real shell semantics: backslash has NO special meaning inside single
    // quotes (everything there is already fully literal).
    if (ch === '\\' && !inSingle && i + 1 < source.length) {
      append(ch);
      append(source[i + 1]);
      if (source[i + 1] === '\n') line++;
      i++;
      continue;
    }

    if (inSingle) {
      append(ch);
      if (ch === "'") inSingle = false;
      if (ch === '\n') line++;
      continue;
    }
    if (inDouble) {
      append(ch);
      if (ch === '"') inDouble = false;
      if (ch === '\n') line++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      append(ch);
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      append(ch);
      continue;
    }
    if (ch === '\n') {
      push();
      line++;
      continue;
    }
    if (ch === ';') {
      push();
      continue;
    }
    if (ch === '&' && source[i + 1] === '&') {
      push();
      i++;
      continue;
    }
    if (ch === '|' && source[i + 1] === '|') {
      push();
      i++;
      continue;
    }
    if (ch === '&' || ch === '|') {
      push();
      continue;
    }
    append(ch);
  }
  statements.push({ text: current, line: startLine ?? line });
  return statements;
}

/**
 * Whether a single, already-split STATEMENT (never a raw multi-statement
 * line) is a real package-manager invocation — every exclusion rule
 * (comment, pure-echo-message, exact-match allowlist) is applied against
 * that statement alone, and the word check itself runs against the CODE
 * portion only (before an unquoted, unescaped trailing `#`), so a trailing
 * comment mentioning a package manager can't manufacture a false mention.
 */
function isRealInvocationStatement(statement: string): boolean {
  const trimmed = statement.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return false; // comment/prose
  if (trimmed.startsWith('echo ') && !hasUnquotedControlToken(trimmed)) return false; // a pure message string, never a real invocation
  if (isAllowlistedNonInvocation(trimmed)) return false;
  const codePortion = stripUnquotedComment(trimmed);
  return PACKAGE_MANAGER_WORD_RE.test(codePortion);
}

/** Every source LINE that has at least one real package-manager invocation statement on it. */
function packageManagerMentionLines(source: string): { line: number; text: string }[] {
  const lines = new Map<number, string>();
  for (const { text, line } of splitSourceIntoStatements(source)) {
    if (isRealInvocationStatement(text) && !lines.has(line)) {
      lines.set(line, text);
    }
  }
  return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([line, text]) => ({ line, text }));
}

/**
 * Whether a single STATEMENT is wrapped by `run_as_builder` — required to
 * be the FIRST word of the statement's code portion, after skipping any
 * number of leading `VAR=value` env assignments (jev 0.94 finding: the
 * previous check matched `run_as_builder` ANYWHERE in the statement, so
 * `npm ci --tag run_as_builder` read as guarded because the wrapper's own
 * NAME appeared as a flag VALUE, never actually wrapping the command). The
 * comment strip is quote-aware (`stripUnquotedComment`), so a comment that
 * merely NAMES the wrapper after the command cannot make an unguarded
 * command read as guarded, and `run_as_builder` guarding an EARLIER
 * statement on the same line cannot guard a later, unrelated one (already
 * true structurally: each statement is checked independently).
 */
const LEADING_ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*/;

function isGuardedByRunAsBuilder(statement: string): boolean {
  const codePortion = stripUnquotedComment(statement);
  let rest = codePortion.trimStart();
  for (;;) {
    const m = rest.match(LEADING_ENV_ASSIGNMENT_RE);
    if (!m) break;
    rest = rest.slice(m[0].length).trimStart();
  }
  return /^run_as_builder\b/.test(rest);
}

function offendersOf(source: string): { line: number; text: string }[] {
  const offenders: { line: number; text: string }[] = [];
  for (const { text, line } of splitSourceIntoStatements(source)) {
    if (isRealInvocationStatement(text) && !isGuardedByRunAsBuilder(text)) {
      offenders.push({ line, text: text.trim() });
    }
  }
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

  /**
   * jev 0.94 — five bypasses of the splitter/guard-check itself (as opposed
   * to the WORD-detection bypasses #1415 already closed above): each stayed
   * guarded or excused despite being a real, unguarded invocation, because
   * the splitter/control-token-scan/guard-check missed a shape they didn't
   * previously handle. One fixture per distinct rule.
   */
  describe('splitter/guard-check bypasses beyond #1415 (jev 0.94)', () => {
    it('a bare `|` (pipe) is a statement boundary — run_as_builder wrapping the LEFT side does not guard npm ci on the right', () => {
      expect(offendersOf('run_as_builder true | npm ci --no-audit').length).toBe(1);
    });

    it('a bare `&` (background) is a statement boundary — run_as_builder wrapping the LEFT side does not guard npm ci on the right', () => {
      expect(offendersOf('run_as_builder true & npm ci --no-audit').length).toBe(1);
    });

    it('an echo message chained via a bare `&` still surfaces the real invocation after it', () => {
      expect(offendersOf('echo x & npm ci --no-audit').length).toBe(1);
    });

    it('an echo message followed by process substitution containing a real invocation is not waved through', () => {
      expect(offendersOf('echo x > >(npm ci --no-audit)').length).toBeGreaterThanOrEqual(1);
    });

    it('a backslash-escaped quote does not hide a genuine unquoted `;` after it (echo \\" ; npm ci)', () => {
      // Shell text: echo \" ; npm ci --no-audit
      // The `\"` is a literal escaped double-quote character inside echo's
      // OWN argument — it never opens a real quoted region, so the `;`
      // right after it is a REAL, unquoted statement separator, and
      // `npm ci` is a second, entirely separate, unguarded statement.
      const line = 'echo \\" ; npm ci --no-audit';
      const offenders = offendersOf(line);
      expect(offenders.length).toBe(1);
      expect(offenders[0].text).toMatch(/npm ci/);
    });

    it('a literal `#` inside a quoted argument does not truncate the statement before the real invocation (FOO="#" npm ci)', () => {
      const line = 'FOO="#" npm ci --no-audit';
      expect(offendersOf(line).length).toBe(1);
    });

    it('`run_as_builder` appearing as a flag VALUE (not the command word) does not count as guarding the statement', () => {
      const line = 'npm ci --tag run_as_builder';
      expect(offendersOf(line).length).toBe(1);
    });

    it('`run_as_builder` genuinely wrapping the command, with leading env assignments before it, still guards (regression check for the FIRST-word rewrite)', () => {
      expect(offendersOf('FOO=1 BAR=2 run_as_builder npm ci --no-audit').length).toBe(0);
    });
  });
});
