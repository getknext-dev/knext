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
 * ROUND 6 REVIEW (jev 0.78, BLOCKING): that one pass still did not model
 * `#` comments, heredocs or `$'...'`, so an apostrophe in a comment opened a
 * phantom quote — on the real script it swallowed the guarded `npm ci` at
 * :263, and a bare `npm ci` inserted at 169 of 529 line positions went
 * unseen. `splitSourceIntoStatements` is now a small shell lexer (see its
 * doc) and is the ONLY place quoting is interpreted; the two per-statement
 * re-scanners it used to disagree with are gone.
 *
 * This is a SCAN, not an enumerated list of line numbers (workflow.md's
 * "prefer scanning to enumerating" rule) — a NEW invocation added later
 * without `run_as_builder`, in ANY shape, must fail this test. The
 * acceptance block at the bottom additionally pins the real script's
 * invocation lines by number and inserts a bare `npm ci` at every line
 * position, as the proof that the scan sees the whole file.
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
  'apk add --no-cache python3~3.12 make~4.4 g++~14.2 npm~11.6 su-exec~0.2 >/dev/null',
];

function isAllowlistedNonInvocation(text: string): boolean {
  return NON_INVOCATION_ALLOWLIST.includes(text);
}

type Statement = { text: string; line: number };

/** A frame whose text is shell CODE: the top level, `$(...)`, `<(...)`/`>(...)`, or backticks. */
type CodeFrame = {
  kind: 'code';
  /** What closes this frame: `)` for `$(`/`<(`/`>(`, a backtick for a backtick, null at top level. */
  close: ')' | '`' | null;
  /** Unbalanced `(` seen inside this frame (subshells, `$((`), so their `)` does not close it. */
  depth: number;
  text: string;
  startLine: number | null;
};
type Frame = CodeFrame | { kind: 'dq' } | { kind: 'brace'; depth: number };

/** `<<` / `<<-`, optional blanks, then the delimiter word (quoted, escaped or bare). */
const HEREDOC_OP_RE = /^<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|<>()'"\\])+)/;

/**
 * A small shell LEXER over the WHOLE source that splits it into the
 * individual statements a shell would run, each with the 1-based line it
 * starts on. Round-6 review (jev 0.78) found the previous quote-aware
 * splitter desynced on constructs it did not model at all — most damagingly
 * a `#` comment, where an apostrophe (`# the script's header`) opened a
 * phantom single-quoted region that swallowed 26 real lines, including a
 * guarded `npm ci`. Modelled here, each one mutation-proved by a fixture:
 *
 *   - `#` starts a comment ONLY at the start of a word in code (after a
 *     blank, a newline or an operator), and runs to the newline — the
 *     comment text is dropped, so nothing in it can open a quote or read as
 *     a command. `a#b` and `${v#*}` are NOT comments;
 *   - `'...'` is fully literal; `$'...'` (ANSI-C) honours `\'`;
 *   - `"..."` is literal EXCEPT `\`-escapes, `$(...)`, backticks and `${...}`,
 *     which nest (so `"$(printf "%s" a)"` does not desync);
 *   - `${...}` is a parameter expansion (no comments, no separators inside);
 *   - heredoc bodies (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`) are cut out
 *     by LINE — up to the terminator line — so nothing inside a body can
 *     desync the outer lexer; the body is then lexed on its own (a body fed
 *     to `sh` is code, so it is scanned for invocations too — strictly: even
 *     a quoted-delimiter body that is only text is scanned);
 *   - statements split on newline, `;`, `&&`, `||`, `|`, and a background
 *     `&` — but not the `&` of a redirect (`2>&1`, `<&0`, `&>file`);
 *   - a command / process substitution (`$(...)`, backticks, `<(...)`,
 *     `>(...)`) is lexed as its OWN nested statements, never as part of the
 *     statement that contains it. That is what makes
 *     `run_as_builder echo "$(npm ci)"` an offender: the shell runs the
 *     substitution as ROOT before `run_as_builder` ever starts, so the inner
 *     `npm ci` must be judged on its own, not as an argument of a guarded
 *     statement. The outer statement keeps only an empty `$()` marker.
 *
 * Unclosed constructs at end of input are flushed as-is (fail towards
 * reporting text, never towards hiding it).
 */
function splitSourceIntoStatements(source: string, firstLine = 1): Statement[] {
  const out: Statement[] = [];
  const newCode = (close: CodeFrame['close']): CodeFrame => ({
    kind: 'code',
    close,
    depth: 0,
    text: '',
    startLine: null,
  });
  const stack: Frame[] = [newCode(null)];
  let pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];
  let line = firstLine;
  let wordStart = true;

  const code = (): CodeFrame => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k];
      if (f.kind === 'code') return f;
    }
    throw new Error('unreachable: the top-level code frame is never popped');
  };
  const append = (s: string) => {
    const f = code();
    if (f.startLine === null) f.startLine = line;
    f.text += s;
    line += s.split('\n').length - 1;
  };
  const flush = (f: CodeFrame) => {
    if (f.text.trim() !== '' && f.startLine !== null) out.push({ text: f.text, line: f.startLine });
    f.text = '';
    f.startLine = null;
  };
  const openSubst = (close: ')' | '`') => {
    stack.push(newCode(close));
    wordStart = true;
  };
  const closeSubst = (f: CodeFrame) => {
    flush(f);
    stack.pop();
    append(f.close ?? '');
    wordStart = false;
  };
  /** Index just past the end of a `'...'` region starting at `i` (or of an ANSI-C `$'...'` when `ansiC`). */
  const endOfSingle = (i: number, ansiC: boolean): number => {
    let j = i + (ansiC ? 2 : 1);
    while (j < source.length && source[j] !== "'") j += ansiC && source[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, source.length);
  };
  /** Cuts every pending heredoc body out by LINE, starting at `pos`; returns the index after the last terminator. */
  const consumeHeredocBodies = (pos: number): number => {
    for (const { delim, stripTabs } of pendingHeredocs) {
      const bodyStartLine = line;
      const body: string[] = [];
      while (pos < source.length) {
        const nl = source.indexOf('\n', pos);
        const end = nl === -1 ? source.length : nl;
        const raw = source.slice(pos, end);
        pos = end + 1;
        line++;
        if ((stripTabs ? raw.replace(/^\t+/, '') : raw) === delim) break;
        body.push(raw);
      }
      out.push(...splitSourceIntoStatements(body.join('\n'), bodyStartLine));
    }
    pendingHeredocs = [];
    return pos;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const nx = source[i + 1];
    const top = stack[stack.length - 1];

    if (top.kind === 'dq' || top.kind === 'brace') {
      if (ch === '\\' && i + 1 < source.length) {
        append(ch + nx);
        i++;
      } else if (ch === '$' && nx === '(') {
        append('$(');
        i++;
        openSubst(')');
      } else if (ch === '`') {
        append('`');
        openSubst('`');
      } else if (ch === '$' && nx === '{') {
        append('${');
        i++;
        stack.push({ kind: 'brace', depth: 0 });
      } else if (top.kind === 'dq') {
        append(ch);
        if (ch === '"') stack.pop();
      } else if (ch === "'") {
        const end = endOfSingle(i, false);
        append(source.slice(i, end));
        i = end - 1;
      } else if (ch === '"') {
        append(ch);
        stack.push({ kind: 'dq' });
      } else {
        append(ch);
        if (ch === '{') top.depth++;
        if (ch === '}') {
          if (top.depth === 0) stack.pop();
          else top.depth--;
        }
      }
      continue;
    }

    const f = top;
    if (ch === '\\' && i + 1 < source.length) {
      if (nx === '\n')
        line++; // line continuation: joins the two lines
      else append(ch + nx);
      i++;
      wordStart = false;
    } else if (ch === '#' && wordStart) {
      const nl = source.indexOf('\n', i);
      i = (nl === -1 ? source.length : nl) - 1; // drop the comment, keep its newline
    } else if (ch === "'" || (ch === '$' && nx === "'")) {
      const end = endOfSingle(i, ch === '$');
      append(source.slice(i, end));
      i = end - 1;
      wordStart = false;
    } else if (ch === '"') {
      append(ch);
      stack.push({ kind: 'dq' });
      wordStart = false;
    } else if (ch === '$' && nx === '{') {
      append('${');
      i++;
      stack.push({ kind: 'brace', depth: 0 });
      wordStart = false;
    } else if ((ch === '$' || ch === '<' || ch === '>') && nx === '(') {
      append(`${ch}(`);
      i++;
      openSubst(')');
    } else if (ch === '`') {
      if (f.close === '`') closeSubst(f);
      else {
        append('`');
        openSubst('`');
      }
    } else if (ch === '<' && nx === '<') {
      // A here-string `<<<` never matches: the delimiter class excludes `<`.
      const m = source.slice(i).match(HEREDOC_OP_RE);
      if (m) {
        append(m[0]);
        pendingHeredocs.push({ delim: m[2].replace(/['"\\]/g, ''), stripTabs: m[1] === '-' });
        i += m[0].length - 1;
        wordStart = false;
      } else {
        append('<<');
        i++;
        wordStart = true;
      }
    } else if (ch === '(') {
      f.depth++;
      append(ch);
      wordStart = true;
    } else if (ch === ')') {
      if (f.close === ')' && f.depth === 0) closeSubst(f);
      else {
        f.depth = Math.max(0, f.depth - 1);
        append(ch);
        wordStart = true;
      }
    } else if (ch === '\n') {
      flush(f);
      line++;
      wordStart = true;
      if (pendingHeredocs.length > 0) i = consumeHeredocBodies(i + 1) - 1;
    } else if (ch === ';') {
      flush(f);
      wordStart = true;
    } else if (ch === '&' && (/[<>]$/.test(f.text) || nx === '>')) {
      append(ch); // a redirect (`2>&1`, `<&0`, `&>file`), not a separator
      wordStart = false;
    } else if ((ch === '&' || ch === '|') && nx === ch) {
      flush(f);
      i++;
      wordStart = true;
    } else if (ch === '&' || ch === '|') {
      flush(f);
      wordStart = true;
    } else {
      append(ch);
      wordStart = ch === ' ' || ch === '\t' || ch === '<' || ch === '>';
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const fr = stack[k];
    if (fr.kind === 'code') flush(fr);
  }
  return out;
}

/**
 * Whether a single, already-split STATEMENT (never a raw multi-statement
 * line) is a real package-manager invocation. The lexer has already dropped
 * comments and split out every separator and every substitution, so a
 * statement starting with `echo ` is a pure message string — anything it
 * could chain or substitute is a SEPARATE statement, classified on its own.
 * (The old per-statement `hasUnquotedControlToken`/`stripUnquotedComment`
 * scans are gone: they were second and third lexers that could — and, for
 * `${v#*}`, did — disagree with the splitter.)
 */
function isRealInvocationStatement(statement: string): boolean {
  const trimmed = statement.trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('echo ')) return false; // a pure message string, never a real invocation
  if (isAllowlistedNonInvocation(trimmed)) return false;
  return PACKAGE_MANAGER_WORD_RE.test(trimmed);
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
 * lexer drops comments, so a comment that merely NAMES the wrapper cannot
 * make an unguarded command read as guarded; `run_as_builder` guarding an
 * EARLIER statement cannot guard a later one (each statement is checked
 * independently); and a substitution in the wrapper's ARGUMENTS is its own
 * statement (it runs as root before the wrapper starts). The assignment
 * value is quote-aware: with a bare `\S*`, `FOO="x run_as_builder" npm ci`
 * consumed only `FOO="x` and then read `run_as_builder` as the command word.
 */
const LEADING_ENV_ASSIGNMENT_RE =
  /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\$\{[^}]*\}|\\[\s\S]|[^\s'"\\])*/;

function isGuardedByRunAsBuilder(statement: string): boolean {
  let rest = statement.trimStart();
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
    const line =
      'apk add --no-cache python3~3.12 make~4.4 g++~14.2 npm~11.6 su-exec~0.2 >/dev/null';
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
      'apk add --no-cache python3~3.12 make~4.4 g++~14.2 npm~11.6 su-exec~0.2 >/dev/null $(npm ci --no-audit)';
    // The substitution is lexed as its own statement (also an offender);
    // what THIS test pins is that the apk statement itself is not excused.
    expect(offendersOf(trojan).some((o) => o.text.startsWith('apk add'))).toBe(true);
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

    /**
     * Isolates the SPLITTER's own escape handling from
     * `hasUnquotedControlToken`'s (both independently escape-aware, but the
     * echo-exclusion path above only ever exercises the LATTER — an
     * un-split whole statement still gets classified correctly there
     * because `hasUnquotedControlToken` finds the real `;` on its own,
     * whatever the splitter did). Here `run_as_builder` is the statement's
     * OWN first word, wrapping only the harmless `echo \"` before the
     * escaped quote — if the splitter fails to split on the REAL `;` after
     * it (reading the escaped quote as a genuine quote-open instead), the
     * whole blob stays one statement whose first word is `run_as_builder`,
     * so the guard-check would misread the separate, unguarded `npm ci`
     * after the `;` as guarded by a wrapper that was only ever wrapping
     * `echo`.
     */
    it('a backslash-escaped quote does not let a guard on an EARLIER command leak across a real `;` hidden behind it (run_as_builder echo \\" ; npm ci)', () => {
      const line = 'run_as_builder echo \\" ; npm ci --no-audit';
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

  /**
   * Round-6 review (jev 0.78, BLOCKING): the whole-source splitter never
   * recognised a `#` comment, so an apostrophe INSIDE a comment opened a
   * phantom single-quoted region that swallowed every following line up to
   * the next apostrophe — on the real script the comment at :244 ate the
   * guarded `npm ci` at :263, and a bare `npm ci` inserted at 169 of 529
   * line positions went undetected. One fixture per lexer rule.
   */
  describe('lexer: comments, heredocs, ANSI-C strings, ${...} and substitutions (round-6 review, jev 0.78)', () => {
    it('an apostrophe inside a `#` comment does not open a quote that swallows the next line', () => {
      const src = "# it's\nnpm ci --no-audit\n# don't\n";
      expect(offendersOf(src)).toEqual([{ line: 2, text: 'npm ci --no-audit' }]);
    });

    it('an apostrophe inside a trailing comment does not swallow the next line either', () => {
      const src = "true # the script's header\nnpm ci --no-audit\n";
      expect(offendersOf(src)).toEqual([{ line: 2, text: 'npm ci --no-audit' }]);
    });

    it('a `#` NOT at word start is literal, not a comment (x=a#b npm ci)', () => {
      expect(offendersOf('x=a#b npm ci --no-audit').length).toBe(1);
    });

    it('a `#` inside ${...} is parameter expansion, not a comment (x=${v#*/} npm ci)', () => {
      expect(offendersOf('x=${v#*/} npm ci --no-audit').length).toBe(1);
      // `#` at WORD START but inside ${...}: only the brace frame keeps it literal.
      expect(offendersOf('x=${v:- #} npm ci --no-audit').length).toBe(1);
      // `;` inside ${...} is not a separator either.
      expect(offendersOf('run_as_builder npm ci --tag ${v//;/npm}').length).toBe(0);
    });

    it('an unquoted heredoc body is opaque to the lexer: its apostrophe does not swallow a later real line', () => {
      const src = "cat <<EOF\nit's a body line\nEOF\nnpm ci --no-audit\n";
      expect(offendersOf(src)).toEqual([{ line: 4, text: 'npm ci --no-audit' }]);
    });

    it(`quoted and dash heredoc delimiters (<<'EOF', <<-"EOF") are consumed as opaque bodies too`, () => {
      const quoted = "cat <<'EOF'\ndon't\nEOF\nnpm ci --no-audit\n";
      expect(offendersOf(quoted)).toEqual([{ line: 4, text: 'npm ci --no-audit' }]);
      const dash = 'cat <<-"EOF"\n\tdon\'t\n\tEOF\nnpm ci --no-audit\n';
      expect(offendersOf(dash)).toEqual([{ line: 4, text: 'npm ci --no-audit' }]);
    });

    it('a heredoc body is still scanned for a package-manager invocation', () => {
      const src = 'sh <<EOF\nnpm ci --no-audit\nEOF\n';
      expect(offendersOf(src)).toEqual([{ line: 2, text: 'npm ci --no-audit' }]);
    });

    it("an ANSI-C string honours \\' ($'a\\'b') and does not desync the lexer", () => {
      const src = "echo $'a\\'b'\nnpm ci --no-audit\n";
      expect(offendersOf(src)).toEqual([{ line: 2, text: 'npm ci --no-audit' }]);
    });

    it('a substitution in a run_as_builder argument runs as ROOT before the wrapper — not guarded', () => {
      for (const src of [
        'run_as_builder echo "$(npm ci --no-audit)"',
        'run_as_builder echo `npm ci --no-audit`',
        'run_as_builder cat <(npm ci --no-audit)',
        'run_as_builder tee >(npm ci --no-audit)',
        // a subshell's `)` inside the substitution must not close it early
        'run_as_builder echo "$( (true); npm ci --no-audit )"',
      ]) {
        expect(offendersOf(src).map((o) => o.text)).toEqual(['npm ci --no-audit']);
      }
    });

    it('a `"` nested inside "$(...)" does not desync the enclosing double-quoted string', () => {
      const src = 'x="$(printf "%s" a)"; npm ci --no-audit';
      expect(offendersOf(src).map((o) => o.text)).toEqual(['npm ci --no-audit']);
    });

    it('a quoted env-assignment value naming run_as_builder is not the command word (FOO="x run_as_builder" npm ci)', () => {
      expect(offendersOf('FOO="x run_as_builder" npm ci --no-audit').length).toBe(1);
      expect(offendersOf('FOO="a b" run_as_builder npm ci --no-audit').length).toBe(0);
    });

    it('a redirect `2>&1` is not a background separator (the guarded statement stays whole)', () => {
      // Split at the `&`, the tail `1 --prefix ./npm` would read as a
      // second, unguarded mention.
      expect(offendersOf('run_as_builder npm ci 2>&1 --prefix ./npm').length).toBe(0);
      expect(offendersOf('run_as_builder npm ci <&0 --prefix ./npm').length).toBe(0);
      expect(offendersOf('run_as_builder npm ci &>log --prefix ./npm').length).toBe(0);
    });
  });

  /**
   * Finds every `node -e '...'` multi-line single-quoted JS literal in the
   * real script and returns each one's [opener, closer] 1-based line pair —
   * the opener is the line ENDING in `node -e '` (the string starts right
   * there), the closer is the next line whose only leading content is the
   * matching bare `'` that ends it. Scanning this instead of enumerating it
   * (round-3 follow-up, coordinator-directed): a hardcoded line-number list
   * goes stale the moment ANY earlier line in the script shifts for an
   * unrelated reason (exactly what happened here once a sibling PR added
   * lines above these literals) — deriving both the openers and the
   * "still inside the literal" insertion range from the actual text keeps
   * this guard correct regardless of where in the file the literals sit.
   */
  function findNodeELiteralRanges(lines: string[]): { opener: number; closer: number }[] {
    const ranges: { opener: number; closer: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/node -e '$/.test(lines[i])) continue;
      const opener = i + 1;
      let closer = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*'/.test(lines[j])) {
          closer = j + 1;
          break;
        }
      }
      if (closer === -1) {
        throw new Error(`node -e '...' literal opened at line ${opener} was never closed`);
      }
      ranges.push({ opener, closer });
    }
    return ranges;
  }

  /**
   * Acceptance proof against the REAL script. Both the invocation lines and
   * the `node -e` literal ranges below are DERIVED from the current script
   * text (scanning), not enumerated — a hardcoded list is exactly the kind
   * of guard `workflow.md` warns against ("prefer scanning to enumerating"):
   * it silently goes stale the moment an unrelated, earlier edit shifts
   * these lines, which is what happened here. What still gets a hard
   * assertion is the property that actually matters: every real invocation
   * IS guarded, and un-guarding any one of them is caught at its own line.
   */
  describe('acceptance: the real script', () => {
    it('every real npm ci/install invocation the scanner finds is guarded, and the scan is not vacuous', () => {
      const source = readFileSync(SCRIPT_PATH, 'utf8');
      const lines = source.split('\n');
      const realInvocationLines = packageManagerMentionLines(source).map((l) => l.line);
      expect(realInvocationLines.length).toBeGreaterThan(0);
      for (const n of realInvocationLines) {
        expect(lines[n - 1]).toMatch(/run_as_builder (env \S+ )?npm (ci|install)\b/);
      }
      expect(offendersOf(source)).toEqual([]);
    });

    it('removing run_as_builder from any real invocation line is detected at that line', () => {
      const source = readFileSync(SCRIPT_PATH, 'utf8');
      const realInvocationLines = packageManagerMentionLines(source).map((l) => l.line);
      expect(realInvocationLines.length).toBeGreaterThan(0);
      for (const n of realInvocationLines) {
        const lines = source.split('\n');
        expect(lines[n - 1].split('run_as_builder ').length - 1).toBe(1);
        lines[n - 1] = lines[n - 1].replace('run_as_builder ', '');
        expect(offendersOf(lines.join('\n')).map((o) => o.line)).toEqual([n]);
      }
    });

    it('a bare `npm ci` line inserted at EVERY line position of the real script is detected', () => {
      const source = readFileSync(SCRIPT_PATH, 'utf8');
      const lines = source.split('\n');
      const literalRanges = findNodeELiteralRanges(lines);
      // Sanity on the scan itself: the script is known to carry at least
      // one multi-line `node -e '...'` literal (this whole test exists
      // because a shell must not treat text inside one as its own
      // statement) — a scan that finds none would make the rest of this
      // test vacuously pass.
      expect(literalRanges.length).toBeGreaterThan(0);
      // Inserting a new line lands "inside" a literal for every position
      // from just after its opener through (and including) its closer —
      // pushing the closer down still leaves the quote open at the
      // insertion point; pushing anything AFTER the closer down does not.
      const insideNodeELiteral = literalRanges.flatMap(({ opener, closer }) => {
        const positions: number[] = [];
        for (let p = opener + 1; p <= closer; p++) positions.push(p);
        return positions;
      });
      const undetected: number[] = [];
      const notOwnStatement: number[] = [];
      for (let pos = 0; pos <= lines.length; pos++) {
        const inserted = pos + 1;
        const mutated = [...lines.slice(0, pos), 'npm ci --no-audit', ...lines.slice(pos)];
        const offenders = offendersOf(mutated.join('\n'));
        if (!offenders.some((o) => o.text.includes('npm ci --no-audit'))) undetected.push(inserted);
        if (!offenders.some((o) => o.line === inserted && o.text === 'npm ci --no-audit')) {
          notOwnStatement.push(inserted);
        }
      }
      expect(lines.length).toBeGreaterThan(500);
      // Flagged at every position (inside a literal, the enclosing
      // statement is still an unguarded mention — conservative)…
      expect(undetected).toEqual([]);
      // …and as its OWN statement, at its own line, everywhere a shell
      // would actually run it.
      expect(notOwnStatement).toEqual(insideNodeELiteral);
    });
  });
});
