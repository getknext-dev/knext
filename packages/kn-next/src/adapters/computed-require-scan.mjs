/**
 * Computed require/import call sites — the blind spot of the compiled
 * standalone executable's disk-closure scan.
 *
 * standalone-compile.mjs keeps every module that disk-loaded code can reach
 * through a LITERAL specifier out of the bundle, so the bundle and the disk
 * chunks share one instance of it. A COMPUTED specifier (`require(pagePath)`,
 * `import(pathToFileURL(p).href)`) cannot be followed statically: at runtime it
 * resolves from disk, and if it ever loads a module the executable also
 * bundled, the process holds two instances of it. Such sites cannot be closed
 * by scanning, so they are inventoried — reported by the compile and pinned by
 * a reviewed test — and a new one is a review, not a surprise.
 *
 * Pure except for `literalRequireClosure`, which reads files.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { isAbsolute, relative } from 'node:path';

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PREFIX = new Set([...'(,=:[!&|?{};+-*%<>~^']);
/** Keywords after which a `/` starts a regex literal (`return /x/.test(s)`). */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'void', 'in', 'of', 'throw', 'yield', 'await', 'else',
  'delete', 'instanceof', 'new', 'do',
]);

/** Whether a `/` at `i` starts a regex literal, given the code before it. */
function slashStartsRegex(src, i, lastSignificant) {
  if (lastSignificant === '' || REGEX_PREFIX.has(lastSignificant)) return true;
  if (!/[\w$]/.test(lastSignificant)) return false;
  let end = i - 1;
  while (end >= 0 && /\s/.test(src[end])) end--;
  let start = end;
  while (start >= 0 && /[\w$]/.test(src[start])) start--;
  // `x.return / 2` is a property, not the keyword.
  let before = start;
  while (before >= 0 && /\s/.test(src[before])) before--;
  if (src[before] === '.') return false;
  return REGEX_KEYWORDS.has(src.slice(start + 1, end + 1));
}

/**
 * `src` with the contents of comments, string literals, template-literal TEXT
 * and regex literals blanked to spaces (delimiters kept, length unchanged), so
 * a scan over the result sees only code. Code inside a template's `${…}` is
 * code and stays visible; templates nest to any depth.
 */
export function maskCommentsAndStrings(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Mode stack: { t: 'code', depth } for code (depth counts `{` opened inside a
  // template expression), { t: 'tpl' } for template text.
  const stack = [{ t: 'code', depth: 0 }];
  let lastSignificant = '';
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const n = src[i + 1];
    if (top.t === 'tpl') {
      if (c === '\\') {
        blank(i, i + 2);
        i += 2;
      } else if (c === '`') {
        stack.pop();
        lastSignificant = '`';
        i++;
      } else if (c === '$' && n === '{') {
        stack.push({ t: 'code', depth: 0 });
        lastSignificant = '{';
        i += 2;
      } else {
        blank(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < src.length && src[k] !== c && src[k] !== '\n') {
        if (src[k] === '\\') k++;
        k++;
      }
      blank(i + 1, Math.min(k, src.length));
      i = k + 1;
      lastSignificant = c;
      continue;
    }
    if (c === '`') {
      stack.push({ t: 'tpl' });
      i++;
      continue;
    }
    if (c === '/' && slashStartsRegex(src, i, lastSignificant)) {
      let k = i + 1;
      let inClass = false;
      while (k < src.length && src[k] !== '\n') {
        if (src[k] === '\\') k++;
        else if (src[k] === '[') inClass = true;
        else if (src[k] === ']') inClass = false;
        else if (src[k] === '/' && !inClass) break;
        k++;
      }
      blank(i + 1, Math.min(k, src.length));
      i = k + 1;
      lastSignificant = '/';
      continue;
    }
    if (c === '{') top.depth++;
    else if (c === '}') {
      if (top.depth === 0 && stack.length > 1) {
        stack.pop(); // back into the enclosing template's text
        i++;
        continue;
      }
      top.depth--;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out.join('');
}

const CALL = /(?<![\w$.])(require|import|__non_webpack_require__)\s*\(/g;
/** A sole string/template literal argument: quote, (blanked) body, same quote, `)`. */
const LITERAL_ARG = /^\s*(["'`])[^"'`]*\1\s*\)/;

/**
 * `require(…) {` / `function require(…)` — a method or function NAMED
 * require/import, not a call. `masked` has comments and strings blanked, so the
 * parenthesis match below cannot be fooled by a paren inside a string.
 */
function isDefinition(masked, nameAt, argStart) {
  if (/\bfunction\s*\*?\s*$/.test(masked.slice(Math.max(0, nameAt - 20), nameAt))) return true;
  let depth = 1;
  let k = argStart;
  while (k < masked.length && depth > 0) {
    if (masked[k] === '(') depth++;
    else if (masked[k] === ')') depth--;
    k++;
  }
  while (k < masked.length && /\s/.test(masked[k])) k++;
  return masked[k] === '{';
}

/**
 * The computed require/import call sites in `src`: each call whose argument is
 * anything but a single literal (a template literal with `${…}` is computed).
 * @returns {{ index: number, callee: string }[]}
 */
export function computedRequireSites(src) {
  const masked = maskCommentsAndStrings(src);
  const sites = [];
  for (const m of masked.matchAll(CALL)) {
    const argStart = m.index + m[0].length;
    if (isDefinition(masked, m.index, argStart)) continue;
    const lit = LITERAL_ARG.exec(masked.slice(argStart));
    if (lit) {
      const body = src.slice(argStart, argStart + lit[0].length);
      if (!(lit[1] === '`' && body.includes('${'))) continue;
    }
    sites.push({ index: m.index, callee: m[1] });
  }
  return sites;
}

const LITERAL_SPECIFIER =
  /(?<![\w$.])(?:require|import)\(\s*["'`]([^"'`$]+)["'`]\s*\)|\bfrom\s*["']([^"']+)["']/g;

/**
 * Every file reachable from `roots` through literal specifiers, staying inside
 * `within` (realpaths). Node-style resolution, as the uncompiled server uses.
 * @param {string[]} roots
 * @param {string} within
 * @returns {Set<string>}
 */
export function literalRequireClosure(roots, within) {
  const inside = realpathSync(within);
  const seen = new Set();
  const queue = roots.map((r) => realpathSync(r));
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const req = createRequire(file);
    for (const m of src.matchAll(LITERAL_SPECIFIER)) {
      const spec = m[1] ?? m[2];
      if (!spec || isBuiltin(spec) || spec.startsWith('node:') || spec.startsWith('bun:')) continue;
      let real;
      try {
        real = realpathSync(req.resolve(spec));
      } catch {
        continue;
      }
      if (!seen.has(real) && !relative(inside, real).startsWith('..')) queue.push(real);
    }
  }
  return seen;
}

/**
 * `{ <path relative to baseDir>: <computed site count> }` for the files in
 * `files` that have any, sorted by path.
 * @param {Iterable<string>} files
 * @param {string} baseDir
 * @returns {Record<string, number>}
 */
export function computedRequireInventory(files, baseDir) {
  const base = realpathSync(baseDir);
  const rows = [];
  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const n = computedRequireSites(src).length;
    if (n > 0) rows.push([relative(base, file), n]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(rows);
}

/**
 * Where the compiled executable takes a resolved module from, judged by its
 * REAL path: `external` (outside the standalone tree — left as a runtime
 * require), `disk` (in the disk closure — shared with disk-loaded chunks), or
 * `bundle` (compiled into the executable).
 * @param {string} path
 * @param {{ root: string, diskClosure: Set<string> }} ctx
 * @returns {{ real: string, where: 'external' | 'disk' | 'bundle' }}
 */
export function moduleDisposition(path, { root, diskClosure }) {
  const real = realpathSync(path);
  const rel = relative(realpathSync(root), real);
  if (rel.startsWith('..') || isAbsolute(rel)) return { real, where: 'external' };
  return { real, where: diskClosure.has(real) ? 'disk' : 'bundle' };
}
