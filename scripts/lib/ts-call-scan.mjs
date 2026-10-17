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
  const p = { s: src, b: blankNonCode(src), consts: new Map() };
  p.consts = stringConsts(p);
  return p;
}

/**
 * `const|let|var NAME = '<literal>'` bindings, so a program kept in a constant
 * (`const KN = "/usr/local/bin/kn"`) is read as the string it is. A name bound
 * twice to different values is dropped: shadowing makes it ambiguous. A `let` or
 * `var` that is assigned again anywhere is dropped too, because its value at the
 * use site is not the literal. An unreadable name fails the guards rather than
 * passing them.
 */
function stringConsts(p) {
  const { s, b } = p;
  const found = new Map();
  const mutable = new Set();
  const re = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;(){}]+)?=\s*(?=['"`])/g;
  for (let m = re.exec(b); m; m = re.exec(b)) {
    const at = m.index + m[0].length;
    const end = readLiteral(b, at);
    if (b.slice(at, end).includes('${')) continue;
    let k = end;
    while (k < b.length && /[ \t]/.test(b[k])) k++;
    if (k < b.length && !/[;\n,)}]/.test(b[k])) continue; // part of a larger expression
    const value = s.slice(at + 1, end - 1);
    if (m[1] !== 'const') mutable.add(m[2]);
    const prior = found.get(m[2]);
    found.set(m[2], prior === undefined || prior === value ? value : null);
  }
  // A let/var assigned again (`NAME = ...`, `NAME += ...`) is not its literal.
  for (const name of mutable) {
    const assign = new RegExp(
      `(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*(?:\\*\\*|<<|>>>?|\\?\\?|&&|\\|\\||[-+*/%&|^])?=(?!=)`,
      'g',
    );
    if ((b.match(assign) ?? []).length > 1) found.set(name, null);
  }
  for (const [k, v] of found) if (v === null) found.delete(k);
  return found;
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
  if (/^[A-Za-z_$][\w$]*$/.test(b.slice(a, e)) && p.consts?.has(b.slice(a, e))) {
    return { type: 'string', value: p.consts.get(b.slice(a, e)), resolved: true, ...base };
  }
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

/**
 * Keywords after which a `[` opens an ARRAY LITERAL, not an index access:
 * `return ["kubectl", ...]` is a literal, `argv[0]` is not. Missing this made a
 * scan blind to every array returned from a function (measured: the preflight's
 * `dryRunApplyArgv` was invisible until a mutation of the scan survived).
 */
const LITERAL_AFTER = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'void',
  'delete',
  'new',
  'else',
  'yield',
  'await',
  'throw',
  'default',
  'do',
]);

/**
 * Whether the `[` at `i` is an index access (`x[0]`, `f()[0]`) rather than an
 * array literal. Looks back over whitespace on the blanked text.
 */
export function isIndexAccess(b, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(b[k])) k--;
  if (k < 0) return false;
  if (b[k] === ')' || b[k] === ']') return true;
  if (!/[\w$]/.test(b[k])) return false;
  let s = k;
  while (s >= 0 && /[\w$]/.test(b[s])) s--;
  return !LITERAL_AFTER.has(b.slice(s + 1, k + 1));
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

/** Programs that run another program given as their arguments. */
export const WRAPPER_PROGRAMS = new Set([
  'env',
  'sudo',
  'nohup',
  'time',
  'command',
  'exec',
  'xargs',
  'npx',
  'bunx',
  'nice',
  'timeout',
]);

/** Program name: no directory (either separator), no `.exe`. */
export const progName = (v) =>
  v
    .trim()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '');

/**
 * Every argv a wrapper might run, for an argv whose head is a wrapper program
 * (`env`, `sudo`, `xargs`, ...); `[]` for any other argv. The first is the plain
 * reading: the wrapper(s) stripped, with their flags and `VAR=` assignments
 * skipped. The rest start at each later literal element, because a flag that
 * takes a value (`sudo -u root kubectl ...`) cannot be told from the program
 * without knowing the wrapper's flags, and guessing wrong must not hide one.
 * Shared by the spawn scan and the cluster-write scan so they cannot disagree.
 */
export function wrappedArgvs(elems) {
  const isWrapper = (e) => e?.type === 'string' && WRAPPER_PROGRAMS.has(progName(e.value));
  if (!isWrapper(elems[0])) return [];
  let cur = elems;
  for (let depth = 0; depth < 8 && isWrapper(cur[0]); depth++) {
    let k = 1;
    while (
      k < cur.length &&
      cur[k].type === 'string' &&
      (cur[k].value.startsWith('-') || /^[A-Za-z_]\w*=/.test(cur[k].value))
    )
      k++;
    cur = cur.slice(k);
  }
  const out = [cur];
  for (let i = 1; i < elems.length; i++) {
    const e = elems[i];
    if (e.type === 'string' && !e.value.startsWith('-') && !/^[A-Za-z_]\w*=/.test(e.value)) {
      out.push(elems.slice(i));
    }
  }
  return out;
}
