/**
 * Shared shell lexer for the musl-rebuild guard tests (extracted from
 * musl-rebuild-npm-run-as-builder.test.ts so musl-rebuild-npm-ci-build-from-source.test.ts
 * reuses the SAME lexer instead of carrying a second, weaker one — #1444).
 */

export type Statement = { text: string; line: number };

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
export function splitSourceIntoStatements(source: string, firstLine = 1): Statement[] {
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
