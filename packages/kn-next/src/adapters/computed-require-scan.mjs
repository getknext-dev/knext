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
import { stripComments } from './js-source-lexer.mjs';

/**
 * `src` with the contents of comments, string literals, template-literal TEXT
 * and regex literals blanked to spaces (delimiters kept, length unchanged), so
 * a scan over the result sees only code. Code inside a template's `${…}` is
 * code and stays visible; templates nest to any depth. The lexer is the shared
 * one (`./js-source-lexer.mjs`) in its blank-strings + blank-regex mode.
 */
function maskCommentsAndStrings(src) {
  return stripComments(src, { blankStrings: true, blankRegex: true });
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
