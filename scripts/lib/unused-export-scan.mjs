/**
 * The unused-export scan for `packages/kn-next/src`.
 *
 * Why: an `export` nothing outside its own file imports is a leak of internals
 * (it reads as API, and it pins a symbol nothing else can verify is live). The
 * tree had accumulated ~two dozen of them plus one (`IMPORT_CONDITIONS`) with
 * no reference anywhere. This scan makes the next one fail CI.
 *
 * What it does, in three steps, none of which hand-lists a symbol:
 *
 *   1. ENUMERATE every `export` declared in a shipped source file under
 *      `packages/kn-next/src` (tests, fixtures, `.d.ts`/`.d.mts` declaration
 *      companions excluded).
 *   2. EXEMPT the public surface, GENERATED from `packages/kn-next/package.json`
 *      `exports` (+ `bin`): each target `./dist/<name>.<ext>` is mapped back to
 *      its source through the `tsup.config.ts` entry table. Those files' exports
 *      ARE the API, so zero in-repo importers is expected of them.
 *   3. COUNT, for every other export, the tracked files (source, tests, docs,
 *      scripts, workflows) other than the defining file and its declaration
 *      companion that mention the name as a whole word. Zero -> violation.
 *
 * Deliberate looseness, stated: the reference test is "the name appears as a
 * whole-word token in another tracked text file", the same method the issue used
 * to find these. A name that is also a common word elsewhere therefore hides a
 * real dead export (a false NEGATIVE). It can never produce a false POSITIVE
 * from string-keyed access (`mod['name']`), which an import-graph walk would.
 * Honest scope: this finds exports with no outside mention; it does not prove
 * an exported symbol is *used*, only that it is not dead-by-isolation.
 *
 * Scope, stated rather than implied:
 *   - VALUE exports only (function, const, let, var, class, enum, and
 *     `export { ... }` lists). `export type` / `export interface` are not
 *     scanned: exporting the option/result type of an exported function is the
 *     idiomatic way to let a caller name it, so "no importer" is weak evidence
 *     there. (Tracked as a separate follow-up.)
 *   - ES-module sources only (`.ts .tsx .mts .mjs .js`). CommonJS `.cjs` files
 *     assign `module.exports`, which a regex cannot enumerate; they are not
 *     scanned, not silently passed - they are outside this guard.
 *   - A declaration companion (`x.d.mts` beside `x.mjs`) must not declare a name
 *     its source does not export (`staleDeclarations`): un-exporting a symbol
 *     and leaving its declaration behind is a lie `tsc` cannot detect.
 *   - A destructuring export (`export const { a } = ...`) is reported as
 *     `unreadable` and FAILS, rather than passing unseen.
 *
 * Pure functions over text plus a tracked-file walker. The test is
 * `tests/unused-exports.test.ts`; the mutation proof is
 * `scripts/mutation-prove-unused-exports.mjs`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from './blank-non-code.mjs';
import { gitRun } from './guard-prover.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PACKAGE_DIR = 'packages/kn-next';
export const SCOPE_DIR = `${PACKAGE_DIR}/src`;

const SOURCE_EXT = /\.(?:ts|tsx|mts|mjs|js)$/;
const DECLARATION_EXT = /\.d\.(?:ts|mts|cts)$/;
const TEST_PATH =
  /(?:^|\/)(?:__tests__|__fixtures__|fixtures|testdata)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Binary / generated / lock files that carry no import statements worth reading. */
const SKIP_REFERENCE_FILE =
  /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|wasm|node|lock|lockb|svg)$|(?:^|\/)(?:bun\.lock|package-lock\.json)$/;
const MAX_REFERENCE_BYTES = 2_000_000;

/** @param {string} p repo-relative path @returns {boolean} */
export function isScopedSource(p) {
  return (
    p.startsWith(`${SCOPE_DIR}/`) &&
    SOURCE_EXT.test(p) &&
    !DECLARATION_EXT.test(p) &&
    !TEST_PATH.test(p)
  );
}

/** The declaration companion of a source file (`x.mjs` -> `x.d.mts`), if any. */
export function declarationCompanions(p) {
  const base = p.replace(SOURCE_EXT, '');
  return [`${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`];
}

/**
 * Every exported name declared in one source file.
 *
 * @param {string} src
 * @returns {{ names: Array<{ name: string, line: number }>, unreadable: Array<{ what: string, line: number }> }}
 */
export function exportedNames(src) {
  const b = blankNonCode(src);
  const names = [];
  const unreadable = [];
  const lineAt = (idx) => {
    let line = 1;
    for (let i = 0; i < idx; i++) if (b[i] === '\n') line++;
    return line;
  };

  const decl =
    /(?:^|[;}\n])\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(const\s+enum|function\s*\*?|class|const|let|var|enum|interface|type|namespace)\s+([A-Za-z_$][\w$]*)/g;
  for (let m = decl.exec(b); m; m = decl.exec(b)) {
    if (m[1] === 'interface' || m[1] === 'type') continue; // type-only: out of scope, see module doc
    names.push({ name: m[2], line: lineAt(m.index + m[0].indexOf('export')) });
  }

  // `export const { a, b } = ...` / `export const [a] = ...`: cannot be named by a regex.
  const destructured = /(?:^|[;}\n])\s*export\s+(?:const|let|var)\s*[{[]/g;
  for (let m = destructured.exec(b); m; m = destructured.exec(b)) {
    unreadable.push({
      what: 'a destructuring export',
      line: lineAt(m.index + m[0].indexOf('export')),
    });
  }

  // `export { a, b as c }` and `export { a } from './x'`. Type-only members
  // (`export type { ... }`, `export { type d }`) are out of scope like `export type`.
  const list = /(?:^|[;}\n])\s*export\s+(type\s+)?\{([^}]*)\}/g;
  for (let m = list.exec(b); m; m = list.exec(b)) {
    if (m[1]) continue;
    const line = lineAt(m.index + m[0].indexOf('export'));
    for (const part of m[2].split(',')) {
      const t = part.trim();
      if (!t || /^type\s/.test(t)) continue;
      const as = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const nm = as ? as[1] : t.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
      if (nm && nm !== 'default') names.push({ name: nm, line });
    }
  }

  // `export * as ns from`
  const star = /(?:^|[;}\n])\s*export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g;
  for (let m = star.exec(b); m; m = star.exec(b)) {
    names.push({ name: m[1], line: lineAt(m.index + m[0].indexOf('export')) });
  }

  return { names, unreadable };
}

/**
 * The source files whose exports ARE the published API, GENERATED from the
 * package manifest and the tsup entry table.
 *
 * @param {{ exports?: Record<string, unknown>, bin?: Record<string, string> | string }} manifest
 * @param {string} tsupSource text of `tsup.config.ts`
 * @param {(p: string) => boolean} exists whether a repo-relative path is tracked
 * @returns {{ files: Set<string>, unresolved: string[] }}
 */
export function publicSourceFiles(manifest, tsupSource, exists) {
  const entries = new Map(); // dist name without extension -> src path
  const entryRe = /['"]?([\w/.-]+)['"]?\s*:\s*['"](src\/[^'"]+)['"]/g;
  for (let m = entryRe.exec(tsupSource); m; m = entryRe.exec(tsupSource)) {
    entries.set(m[1], m[2]);
  }

  const targets = new Set();
  const collect = (v) => {
    if (typeof v === 'string') targets.add(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x);
  };
  collect(manifest.exports ?? {});
  collect(manifest.bin ?? {});

  const files = new Set();
  const unresolved = [];
  for (const t of targets) {
    const m = t.match(/^\.\/dist\/(.+?)(\.d\.ts|\.d\.mts|\.js|\.cjs|\.mjs)$/);
    if (!m) {
      unresolved.push(t);
      continue;
    }
    const name = m[1];
    const viaTsup = entries.get(name);
    if (viaTsup) {
      files.add(`${PACKAGE_DIR}/${viaTsup}`);
      continue;
    }
    // Not built by an entry (copied as-is, e.g. a `.cjs` preload): same path under src.
    const guess = ['.ts', '.mts', '.mjs', '.cjs', '.js']
      .map((e) => `${SCOPE_DIR}/${name}${e}`)
      .find(exists);
    if (guess) files.add(guess);
    else unresolved.push(t);
  }
  return { files, unresolved };
}

/** Whole-word tokens of a text, as a Set. */
function tokens(text) {
  const out = new Set();
  const re = /[A-Za-z_$][\w$]*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.add(m[0]);
  return out;
}

/**
 * Scan an in-memory set of files. Pure: `files` is `Map<repoRelativePath, text>`
 * for every tracked text file.
 *
 * @param {Map<string, string>} files
 * @param {Set<string>} publicFiles source files exempt as the public surface
 * @returns {{
 *   violations: Array<{ file: string, name: string, line: number }>,
 *   unreadable: Array<{ file: string, what: string, line: number }>,
 *   staleDeclarations: Array<{ file: string, name: string, line: number }>,
 *   scoped: number, exportsSeen: number, exempt: number,
 * }}
 */
export function scanUnusedExports(files, publicFiles) {
  const tokenIndex = new Map(); // path -> Set<token>
  for (const [p, text] of files) tokenIndex.set(p, tokens(text));

  const violations = [];
  const unreadable = [];
  const staleDeclarations = [];
  let scoped = 0;
  let exportsSeen = 0;
  let exempt = 0;
  for (const [file, text] of files) {
    if (!isScopedSource(file)) continue;
    scoped++;
    const { names, unreadable: bad } = exportedNames(text);
    // A declaration companion may only declare what the source exports; one that
    // declares more is a type-level lie `tsc` cannot see (it never opens the .mjs).
    const have = new Set(names.map((n) => n.name));
    for (const c of declarationCompanions(file)) {
      if (!files.has(c)) continue;
      for (const d of exportedNames(files.get(c)).names) {
        if (!have.has(d.name)) staleDeclarations.push({ file: c, name: d.name, line: d.line });
      }
    }
    if (publicFiles.has(file)) {
      exempt += names.length;
      continue;
    }
    for (const u of bad) unreadable.push({ file, ...u });
    const own = new Set([file, ...declarationCompanions(file)]);
    for (const { name, line } of names) {
      exportsSeen++;
      let referenced = false;
      for (const [p, set] of tokenIndex) {
        if (own.has(p)) continue;
        if (set.has(name)) {
          referenced = true;
          break;
        }
      }
      if (!referenced) violations.push({ file, name, line });
    }
  }
  return { violations, unreadable, staleDeclarations, scoped, exportsSeen, exempt };
}

/** Tracked files of the repo as `Map<path, text>` (text files only). */
export function readTrackedFiles(root = REPO_ROOT) {
  const list = gitRun(root, ['ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
  const out = new Map();
  for (const p of list) {
    if (SKIP_REFERENCE_FILE.test(p)) continue;
    let buf;
    try {
      buf = readFileSync(resolve(root, p));
    } catch {
      continue; // deleted in the working tree
    }
    if (buf.length > MAX_REFERENCE_BYTES || buf.includes(0)) continue;
    out.set(p, buf.toString('utf8'));
  }
  return out;
}

/** Scan the real tree. */
export function scanTree(root = REPO_ROOT) {
  const files = readTrackedFiles(root);
  const manifest = JSON.parse(readFileSync(resolve(root, PACKAGE_DIR, 'package.json'), 'utf8'));
  const tsup = readFileSync(resolve(root, PACKAGE_DIR, 'tsup.config.ts'), 'utf8');
  const pub = publicSourceFiles(manifest, tsup, (p) => files.has(p));
  return {
    ...scanUnusedExports(files, pub.files),
    publicFiles: pub.files,
    unresolved: pub.unresolved,
  };
}
