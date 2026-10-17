/**
 * A small, honest reader for the call-site and literal shapes the CLI cluster
 * -write guards (`cli-spawn-scan.mjs`, `cli-cluster-write-scan.mjs`) need.
 *
 * It is NOT a TypeScript parser and does not pretend to be. It works on the
 * repo's single non-code blanker (`blankNonCode`): comments and the CONTENTS of
 * string/template literals become spaces while every offset is preserved, so
 * brackets and commas can be matched on the blanked text and the literal values
 * sliced back out of the original. Anything it cannot classify comes back as
 * `{ type: 'dynamic' }`, and the guards treat dynamic as FAIL, never as pass -
 * the point is that an unreadable construct cannot hide a violation.
 */

import { blankNonCode } from './blank-non-code.mjs';

/** @typedef {{ s: string, b: string }} Prepared */

/**
 * @param {string} src
 * @returns {Prepared}
 */
export function prepare(src) {
  return { s: src, b: blankNonCode(src) };
}

/** 1-based line of offset `idx`. */
export function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/**
 * Exclusive end of the string/template literal that starts at `i` in the
 * blanked text. A template's `${...}` holes are code and may contain literals of
 * their own, so those are matched recursively.
 */
export function readLiteral(b, i) {
  const q = b[i];
  if (q === "'" || q === '"') {
    const j = b.indexOf(q, i + 1);
    return j === -1 ? b.length : j + 1;
  }
  // template
  let k = i + 1;
  while (k < b.length) {
    const c = b[k];
    if (c === '`') return k + 1;
    if (c === '$' && b[k + 1] === '{') {
      k = matchClose(b, k + 1) + 1;
      continue;
    }
    k++;
  }
  return b.length;
}

const OPEN = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket that closes the one at `i`, skipping literals. */
export function matchClose(b, i) {
  const stack = [OPEN[b[i]]];
  let k = i + 1;
  while (k < b.length && stack.length > 0) {
    const c = b[k];
    if (c === "'" || c === '"' || c === '`') {
      k = readLiteral(b, k);
      continue;
    }
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return k;
    }
    k++;
  }
  return b.length;
}

/** Split `b[from, to)` at depth-0 commas into `[start, end)` ranges. */
export function splitTopLevel(b, from, to) {
  const out = [];
  let depth = 0;
  let start = from;
  let k = from;
  while (k < to) {
    const c = b[k];
    if (c === "'" || c === '"' || c === '`') {
      k = readLiteral(b, k);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push([start, k]);
      start = k + 1;
    }
    k++;
  }
  out.push([start, to]);
  return out.filter(([a, e]) => b.slice(a, e).trim() !== '');
}

const normalise = (t) => t.replace(/\s+/g, ' ').trim();

/**
 * The code in `[from, to)` with comments removed and literal contents kept:
 * outside literals the blanked text is used (comments are spaces there), inside
 * them the original. Whitespace collapsed.
 */
function codeText(p, from, to) {
  const { s, b } = p;
  let out = '';
  let i = from;
  while (i < to) {
    const c = b[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = Math.min(readLiteral(b, i), to);
      out += s.slice(i, end);
      i = end;
    } else {
      out += b[i];
      i++;
    }
  }
  return normalise(out);
}

/**
 * What an expression range is, as far as this reader can tell:
 *   - `{ type: 'string', value }`      a literal with no `${}` hole
 *   - `{ type: 'template', text }`     a template literal WITH a hole
 *   - `{ type: 'array', elems }`       an array literal of classified elements
 *   - `{ type: 'spread' }`             `...x`
 *   - `{ type: 'call', name, args }`   `name(a, b)` with nothing after it
 *   - `{ type: 'dynamic', text }`      anything else
 * Every result carries `start`/`end` (offsets into the source) and `text`.
 *
 * @param {Prepared} p
 * @param {[number, number]} range
 */
export function classify(p, [from, to]) {
  const { s, b } = p;
  let a = from;
  let e = to;
  while (a < e && /\s/.test(b[a])) a++;
  while (e > a && /\s/.test(b[e - 1])) e--;
  const base = { start: a, end: e, text: codeText(p, a, e) };
  if (a >= e) return { type: 'dynamic', ...base };
  const c = b[a];

  if (c === "'" || c === '"') {
    if (readLiteral(b, a) === e) return { type: 'string', value: s.slice(a + 1, e - 1), ...base };
    return { type: 'dynamic', ...base };
  }
  if (c === '`') {
    if (readLiteral(b, a) !== e) return { type: 'dynamic', ...base };
    if (b.slice(a, e).includes('${')) return { type: 'template', ...base };
    return { type: 'string', value: s.slice(a + 1, e - 1), ...base };
  }
  if (c === '[') {
    const close = matchClose(b, a);
    if (close + 1 === e) {
      const elems = splitTopLevel(b, a + 1, close).map((r) => classify(p, r));
      return { type: 'array', elems, ...base };
    }
    return { type: 'dynamic', ...base };
  }
  if (b.startsWith('...', a)) return { type: 'spread', ...base };
  const id = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/.exec(b.slice(a, e));
  if (id) {
    const afterId = a + id[0].length;
    let k = afterId;
    while (k < e && /\s/.test(b[k])) k++;
    if (b[k] === '(') {
      const close = matchClose(b, k);
      if (close + 1 === e) {
        const args = splitTopLevel(b, k + 1, close).map((r) => classify(p, r));
        return { type: 'call', name: id[0].replace(/\s+/g, ''), args, ...base };
      }
    }
  }
  return { type: 'dynamic', ...base };
}

/** The classified top-level arguments of the call whose `(` is at `open`. */
export function callArgs(p, open) {
  const close = matchClose(p.b, open);
  return splitTopLevel(p.b, open + 1, close).map((r) => classify(p, r));
}

/**
 * Every string literal in the blanked text (including no-hole templates), with
 * the offset of its opening delimiter. A template WITH a hole contributes its
 * raw text (`hole: true`) and, separately, the literals inside its holes.
 */
export function stringLiterals(p) {
  const { s, b } = p;
  const out = [];
  const walk = (from, to) => {
    let i = from;
    while (i < to) {
      const c = b[i];
      if (c === "'" || c === '"') {
        const end = readLiteral(b, i);
        out.push({ value: s.slice(i + 1, end - 1), index: i });
        i = end;
      } else if (c === '`') {
        const end = readLiteral(b, i);
        if (!b.slice(i, end).includes('${')) {
          out.push({ value: s.slice(i + 1, end - 1), index: i });
        } else {
          // The raw text (holes included) so a phrase split by a hole is still
          // searchable; `hole: true` tells the caller it is not a plain value.
          out.push({ value: s.slice(i + 1, end - 1), index: i, hole: true });
          let k = i + 1;
          while (k < end - 1) {
            if (b[k] === '$' && b[k + 1] === '{') {
              const close = matchClose(b, k + 1);
              walk(k + 2, close);
              k = close + 1;
            } else {
              k++;
            }
          }
        }
        i = end;
      } else {
        i++;
      }
    }
  };
  walk(0, b.length);
  return out;
}
