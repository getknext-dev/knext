/**
 * The one comment/string lexer for the repo's source-text guards.
 *
 * Several guards decide things by reading source text: they strip comments, then
 * look at what is left. Each used to carry its own lexer, and the lexers disagreed
 * (does a template body survive? an escaped quote? how wide is a removed comment?),
 * so a guard that looked for a token inside string content depended on which lexer
 * it happened to copy. This is the single implementation; the golden vectors in
 * `__tests__/js-source-lexer.test.ts` pin its behaviour.
 *
 * Lives inside `packages/kn-next` (which is published and must not import from
 * `scripts/`); the script-side guards import it from here.
 *
 * Dependency-free, pure, and length-preserving: every returned string has the same
 * length as its input and the same newline offsets, so positions line up.
 */

/**
 * Blank the COMMENTS of a JS/TS source, token-aware, keeping every other character
 * at its offset (newlines survive, so positions line up).
 *
 * Policy options (both default `false` = "keep"):
 *   - `blankStrings`: string and template-literal TEXT is blanked too (delimiters
 *     kept), so a call named inside a message (`'spawnSync(x) failed'`) is not read
 *     as a call. Code inside a template's `${…}` is code and stays visible.
 *   - `blankRegex`: regex-literal BODIES are blanked too (delimiters and flags kept).
 *
 * Why token-aware: blanking whole lines that START with a comment hides a real
 * import in `/* c *\/ import './x.mjs'`. Strings are scanned as strings (a `'/*'`
 * opens nothing), and a regex literal is recognised where an expression may start,
 * so `/^https?:\/\//` does not read as a line comment and swallow the code after
 * it. The bias is deliberate: when the scanner is unsure, it treats text as CODE;
 * scanning more is the fail-closed direction.
 *
 * @param {string} source
 * @param {{ blankStrings?: boolean, blankRegex?: boolean }} [options]
 * @returns {string}
 */
export function stripComments(
  source,
  { blankStrings = false, blankRegex = false } = {},
) {
  const n = source.length;
  const out = [];
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const keep = (s) => (blankStrings ? blank(s) : s);
  const keepRegex = (s) => (blankRegex ? blank(s) : s);
  let i = 0;
  let last = ''; // the last significant code token's final char, or a keyword
  // Each frame is a template literal awaiting its `${…}` close: the brace depth at entry.
  const templates = [];
  let depth = 0;

  const scanString = (q) => {
    let j = i + 1;
    while (j < n && source[j] !== q && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    // Terminated: consume the closing quote. Unterminated (newline or EOF): stop AT
    // the newline so it survives, which keeps line structure for the code after it.
    const closed = j < n && source[j] === q;
    out.push(q, keep(source.slice(i + 1, Math.min(j, n))), closed ? q : '');
    i = closed ? j + 1 : Math.min(j, n);
    last = q;
  };
  // Scan template text from i (just past a backtick or a `}` that closes `${`).
  const scanTemplateText = () => {
    let j = i;
    while (j < n && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) {
      j += source[j] === '\\' ? 2 : 1;
    }
    out.push(keep(source.slice(i, Math.min(j, n))));
    if (j >= n) {
      i = n;
    } else if (source[j] === '`') {
      out.push('`');
      i = j + 1;
      last = '`';
    } else {
      out.push('${');
      templates.push(depth);
      depth += 1;
      i = j + 2;
      last = '{';
    }
  };
  const regexMayStart = () => {
    if (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last)) return true;
    return /^(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new|instanceof)$/.test(
      last,
    );
  };
  const scanRegex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < n && source[j] !== '\n') {
      const c = source[j];
      if (c === '/' && !inClass) break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      j += c === '\\' ? 2 : 1;
    }
    if (j >= n || source[j] !== '/') return false; // not a regex: treat `/` as code
    const bodyEnd = j;
    j += 1;
    while (j < n && /[a-z]/i.test(source[j])) j += 1;
    out.push('/', keepRegex(source.slice(i + 1, bodyEnd)), source.slice(bodyEnd, j));
    i = j;
    last = ')'; // a regex is a value: a following `/` divides
    return true;
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      let j = source.indexOf('\n', i);
      if (j === -1) j = n;
      out.push(blank(source.slice(i, j)));
      i = j;
    } else if (c === '/' && d === '*') {
      const k = source.indexOf('*/', i + 2);
      const j = k === -1 ? n : k + 2;
      out.push(blank(source.slice(i, j)));
      i = j;
    } else if (c === '"' || c === "'") {
      scanString(c);
    } else if (c === '`') {
      out.push('`');
      i += 1;
      scanTemplateText();
    } else if (c === '/' && regexMayStart() && scanRegex()) {
      // consumed
    } else if (c === '}' && templates.length > 0 && templates[templates.length - 1] === depth - 1) {
      templates.pop();
      depth -= 1;
      out.push('}');
      i += 1;
      scanTemplateText();
    } else {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
        last = source.slice(i, j);
        out.push(last);
        i = j;
        continue;
      }
      if ((c === '+' || c === '-') && d === c) {
        // `++`/`--`: postfix after a value ends a value (so `/` divides); prefix
        // stays an operator (a regex may follow).
        const postfix = !regexMayStart();
        out.push(c, d);
        i += 2;
        last = postfix ? ')' : c;
        continue;
      }
      if (!/\s/.test(c)) last = c;
      out.push(c);
      i += 1;
    }
  }
  return out.join('');
}
